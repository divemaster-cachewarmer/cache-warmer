import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, mock, test } from "node:test";
import vm from "node:vm";
import axios from "axios";
import { fetchUrlsForDomain } from "../sitemap.js";

// Never use the real Sheets endpoint or proxy while importing the application.
process.env.APPS_SCRIPT_URL = "https://sheets.test/exec";
process.env.BRD_PROXY_ID = "";
process.env.APPS_SCRIPT_TIMEOUT_MS = "120000";
process.env.CLOUDFLARE_ZONE_ID = "test-zone";
process.env.CLOUDFLARE_API_TOKEN = "test-token";
const { AppsScriptLogger, SHEET_HEADERS, warmUrls } = await import("../index.js");

afterEach(() => mock.restoreAll());

const domain = "https://example.com";
const urlset = (...urls) => `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
  urls.map((url) => `<url><loc>${url}</loc></url>`).join("")
}</urlset>`;
const index = (...urls) => `<sitemapindex>${
  urls.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join("")
}</sitemapindex>`;

function fetchFixture(documents, calls = []) {
  return async (url) => {
    calls.push(url);
    if (!(url in documents)) throw new Error("HTTP 404");
    return documents[url];
  };
}

test("Next.js urlset returns page URLs directly and deduplicates them", async () => {
  const calls = [];
  const urls = await fetchUrlsForDomain(domain, fetchFixture({
    [`${domain}/sitemap.xml`]: urlset(`${domain}/`, `${domain}/about/`, `${domain}/`),
  }, calls));
  assert.deepEqual(urls, [`${domain}/`, `${domain}/about/`]);
  assert.deepEqual(calls, [`${domain}/sitemap.xml`]);
});

test("nested indexes support singleton entries and terminate cycles", async () => {
  const calls = [];
  const urls = await fetchUrlsForDomain(domain, fetchFixture({
    [`${domain}/sitemap.xml`]: index(`${domain}/nested.xml`, `${domain}/pages.xml`),
    [`${domain}/nested.xml`]: index(`${domain}/sitemap.xml`, `${domain}/pages.xml`),
    [`${domain}/pages.xml`]: urlset(`${domain}/about/`),
  }, calls));
  assert.deepEqual(urls, [`${domain}/about/`]);
  assert.equal(calls.length, 3);
});

test("namespace-prefixed XML is accepted", async () => {
  const urls = await fetchUrlsForDomain(domain, fetchFixture({
    [`${domain}/sitemap.xml`]: `<s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9"><s:url><s:loc>${domain}/</s:loc></s:url></s:urlset>`,
  }));
  assert.deepEqual(urls, [`${domain}/`]);
});

for (const [name, firstDocument] of [
  ["missing", undefined], ["malformed", "<urlset>"],
  ["empty", "<urlset/>"], ["HTML", "<html><body>Not a sitemap</body></html>"],
]) {
  test(`falls back to sitemap_index.xml when sitemap.xml is ${name}`, async () => {
    const errors = [];
    const documents = {
      [`${domain}/sitemap_index.xml`]: index(`${domain}/pages.xml`),
      [`${domain}/pages.xml`]: urlset(`${domain}/`),
    };
    if (firstDocument !== undefined) documents[`${domain}/sitemap.xml`] = firstDocument;
    const urls = await fetchUrlsForDomain(domain, fetchFixture(documents),
      (url, error) => errors.push({ url, error }));
    assert.deepEqual(urls, [`${domain}/`]);
    assert.equal(errors[0].url, `${domain}/sitemap.xml`);
  });
}

test("a failed child sitemap is reported while usable siblings are processed", async () => {
  const errors = [];
  const urls = await fetchUrlsForDomain(domain, fetchFixture({
    [`${domain}/sitemap.xml`]: index(`${domain}/missing.xml`, `${domain}/pages.xml`),
    [`${domain}/pages.xml`]: urlset(`${domain}/`),
  }), (url) => errors.push(url));
  assert.deepEqual(urls, [`${domain}/`]);
  assert.deepEqual(errors, [`${domain}/missing.xml`]);
});

test("all-empty or failing sitemaps reject instead of silently warming zero URLs", async () => {
  await assert.rejects(fetchUrlsForDomain(domain, fetchFixture({
    [`${domain}/sitemap.xml`]: "<urlset/>",
  })), /No page URLs found/);
});

