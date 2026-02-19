// src/index.ts
import { load } from "cheerio";

type FeedItem = {
  title: string;
  link: string;
  published?: string;
  summary?: string;
  guid: string;
  hash: string;
  source: string;
};

const SOURCE = "childsafety.gov.au";
const LIST_URL = "https://www.childsafety.gov.au/news";

// How long we keep the cached feed at the edge
const EDGE_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours

// What we tell clients (Make / browsers) to cache
const CLIENT_MAX_AGE_SECONDS = 60; // 60s (keep low for Make debugging)

// Internal cache keys (fixed keys so cache works regardless of querystrings)
const CACHE_KEY_JSON = "https://cache.local/feeds/childsafety/news.json";
const CACHE_KEY_RSS = "https://cache.local/feeds/childsafety/news.rss";

function escapeXml(str: string) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toRss(title: string, link: string, items: FeedItem[]) {
  const now = new Date().toUTCString();
  const itemXml = items
    .map((i) => {
      const desc = i.summary ? `<description>${escapeXml(i.summary)}</description>` : "";
      const pub = i.published ? `<pubDate>${escapeXml(i.published)}</pubDate>` : "";
      return `
      <item>
        <title>${escapeXml(i.title)}</title>
        <link>${escapeXml(i.link)}</link>
        <guid isPermaLink="false">${escapeXml(i.guid)}</guid>
        ${pub}
        ${desc}
      </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(link)}</link>
    <description>${escapeXml(title)}</description>
    <lastBuildDate>${escapeXml(now)}</lastBuildDate>
    ${itemXml}
  </channel>
</rss>`;
}

async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url: string, tries = 3): Promise<Response> {
  let lastErr: any;

  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          // More browser-like headers; can reduce WAF false positives
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-AU,en;q=0.9",
          "upgrade-insecure-requests": "1",
          // These sometimes help with strict origin checks:
          referer: "https://www.childsafety.gov.au/",
        },
        redirect: "follow",
        cf: {
          cacheTtl: 300,
          cacheEverything: false,
        },
      });

      if (res.ok) return res;

      // retry on 403/429/5xx
      if (res.status === 403 || res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        lastErr = new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
      } else {
        throw new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
      }
    } catch (e: any) {
      lastErr = e;
    }

    if (attempt < tries) {
      // small backoff
      await sleep(250 * attempt * attempt);
    }
  }

  throw lastErr ?? new Error("Upstream fetch failed");
}

async function fetchChildSafetyNews(): Promise<FeedItem[]> {
  const res = await fetchWithRetry(LIST_URL, 3);
  const html = await res.text();
  const $ = load(html);

  const items: FeedItem[] = [];
  const links = $("main a[href^='/news/']").toArray();

  for (const a of links) {
    const el = $(a);
    const href = (el.attr("href") || "").trim();
    const title = el.text().trim();

    if (!href || !title) continue;
    if (href === "/news") continue;

    const link = new URL(href, "https://www.childsafety.gov.au").toString();

    // best-effort proximity extraction
    const parent = el.parent();
    const dateText = parent.next().text().trim();
    const snippetText = parent.nextAll().eq(1).text().trim();

    const guid = `childsafety:${link}`;
    const hash = await sha1Hex(guid);

    items.push({
      title,
      link,
      published: dateText || undefined,
      summary: snippetText || undefined,
      guid,
      hash,
      source: SOURCE,
    });
  }

  const deduped = Array.from(new Map(items.map((i) => [i.link, i])).values());
  return deduped.slice(0, 15);
}

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
      ...extraHeaders,
    },
  });
}

function rssResponse(rss: string, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(rss, {
    status,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
      ...extraHeaders,
    },
  });
}

/**
 * Stale-while-revalidate:
 * - Return cached immediately if present (FAST + reliable for Make)
 * - Refresh cache in background
 * - If no cache exists, build fresh and cache it
 */
async function serveJsonWithCache(ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(CACHE_KEY_JSON);

  const cached = await cache.match(cacheKey);
  if (cached) {
    // refresh in background
    ctx.waitUntil(refreshJsonCache(cacheKey));
    const hit = new Response(cached.body, cached);
    hit.headers.set("x-cache", "HIT");
    return hit;
  }

  // no cache yet: build now
  try {
    const items = await fetchChildSafetyNews();
    const fresh = jsonResponse(items, 200, { "x-cache": "MISS" });

    const toCache = new Response(fresh.body, fresh);
    toCache.headers.set("cache-control", `public, max-age=${EDGE_CACHE_TTL_SECONDS}`);
    await cache.put(cacheKey, toCache.clone());

    return fresh;
  } catch (err: any) {
    return jsonResponse({ error: err?.message || String(err) }, 502, { "x-cache": "ERROR" });
  }
}

async function refreshJsonCache(cacheKey: Request): Promise<void> {
  const cache = caches.default;
  try {
    const items = await fetchChildSafetyNews();
    const fresh = jsonResponse(items, 200);

    const toCache = new Response(fresh.body, fresh);
    toCache.headers.set("cache-control", `public, max-age=${EDGE_CACHE_TTL_SECONDS}`);
    toCache.headers.set("x-cache", "REFRESH");

    await cache.put(cacheKey, toCache);
  } catch {
    // swallow refresh errors – we keep serving last known good cache
  }
}

async function serveRssWithCache(ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(CACHE_KEY_RSS);

  const cached = await cache.match(cacheKey);
  if (cached) {
    ctx.waitUntil(refreshRssCache(cacheKey));
    const hit = new Response(cached.body, cached);
    hit.headers.set("x-cache", "HIT");
    return hit;
  }

  try {
    const items = await fetchChildSafetyNews();
    const rss = toRss("ChildSafety.gov.au - News (Latest)", LIST_URL, items);
    const fresh = rssResponse(rss, 200, { "x-cache": "MISS" });

    const toCache = new Response(fresh.body, fresh);
    toCache.headers.set("cache-control", `public, max-age=${EDGE_CACHE_TTL_SECONDS}`);
    await cache.put(cacheKey, toCache.clone());

    return fresh;
  } catch (err: any) {
    // If RSS fails and no cache, return a real 502 (not 200)
    return rssResponse(
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>error</title><description>${escapeXml(
        err?.message || String(err)
      )}</description></channel></rss>`,
      502,
      { "x-cache": "ERROR" }
    );
  }
}

async function refreshRssCache(cacheKey: Request): Promise<void> {
  const cache = caches.default;
  try {
    const items = await fetchChildSafetyNews();
    const rss = toRss("ChildSafety.gov.au - News (Latest)", LIST_URL, items);
    const fresh = rssResponse(rss, 200);

    const toCache = new Response(fresh.body, fresh);
    toCache.headers.set("cache-control", `public, max-age=${EDGE_CACHE_TTL_SECONDS}`);
    toCache.headers.set("x-cache", "REFRESH");

    await cache.put(cacheKey, toCache);
  } catch {
    // keep last cached RSS
  }
}

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Worker is live", { headers: { "content-type": "text/plain" } });
    }

    // JSON endpoint for Make
    if (url.pathname === "/feeds/childsafety/news.json") {
      return serveJsonWithCache(ctx);
    }

    // RSS endpoints (and alias without extension)
    if (
      url.pathname === "/feeds/childsafety/news" ||
      url.pathname === "/feeds/childsafety/news.rss" ||
      url.pathname === "/feeds/childsafety/news.xml"
    ) {
      return serveRssWithCache(ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
