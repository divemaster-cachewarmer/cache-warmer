import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { pathToFileURL } from "node:url";
import { fetchUrlsForDomain } from "./sitemap.js";
import * as dotenv from "dotenv";

dotenv.config();

/* ====== ENV WAJIB ====== */
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

/* ====== KONFIG DOMAIN/PROXY/UA ====== */
const DOMAINS_MAP = {
  id: "https://divemasterlembongan.com",
};

const PROXIES = {
  id: process.env.BRD_PROXY_ID,
};

const USER_AGENTS = {
  id: "DiveMasterLembongan-CacheWarmer-ID/1.0",
};

/* ====== UTIL ====== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cryptoRandomId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

function makeSheetNameForRun(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(date.getTime() + 8 * 3600 * 1000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(
    local.getUTCDate()
  )}_${pad(local.getUTCHours())}-${pad(local.getUTCMinutes())}-${pad(
    local.getUTCSeconds()
  )}_WITA`;
}

/* ====== LOGGER ====== */
export const SHEET_HEADERS = Object.freeze([
  "run_id", "started_at", "finished_at", "country", "url", "status",
  "cf_cache", "vercel_cache", "cf_ray", "response_ms", "error", "message",
  "nextjs_cache",
]);

export class AppsScriptLogger {
  constructor({ timeoutMs = process.env.APPS_SCRIPT_TIMEOUT_MS || 120000 } = {}) {
    this.timeoutMs = Number(timeoutMs);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("APPS_SCRIPT_TIMEOUT_MS must be a positive integer in milliseconds");
    }
    this.rows = [];
    this.runId = cryptoRandomId();
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.sheetName = makeSheetNameForRun();
  }

  log({
    country = "",
    url = "",
    status = "",
    cfCache = "",
    vercelCache = "",
    nextjsCache = "",
    cfRay = "",
    responseMs = "",
    error = 0,
    message = "",
  }) {
    this.rows.push([
      this.runId,
      this.startedAt,
      this.finishedAt,
      country,
      url,
      status,
      cfCache,
      vercelCache,
      cfRay,
      typeof responseMs === "number" ? responseMs : "",
      error ? 1 : 0,
      message,
      nextjsCache,
    ]);
  }

  setFinished() {
    this.finishedAt = new Date().toISOString();
    this.rows = this.rows.map((r) => ((r[2] = this.finishedAt), r));
  }

  async flush() {
    if (!APPS_SCRIPT_URL || this.rows.length === 0) return;
    console.log(`[AppsScript] Sending ${this.rows.length} rows (timeout ${this.timeoutMs / 1000}s)`);
    try {
      const response = await axios.post(
        APPS_SCRIPT_URL,
        { sheetName: this.sheetName, headers: SHEET_HEADERS, rows: this.rows },
        { timeout: this.timeoutMs, headers: { "Content-Type": "application/json" } }
      );
      if (response.data?.ok !== true) {
        throw new Error(response.data?.error || "Apps Script did not confirm the write");
      }
    } catch (e) {
      const error = ["ECONNABORTED", "ETIMEDOUT"].includes(e?.code)
        ? new Error(
            `Apps Script response timed out after ${this.timeoutMs}ms. Data may already have been saved; check Sheets and Apps Script Executions before sending again.`,
            { cause: e }
          )
        : e;
      console.warn("Apps Script logging error:", error?.message || error);
      throw error;
    }
  }
}

/* ====== HTTP ====== */
function buildAxiosCfg(country, extra = {}) {
  const proxy = PROXIES[country];
  const cfg = {
    headers: { "User-Agent": USER_AGENTS[country] },
    timeout: 30000,
    ...extra,
  };
  if (proxy) cfg.httpsAgent = new HttpsProxyAgent(proxy);
  return cfg;
}

/* ====== SITEMAP ====== */
async function fetchWithProxy(url, country, timeout = 15000) {
  const cfg = buildAxiosCfg(country, { timeout });
  const res = await axios.get(url, cfg);
  return res.data;
}

/* ====== REQUEST ====== */
async function retryableGet(url, cfg, retries = 3) {
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, cfg);
    } catch (err) {
      lastError = err;
      const code = err?.code || "";
      if (
        !(
          axios.isAxiosError(err) &&
          ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT"].includes(code)
        )
      ) {
        break;
      }
      await sleep(2000);
    }
  }
  throw lastError;
}