test("a Vercel MISS purges only its URL and records each cache layer separately", async () => {
  mock.method(console, "log", () => {});
  const post = mock.method(axios, "post", async () => ({ data: { success: true } }));
  mock.method(axios, "get", async () => ({
    status: 200,
    headers: {
      "cf-cache-status": "HIT", "x-vercel-cache": "MISS", "x-nextjs-cache": "STALE",
      "x-litespeed-cache": "MISS", "cf-ray": "abc-HKG",
    },
  }));
  const logger = new AppsScriptLogger();
  await warmUrls([`${domain}/`], "id", logger, 1, 0);
  const row = Object.fromEntries(SHEET_HEADERS.map((header, i) => [header, logger.rows[0][i]]));
  assert.equal(row.cf_cache, "HIT");
  assert.equal(row.vercel_cache, "MISS");
  assert.equal(row.nextjs_cache, "STALE");
  assert.equal(row.cf_ray, "abc-HKG");
  assert.equal(row.error, 0);
  assert.equal(post.mock.callCount(), 1);
  const [endpoint, payload, config] = post.mock.calls[0].arguments;
  assert.equal(endpoint, "https://api.cloudflare.com/client/v4/zones/test-zone/purge_cache");
  assert.deepEqual(payload, { files: [`${domain}/`] });
  assert.equal(config.headers.Authorization, "Bearer test-token");
  assert.ok(config.timeout > 0);
  assert.match(row.message, /purge accepted/i);
});

for (const status of ["HIT", " hit ", "N/A", " n/a ", "", "   ", undefined]) {
  test(`Vercel ${JSON.stringify(status)} does not trigger a purge`, async () => {
    mock.method(console, "log", () => {});
    const post = mock.method(axios, "post", () => { throw new Error("Unexpected POST"); });
    mock.method(axios, "get", async () => ({ status: 200, headers: { "x-vercel-cache": status } }));
    const logger = new AppsScriptLogger();
    await warmUrls([`${domain}/`], "id", logger, 1, 0);
    assert.equal(post.mock.callCount(), 0);
    assert.equal(logger.rows.length, 1);
    assert.equal(logger.rows[0][SHEET_HEADERS.indexOf("error")], 0);
  });
}

for (const status of ["STALE", "BYPASS", " miss "]) {
  test(`Vercel ${JSON.stringify(status)} triggers one purge without re-fetching the page`, async () => {
    mock.method(console, "log", () => {});
    const post = mock.method(axios, "post", async () => ({ data: { success: true } }));
    const get = mock.method(axios, "get", async () => ({ status: 200, headers: { "x-vercel-cache": status } }));
    const logger = new AppsScriptLogger();
    await warmUrls([`${domain}/`], "id", logger, 1, 0);
    assert.equal(post.mock.callCount(), 1);
    assert.equal(get.mock.callCount(), 1);
    assert.equal(logger.rows[0][SHEET_HEADERS.indexOf("vercel_cache")], status.trim().toUpperCase());
  });
}

test("a rejected Cloudflare purge preserves HTTP success and reports its own error in Sheets", async () => {
  mock.method(console, "log", () => {});
  mock.method(console, "warn", () => {});
  mock.method(axios, "get", async () => ({ status: 200, headers: { "x-vercel-cache": "MISS" } }));
  mock.method(axios, "post", async () => ({ data: { success: false, errors: [{ code: 9109, message: "Unauthorized" }] } }));
  const logger = new AppsScriptLogger();
  await warmUrls([`${domain}/`], "id", logger, 1, 0);
  assert.equal(logger.rows.length, 1);
  assert.equal(logger.rows[0][SHEET_HEADERS.indexOf("status")], 200);
  assert.equal(logger.rows[0][SHEET_HEADERS.indexOf("error")], 1);
  assert.match(logger.rows[0][SHEET_HEADERS.indexOf("message")], /purge failed/i);
});

test("a Cloudflare timeout is recorded without duplicate purge requests", async () => {
  mock.method(console, "log", () => {});
  mock.method(console, "warn", () => {});
  mock.method(axios, "get", async () => ({ status: 200, headers: { "x-vercel-cache": "MISS" } }));
  const post = mock.method(axios, "post", async () => { throw new Error("timeout"); });
  const logger = new AppsScriptLogger();
  await warmUrls([`${domain}/`], "id", logger, 1, 0);
  assert.equal(post.mock.callCount(), 1);
  assert.equal(logger.rows.length, 1);
  assert.equal(logger.rows[0][SHEET_HEADERS.indexOf("error")], 1);
  assert.match(logger.rows[0][SHEET_HEADERS.indexOf("message")], /purge failed/i);
});

