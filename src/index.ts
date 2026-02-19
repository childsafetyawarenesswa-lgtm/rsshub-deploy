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

// Cache settings
const CACHE_TTL_SECONDS = 6 * 60 * 60; // keep in CF cache up to 6h
const CLIENT_MAX_AGE_SECONDS = 30 * 60; // tell clients 30m

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
          // More browser-like headers can help with origin/CDN quirks
          "user-agent":
            "Mozilla/5.0 (compatible; childsafetyawarenesswa-rss/1.0; +https://rsshub-wa.childsafetyawarenesswa.workers.dev)",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-AU,en;q=0.9",
          "cache-control": "no-cache",
          pragma: "no-cache",
        },
        // Cloudflare fetch options: cache upstream a little at the edge (helps reduce origin hits)
        cf: { cacheTtl: 300, cacheEverything: false },
      });

      if (res.ok) return res;

      // Retry on 5xx, including 520-ish conditions
      if (res.status >= 500 && res.status <= 599) {
        lastErr = new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
      } else {
        // non-retryable
        throw new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
      }
    } catch (e: any) {
      lastErr = e;
    }

    // Backoff: 250ms, 750ms, 1500ms ...
    if (attempt < tries) {
      const backoff = 250 * attempt * attempt;
      await sleep(backoff);
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

    // “best-effort” proximity extraction
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

  // Deduplicate by link
  const deduped = Array.from(new Map(items.map((i) => [i.link, i])).values());

  return deduped.slice(0, 15);
}

function jsonResponse(data: unknown, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
      ...extraHeaders,
    },
  });
}

function rssResponse(rss: string, extraHeaders: Record<string, string> = {}) {
  return new Response(rss, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
      ...extraHeaders,
    },
  });
}

/**
 * Serve cached response if present.
 * If upstream fails, fall back to cache (if any).
 */
async function cachedOrFresh(request: Request, buildFresh: () => Promise<Response>): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), request);

  const cached = await cache.match(cacheKey);
  if (cached) {
    // mark as cache hit (helps debugging)
    const hit = new Response(cached.body, cached);
    hit.headers.set("x-cache", "HIT");
    return hit;
  }

  try {
    const fresh = await buildFresh();

    // Put into cache with a longer TTL at the edge
    const toCache = new Response(fresh.body, fresh);
    toCache.headers.set("cache-control", `public, max-age=${CACHE_TTL_SECONDS}`);
    toCache.headers.set("x-cache", "MISS");

    // Need a clone to return because body is a stream
    const freshToReturn = new Response(toCache.body, toCache);
    freshToReturn.headers.set("cache-control", `public, max-age=${CLIENT_MAX_AGE_SECONDS}`);
    freshToReturn.headers.set("x-cache", "MISS");

    await cache.put(cacheKey, toCache.clone());
    return freshToReturn;
  } catch (err: any) {
    const fallback = await cache.match(cacheKey);
    if (fallback) {
      const stale = new Response(fallback.body, fallback);
      stale.headers.set("x-cache", "STALE");
      return stale;
    }
    // No cache to fall back to
    return jsonResponse(
      { error: err?.message || String(err) },
      { "x-cache": "ERROR" }
    );
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Worker is live", { headers: { "content-type": "text/plain" } });
    }

    // JSON endpoint for Make
    if (url.pathname === "/feeds/childsafety/news.json") {
      return cachedOrFresh(request, async () => {
        const items = await fetchChildSafetyNews();
        return jsonResponse(items);
      });
    }

    // RSS endpoint for readers
    if (url.pathname === "/feeds/childsafety/news.rss" || url.pathname === "/feeds/childsafety/news.xml") {
      return cachedOrFresh(request, async () => {
        const items = await fetchChildSafetyNews();
        const rss = toRss("ChildSafety.gov.au - News (Latest)", LIST_URL, items);
        return rssResponse(rss);
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