/* ====== CLOUDFLARE PURGE PER URL ====== */
async function purgeCloudflareCache(url) {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!zoneId || !token) {
    const message = "Cloudflare purge skipped: missing CLOUDFLARE_ZONE_ID or CLOUDFLARE_API_TOKEN";
    console.warn(`[Cloudflare] ${message} - ${url}`);
    return { error: 1, message };
  }

  try {
    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`,
      { files: [url] },
      {
        timeout: 20000,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (response.data?.success !== true) {
      const details = response.data?.errors?.map((item) => item.message).filter(Boolean).join("; ");
      throw new Error(details || "Cloudflare API did not accept the purge");
    }
    const message = "Cloudflare purge accepted";
    console.log(`[Cloudflare] ${message} - ${url}`);
    return { error: 0, message };
  } catch (error) {
    const message = `Cloudflare purge failed: ${error?.message || "request failed"}`;
    console.warn(`[Cloudflare] ${message} - ${url}`);
    return { error: 1, message };
  }
}

/* ====== WARMING ====== */
export async function warmUrls(urls, country, logger, batchSize = 1, delay = 2000) {
  const batches = Array.from(
    { length: Math.ceil(urls.length / batchSize) },
    (_, i) => urls.slice(i * batchSize, i * batchSize + batchSize)
  );

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (url) => {
        const t0 = Date.now();
        try {
          const res = await retryableGet(
            url,
            buildAxiosCfg(country, { timeout: 15000 }),
            3
          );
          const dt = Date.now() - t0;

          const cfCache = res.headers["cf-cache-status"] || "N/A";
          const vercelCache = String(res.headers["x-vercel-cache"] || "").trim().toUpperCase() || "N/A";
          const nextjsCache = res.headers["x-nextjs-cache"] || "N/A";
          const cfRay = res.headers["cf-ray"] || "N/A";
          const cfEdge = cfRay.includes("-") ? cfRay.split("-")[1] : "N/A";

          console.log(
            `[${country}] ${res.status} cf=${cfCache} vercel=${vercelCache} nextjs=${nextjsCache} edge=${cfEdge} - ${url}`
          );

          const purgeResult = vercelCache !== "HIT" && vercelCache !== "N/A"
            ? await purgeCloudflareCache(url)
            : { error: 0, message: "" };

          // ✅ country = CF EDGE (HANYA DI SINI)
          logger.log({
            country: cfEdge,
            url,
            status: res.status,
            cfCache,
            vercelCache,
            nextjsCache,
            cfRay,
            responseMs: dt,
            error: purgeResult.error,
            message: purgeResult.message,
          });

        } catch (err) {
          const dt = Date.now() - t0; // ✅ FIX dt

          console.warn(
            `[${country}] ❌ Failed to warm ${url}: ${err?.message || err}`
          );

          // ❌ country TIDAK DIUBAH
          logger.log({
            country,
            url,
            responseMs: dt,
            error: 1,
            message: err?.message || "request failed",
          });
        }
      })
    );

    await sleep(delay);
  }
}

/* ====== MAIN ====== */
export async function main() {
  console.log(`[CacheWarmer] Started: ${new Date().toISOString()}`);
  const logger = new AppsScriptLogger();

  try {
    await Promise.all(
      Object.entries(DOMAINS_MAP).map(async ([country, domain]) => {
        const reportSitemapError = (url, error) => {
          const message = `Sitemap error: ${error?.message || "request failed"}`;
          console.warn(`[${country}] ${message} - ${url}`);
          logger.log({ country, url, error: 1, message });
        };
        const urls = await fetchUrlsForDomain(
          domain,
          (url) => fetchWithProxy(url, country),
          reportSitemapError
        );

        console.log(`[${country}] Found ${urls.length} URLs`);
        logger.log({
          country,
          message: `Found ${urls.length} URLs for ${country}`,
        });

        await warmUrls(urls, country, logger);
      })
    );
  } finally {
    logger.setFinished();
    await logger.flush();
  }

  console.log(`[CacheWarmer] Finished: ${new Date().toISOString()}`);
}

// Importing this module for verification must not start warming or send logs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[CacheWarmer] Failed: ${error?.message || "unknown error"}`);
    process.exitCode = 1;
  });
}
