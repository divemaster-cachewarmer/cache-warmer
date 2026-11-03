import { parseStringPromise } from "xml2js";

// Next.js can serve a urlset directly; larger sites can use nested indexes.
export async function fetchUrlsForDomain(domain, fetchXml, onError = () => {}) {
  const base = new URL(domain);

  async function readSitemap(sitemapUrl, visited, depth = 0) {
    if (visited.has(sitemapUrl)) return [];
    if (depth > 10) throw new Error("Sitemap index nesting exceeds 10 levels");
    visited.add(sitemapUrl);

    const xml = await fetchXml(sitemapUrl);
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
      tagNameProcessors: [(name) => name.replace(/^.*:/, "")],
    });

    function locations(entries) {
      const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
      return list
        .map((entry) => entry?.loc)
        .filter((loc) => typeof loc === "string" && loc.trim())
        .map((loc) => {
          const url = new URL(loc.trim(), sitemapUrl);
          if (!["http:", "https:"].includes(url.protocol)) {
            throw new Error("Sitemap contains a non-HTTP URL");
          }
          return url.href;
        });
    }

    if (result && Object.hasOwn(result, "urlset")) {
      return locations(result.urlset?.url);
    }
    if (result && Object.hasOwn(result, "sitemapindex")) {
      const urls = [];
      for (const child of locations(result.sitemapindex?.sitemap)) {
        try {
          urls.push(...(await readSitemap(child, visited, depth + 1)));
        } catch (error) {
          onError(child, error);
        }
      }
      return urls;
    }
    throw new Error("Expected a urlset or sitemapindex XML document");
  }

  for (const path of ["/sitemap.xml", "/sitemap_index.xml"]) {
    const sitemapUrl = new URL(path, base).href;
    try {
      const urls = [...new Set(await readSitemap(sitemapUrl, new Set()))];
      if (urls.length === 0) throw new Error("Sitemap contains no usable page URLs");
      return urls;
    } catch (error) {
      onError(sitemapUrl, error);
    }
  }
  throw new Error(`No page URLs found in the sitemaps for ${base.origin}`);
}
