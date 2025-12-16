import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
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

/* ====== CLOUDFLARE (opsional) ====== */
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

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
class AppsScriptLogger {
  constructor() {
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
    lsCache = "",
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
      lsCache,
      cfRay,
      typeof responseMs === "number" ? responseMs : "",
      error ? 1 : 0,
      message,
    ]);
  }

  setFinished() {
    this.finishedAt = new Date().toISOString();
    this.rows = this.rows.map((r) => ((r[2] = this.finishedAt), r));
  }

  async flush() {
    if (!APPS_SCRIPT_URL || this.rows.length === 0) return;
    try {
      await axios.post(
        APPS_SCRIPT_URL,
        { sheetName: this.sheetName, rows: this.rows },
        { timeout: 20000, headers: { "Content-Type": "application/json" } }
      );
    } catch (e) {
      console.warn(
        "Apps Script logging error:",
        e?.response?.data || e?.message || e
      );
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

async function fetchIndexSitemaps(domain, country) {
  try {
    const xml = await fetchWithProxy(`${domain}/sitemap_index.xml`, country);
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });
    const list = result?.sitemapindex?.sitemap;
    if (!list) return [];
    return (Array.isArray(list) ? list : [list])
      .map((e) => e.loc)
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchUrlsFromSitemap(sitemapUrl, country) {
  try {
    const xml = await fetchWithProxy(sitemapUrl, country);
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });
    const list = result?.urlset?.url;
    if (!list) return [];
    return (Array.isArray(list) ? list : [list])
      .map((e) => e.loc)
      .filter(Boolean);
  } catch {
    return [];
  }
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

async function purgeCloudflareCache(url) {
  if (!CLOUDFLARE_ZONE_ID || !CLOUDFLARE_API_TOKEN) return;
  try {
    const purgeRes = await axios.post(
      `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
      { files: [url] },
      {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!purgeRes.data?.success) {
      console.warn(`⚠️ Failed to purge Cloudflare: ${url}`);
    }
  } catch {
    console.warn(`❌ Error purging Cloudflare: ${url}`);
  }
}

/* ====== WARMING ====== */
async function warmUrls(urls, country, logger, batchSize = 1, delay = 2000) {
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
          const lsCache = res.headers["x-litespeed-cache"] || "N/A";
          const cfRay = res.headers["cf-ray"] || "N/A";
          const cfEdge = cfRay.includes("-") ? cfRay.split("-")[1] : "N/A";

          console.log(
            `[${country}] ${res.status} cf=${cfCache} ls=${lsCache} edge=${cfEdge} - ${url}`
          );

          // ✅ country = CF EDGE (HANYA DI SINI)
          logger.log({
            country: cfEdge,
            url,
            status: res.status,
            cfCache,
            lsCache,
            cfRay,
            responseMs: dt,
            error: 0,
            message: "",
          });

          if (String(lsCache).toLowerCase() !== "hit") {
            await purgeCloudflareCache(url);
          }
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
(async () => {
  console.log(`[CacheWarmer] Started: ${new Date().toISOString()}`);
  const logger = new AppsScriptLogger();

  try {
    await Promise.all(
      Object.entries(DOMAINS_MAP).map(async ([country, domain]) => {
        const sitemapList = await fetchIndexSitemaps(domain, country);
        const urlArrays = await Promise.all(
          sitemapList.map((s) => fetchUrlsFromSitemap(s, country))
        );
        const urls = urlArrays.flat().filter(Boolean);

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
})();