test("missing Cloudflare credentials reports a skipped purge without making a POST", async () => {
  mock.method(console, "log", () => {});
  mock.method(console, "warn", () => {});
  mock.method(axios, "get", async () => ({ status: 200, headers: { "x-vercel-cache": "MISS" } }));
  const post = mock.method(axios, "post", () => { throw new Error("Unexpected POST"); });
  const previous = process.env.CLOUDFLARE_API_TOKEN;
  try {
    process.env.CLOUDFLARE_API_TOKEN = "";
    const logger = new AppsScriptLogger();
    await warmUrls([`${domain}/`], "id", logger, 1, 0);
    assert.equal(post.mock.callCount(), 0);
    assert.equal(logger.rows[0][SHEET_HEADERS.indexOf("error")], 1);
    assert.match(logger.rows[0][SHEET_HEADERS.indexOf("message")], /missing.*CLOUDFLARE/i);
  } finally {
    process.env.CLOUDFLARE_API_TOKEN = previous;
  }
});

test("missing cache headers become N/A", async () => {
  mock.method(console, "log", () => {});
  mock.method(axios, "get", async () => ({ status: 200, headers: {} }));
  const logger = new AppsScriptLogger();
  await warmUrls([`${domain}/`], "id", logger, 1, 0);
  for (const key of ["cf_cache", "vercel_cache", "nextjs_cache"]) {
    assert.equal(logger.rows[0][SHEET_HEADERS.indexOf(key)], "N/A");
  }
});

test("Sheets payload keeps headers and summary/error/request rows aligned", async () => {
  const post = mock.method(axios, "post", async () => ({ data: { ok: true } }));
  const logger = new AppsScriptLogger();
  logger.log({ country: "id", message: "Found 4 URLs" });
  logger.log({ country: "id", url: `${domain}/`, error: 1, message: "HTTP error" });
  logger.log({ vercelCache: "HIT", nextjsCache: "MISS" });
  logger.setFinished();
  await logger.flush();
  const [endpoint, payload] = post.mock.calls[0].arguments;
  assert.equal(endpoint, "https://sheets.test/exec");
  assert.equal(post.mock.calls[0].arguments[2].timeout, 120000);
  assert.deepEqual(payload.headers, SHEET_HEADERS);
  assert.equal(SHEET_HEADERS[7], "vercel_cache");
  assert.equal(SHEET_HEADERS[8], "cf_ray");
  assert.equal(SHEET_HEADERS[12], "nextjs_cache");
  assert.ok(!SHEET_HEADERS.includes("ls_cache"));
  for (const row of payload.rows) {
    assert.equal(row.length, payload.headers.length);
    assert.equal(row[2], logger.finishedAt);
  }
});

test("Sheets JSON errors and non-JSON responses are treated as failures", async () => {
  mock.method(console, "warn", () => {});
  const post = mock.method(axios, "post", async () => ({ data: { ok: false, error: "Wrong schema" } }));
  const logger = new AppsScriptLogger();
  logger.log({ message: "test" });
  await assert.rejects(logger.flush(), /Wrong schema/);
  post.mock.mockImplementation(async () => ({ data: "<html>Sign in</html>" }));
  await assert.rejects(logger.flush(), /did not confirm/);
});

test("Apps Script timeout can be configured and rejects invalid durations", async () => {
  const post = mock.method(axios, "post", async () => ({ data: { ok: true } }));
  const logger = new AppsScriptLogger({ timeoutMs: "180000" });
  logger.log({ message: "test" });
  await logger.flush();
  assert.equal(post.mock.calls[0].arguments[2].timeout, 180000);
  const previous = process.env.APPS_SCRIPT_TIMEOUT_MS;
  try {
    process.env.APPS_SCRIPT_TIMEOUT_MS = "240000";
    const fromEnv = new AppsScriptLogger();
    fromEnv.log({ message: "test" });
    await fromEnv.flush();
    assert.equal(post.mock.calls[1].arguments[2].timeout, 240000);
  } finally {
    process.env.APPS_SCRIPT_TIMEOUT_MS = previous;
  }
  for (const timeoutMs of [0, -1, "invalid", 1.5]) {
    assert.throws(() => new AppsScriptLogger({ timeoutMs }), /positive integer/);
  }
});

test("an Apps Script timeout reports an unconfirmed write and never retries the POST", async () => {
  mock.method(console, "warn", () => {});
  const post = mock.method(axios, "post", async () => {
    throw Object.assign(new Error("timeout of 120000ms exceeded"), { code: "ECONNABORTED" });
  });
  const logger = new AppsScriptLogger();
  logger.log({ message: "test" });
  await assert.rejects(logger.flush(), /may already have been saved/);
  assert.equal(post.mock.callCount(), 1);
});

function receiverFixture(existingValues = [], options = {}) {
  const sheets = new Map();
  const deleted = [];
  const insertFailures = [...(options.insertFailures || [])];
  const writeFailures = [...(options.writeFailures || [])];
  const flushFailures = [...(options.flushFailures || [])];
  let selectedName = "test";
  let insertAttempts = 0;
  let writeAttempts = 0;

  function makeSheet(name, initialValues) {
    const values = structuredClone(initialValues);
    return {
      values,
      getName: () => name,
      getLastRow: () => values.length,
      getRange: (row, column, rowCount, columnCount) => ({
        getValues: () => values.slice(row - 1, row - 1 + rowCount)
          .map((entry) => Array.from({ length: columnCount }, (_, i) => entry[column - 1 + i] ?? "")),
        setValues: (entries) => {
          writeAttempts++;
          const failure = writeFailures.shift();
          if (failure) throw new Error(failure);
          entries.forEach((entry, i) => { values[row - 1 + i] = Array.from(entry); });
        },
      }),
    };
  }
  if (!options.omitManualSheet) sheets.set("Notes", makeSheet("Notes", [["manual tab"]]));
  for (const [name, values] of Object.entries(options.sheets || {})) {
    sheets.set(name, makeSheet(name, values));
  }
  if (existingValues.length) sheets.set("test", makeSheet("test", existingValues));
  const spreadsheet = {
    getSheetByName: (name) => { selectedName = name; return sheets.get(name) || null; },
    getSheets: () => [...sheets.values()],
    insertSheet: (name) => {
      insertAttempts++;
      const failure = insertFailures.shift();
      if (failure) throw new Error(failure);
      const sheet = makeSheet(name, []);
      sheets.set(name, sheet);
      return sheet;
    },
    deleteSheet: (sheet) => {
      assert.ok(sheets.size > 1, "must preserve at least one sheet");
      deleted.push(sheet.getName());
      sheets.delete(sheet.getName());
    },
  };
  const context = vm.createContext({
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      flush() { const failure = flushFailures.shift(); if (failure) throw new Error(failure); },
    },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
  });
  vm.runInContext(readFileSync(new URL("../appscript.gs", import.meta.url), "utf8"), context);
  return {
    get values() { return sheets.get(selectedName)?.values || []; },
    get names() { return [...sheets.keys()]; },
    get insertAttempts() { return insertAttempts; },
    get writeAttempts() { return writeAttempts; },
    deleted,
    cleanup: (count, protectedName) => context.deleteOldestSheets_(spreadsheet, count, protectedName),
    post: (data) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(data) } }).text),
  };
}

test("Apps Script writes the exact client header schema and appends matching rows", () => {
  const receiver = receiverFixture();
  const logger = new AppsScriptLogger();
  logger.log({ vercelCache: "MISS", nextjsCache: "HIT" });
  const payload = { sheetName: logger.sheetName, headers: SHEET_HEADERS, rows: logger.rows };
  assert.equal(receiver.post(payload).ok, true);
  assert.deepEqual(receiver.values[0], [...SHEET_HEADERS]);
  assert.deepEqual(receiver.values[1], logger.rows[0].map((value) => value ?? ""));
  assert.equal(receiver.post(payload).ok, true);
  assert.equal(receiver.values.length, 3);
});

test("Apps Script rejects mismatched row widths and preserves old-schema sheets", () => {
  const legacyHeaders = [...SHEET_HEADERS.slice(0, 12)];
  legacyHeaders[7] = "ls_cache";
  const receiver = receiverFixture([legacyHeaders]);
  const payload = { sheetName: "test", headers: SHEET_HEADERS, rows: [Array(13).fill("")] };
  assert.equal(receiver.post({ ...payload, rows: [Array(12).fill("")] }).ok, false);
  const result = receiver.post(payload);
  assert.equal(result.ok, false);
  assert.match(result.error, /different headers/);
  assert.deepEqual(receiver.values, [legacyHeaders]);
  assert.deepEqual(receiver.deleted, []);
});

const runName = (day) => `2026-10-${String(day).padStart(2, "0")}_12-00-00_WITA`;
const currentRun = "2026-11-03_12-00-00_WITA";
const cellLimitError = "This action would increase the number of cells in the workbook above the limit of 10000000 cells.";
const runSheets = (count) => Object.fromEntries(
  Array.from({ length: count }, (_, i) => [runName(count - i), [[...SHEET_HEADERS]]]),
);
const receiverPayload = (sheetName = currentRun) => ({
  sheetName, headers: SHEET_HEADERS, rows: [Array(SHEET_HEADERS.length).fill("")],
});

test("retention keeps 30 runs, deletes the oldest legacy-suffixed run, and preserves manual tabs", () => {
  const sheets = runSheets(30);
  sheets[runName(1) + "-2"] = sheets[runName(1)];
  delete sheets[runName(1)];
  sheets["2026-02-30_12-00-00_WITA"] = [["invalid date; preserve"]];
  const receiver = receiverFixture([], { sheets });
  const result = receiver.post(receiverPayload());
  assert.equal(result.ok, true);
  assert.deepEqual(result.deletedSheets, [runName(1) + "-2"]);
  assert.equal(receiver.names.length, 32); // 30 runs + Notes + invalid-date tab.
  assert.ok(receiver.names.includes("Notes"));
  assert.ok(receiver.names.includes("2026-02-30_12-00-00_WITA"));
  assert.ok(receiver.names.includes(currentRun));
});

test("retention never deletes the destination even if its timestamp is oldest", () => {
  const receiver = receiverFixture([], { sheets: runSheets(30) });
  const target = "2020-01-01_12-00-00_WITA";
  assert.equal(receiver.post(receiverPayload(target)).ok, true);
  assert.ok(receiver.names.includes(target));
  assert.deepEqual(receiver.deleted, [runName(1)]);
});

test("cleanup never deletes the only remaining tab", () => {
  const receiver = receiverFixture([], { sheets: runSheets(1), omitManualSheet: true });
  assert.equal(receiver.cleanup(5, currentRun).length, 0);
  assert.deepEqual(receiver.names, [runName(1)]);
});

test("cell limit during insert deletes five oldest runs and retries creation", () => {
  const receiver = receiverFixture([], { sheets: runSheets(10), insertFailures: [cellLimitError] });
  const result = receiver.post(receiverPayload());
  assert.equal(result.ok, true);
  assert.equal(receiver.insertAttempts, 2);
  assert.deepEqual(receiver.deleted, [1, 2, 3, 4, 5].map(runName));
  assert.deepEqual(result.deletedSheets, receiver.deleted);
  assert.equal(receiver.values.length, 2);
});

test("cell limit during append retries without losing existing data", () => {
  const existing = [[...SHEET_HEADERS], Array(13).fill("previous")];
  const receiver = receiverFixture([], {
    sheets: { ...runSheets(10), [currentRun]: existing }, writeFailures: [cellLimitError],
  });
  assert.equal(receiver.post(receiverPayload()).ok, true);
  assert.equal(receiver.writeAttempts, 2);
  assert.deepEqual(receiver.values.slice(0, 2), existing);
  assert.equal(receiver.values.length, 3);
  assert.ok(!receiver.deleted.includes(currentRun));
});

test("retrying a flush writes to the original range without duplicating rows", () => {
  const receiver = receiverFixture([], {
    sheets: runSheets(10), flushFailures: [cellLimitError],
  });
  assert.equal(receiver.post(receiverPayload()).ok, true);
  assert.equal(receiver.writeAttempts, 2);
  assert.equal(receiver.values.length, 2);
});

test("permission, range, and request-quota errors do not trigger emergency deletions", () => {
  for (const error of [
    "You do not have permission", "Service invoked too many times: request limit",
    "The number of cells does not match the destination range",
  ]) {
    const receiver = receiverFixture([], { sheets: runSheets(10), insertFailures: [error] });
    const result = receiver.post(receiverPayload());
    assert.equal(result.ok, false);
    assert.equal(receiver.insertAttempts, 1);
    assert.deepEqual(receiver.deleted, []);
  }
});

test("cell-limit recovery stops after three cleanup retries", () => {
  const receiver = receiverFixture([], {
    sheets: runSheets(20), insertFailures: Array(4).fill(cellLimitError),
  });
  const result = receiver.post(receiverPayload());
  assert.equal(result.ok, false);
  assert.equal(receiver.insertAttempts, 4);
  assert.equal(receiver.deleted.length, 15);
  assert.ok(receiver.names.includes("Notes"));
});
