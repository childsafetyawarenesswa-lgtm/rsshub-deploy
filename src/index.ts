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

type FeedMeta = {
  source: string;
  listUrl: string;
  lastSuccessIso?: string; // when we last successfully refreshed from upstream
  lastAttemptIso?: string; // when we last attempted refresh
  lastError?: string; // last upstream error (if any)
  itemCount?: number;
};

export interface Env {
  // Bind a KV namespace named FEED_KV in your worker settings (wrangler / dashboard)
  FEED_KV: KVNamespace;
}

const SOURCE = "childsafety.gov.au";
const LIST_URL = "https://www.childsafety.gov.au/news";

// KV keys
const KV_ITEMS_KEY = "feeds:childsafety:news:items:v1";
const KV_RSS_KEY = "feeds:childsafety:news:rss:v1";
const KV_META_KEY = "feeds:childsafety:news:meta:v1";

// Refresh strategy
const REFRESH_INTERVAL_SECONDS = 30 * 60; // how "fresh" we want KV content (30m)
const KV_TTL_SECONDS = 7 * 24 * 60 * 60; // keep KV values for 7 days (safety net)
const CLIENT_MAX_AGE_SECONDS = 10 * 60; // tell clients they can cache 10m
const EDGE_STALE_WHILE_REFRESH_SECONDS = 5 * 60; // serve stale while background refresh runs

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
          "user-agent":
            "Mozilla/5.0 (compatible; childsafetyawarenesswa-rss/1.0; +https://rsshub-wa.childsafetyawarenesswa.workers.dev)",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-AU,en;q=0.9",
          "cache-control": "no-cache",
          pragma: "no-cache",
        },
        // Small edge caching to reduce origin hits (doesn't help if origin blocks)
        cf: { cacheTtl: 300, cacheEverything: false },
      });

      if (res.ok) return res;

      // Retry on 5xx
      if (res.status >= 500 && res.status <= 599) {
        lastErr = new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
      } else {
        // 4xx usually means blocked or not found; don't hammer
        throw new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
      }
    } catch (e: any) {
      lastErr = e;
    }

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

    // Best-effort proximity extraction
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

function textResponse(text: string, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...extraHeaders,
    },
  });
}

async function getMeta(env: Env): Promise<FeedMeta> {
  const raw = await env.FEED_KV.get(KV_META_KEY);
  if (!raw) return { source: SOURCE, listUrl: LIST_URL };
  try {
    return JSON.parse(raw) as FeedMeta;
  } catch {
    return { source: SOURCE, listUrl: LIST_URL };
  }
}

function metaAgeSeconds(meta: FeedMeta): number | null {
  if (!meta.lastSuccessIso) return null;
  const t = Date.parse(meta.lastSuccessIso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 1000);
}

async function writeKv(env: Env, items: FeedItem[]) {
  const rss = toRss("ChildSafety.gov.au - News (Latest)", LIST_URL, items);

  const meta: FeedMeta = {
    source: SOURCE,
    listUrl: LIST_URL,
    lastSuccessIso: new Date().toISOString(),
    lastAttemptIso: new Date().toISOString(),
    lastError: undefined,
    itemCount: items.length,
  };

  await Promise.all([
    env.FEED_KV.put(KV_ITEMS_KEY, JSON.stringify(items), { expirationTtl: KV_TTL_SECONDS }),
    env.FEED_KV.put(KV_RSS_KEY, rss, { expirationTtl: KV_TTL_SECONDS }),
    env.FEED_KV.put(KV_META_KEY, JSON.stringify(meta), { expirationTtl: KV_TTL_SECONDS }),
  ]);
}

async function writeMetaError(env: Env, message: string) {
  const prev = await getMeta(env);
  const meta: FeedMeta = {
    ...prev,
    lastAttemptIso: new Date().toISOString(),
    lastError: message,
  };
  await env.FEED_KV.put(KV_META_KEY, JSON.stringify(meta), { expirationTtl: KV_TTL_SECONDS });
}

/**
 * Refresh from upstream and store into KV.
 * Returns true on success, false on failure.
 */
async function refreshNow(env: Env): Promise<boolean> {
  try {
    const items = await fetchChildSafetyNews();
    await writeKv(env, items);
    return true;
  } catch (e: any) {
    await writeMetaError(env, e?.message || String(e));
    return false;
  }
}

/**
 * Serve from KV. If missing -> try refresh once.
 * If stale -> serve KV immediately and refresh in background.
 */
async function serveJson(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const meta = await getMeta(env);
  const age = metaAgeSeconds(meta);

  const kvItemsRaw = await env.FEED_KV.get(KV_ITEMS_KEY);

  // If we have data:
  if (kvItemsRaw) {
    // If stale, refresh in background but serve now
    if (age === null || age > REFRESH_INTERVAL_SECONDS) {
      ctx.waitUntil(
        (async () => {
          // small jitter so multiple hits don’t stampede
          await sleep(Math.floor(Math.random() * 750));
          await refreshNow(env);
        })()
      );
      return jsonResponse(JSON.parse(kvItemsRaw), {
        "x-feed-source": SOURCE,
        "x-feed-status": "STALE_SERVE_REFRESHING",
        "x-feed-age-seconds": String(age ?? -1),
        "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}, stale-while-revalidate=${EDGE_STALE_WHILE_REFRESH_SECONDS}`,
      });
    }

    return jsonResponse(JSON.parse(kvItemsRaw), {
      "x-feed-source": SOURCE,
      "x-feed-status": "FRESH_FROM_KV",
      "x-feed-age-seconds": String(age ?? -1),
      "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
    });
  }

  // No KV data yet: try a synchronous refresh once
  const ok = await refreshNow(env);
  if (!ok) {
    const metaAfter = await getMeta(env);
    return jsonResponse(
      {
        error: metaAfter.lastError || "Upstream refresh failed",
        hint: "KV empty and upstream blocked/failed. Try again later (cron will keep attempting).",
        meta: metaAfter,
      },
      {
        "x-feed-source": SOURCE,
        "x-feed-status": "EMPTY_AND_REFRESH_FAILED",
      }
    );
  }

  const kvItemsRaw2 = await env.FEED_KV.get(KV_ITEMS_KEY);
  if (!kvItemsRaw2) {
    return jsonResponse(
      { error: "Refresh succeeded but KV read failed (unexpected)" },
      { "x-feed-status": "KV_READ_FAILED" }
    );
  }

  return jsonResponse(JSON.parse(kvItemsRaw2), {
    "x-feed-source": SOURCE,
    "x-feed-status": "REFRESHED_ON_DEMAND",
  });
}

async function serveRss(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const meta = await getMeta(env);
  const age = metaAgeSeconds(meta);

  const kvRss = await env.FEED_KV.get(KV_RSS_KEY);

  if (kvRss) {
    if (age === null || age > REFRESH_INTERVAL_SECONDS) {
      ctx.waitUntil(
        (async () => {
          await sleep(Math.floor(Math.random() * 750));
          await refreshNow(env);
        })()
      );
      return rssResponse(kvRss, {
        "x-feed-source": SOURCE,
        "x-feed-status": "STALE_SERVE_REFRESHING",
        "x-feed-age-seconds": String(age ?? -1),
        "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}, stale-while-revalidate=${EDGE_STALE_WHILE_REFRESH_SECONDS}`,
      });
    }

    return rssResponse(kvRss, {
      "x-feed-source": SOURCE,
      "x-feed-status": "FRESH_FROM_KV",
      "x-feed-age-seconds": String(age ?? -1),
      "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
    });
  }

  // No KV data: try refresh once
  const ok = await refreshNow(env);
  if (!ok) {
    const metaAfter = await getMeta(env);
    return textResponse(
      `Error generating feed (KV empty): ${metaAfter.lastError || "Upstream refresh failed"}`,
      503,
      { "x-feed-status": "EMPTY_AND_REFRESH_FAILED" }
    );
  }

  const kvRss2 = await env.FEED_KV.get(KV_RSS_KEY);
  if (!kvRss2) {
    return textResponse("Refresh succeeded but KV read failed (unexpected)", 500, {
      "x-feed-status": "KV_READ_FAILED",
    });
  }

  return rssResponse(kvRss2, {
    "x-feed-source": SOURCE,
    "x-feed-status": "REFRESHED_ON_DEMAND",
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health
    if (url.pathname === "/") {
      return textResponse("Worker is live");
    }

    // Quick debug/meta endpoint
    if (url.pathname === "/feeds/childsafety/news.meta.json") {
      const meta = await getMeta(env);
      const age = metaAgeSeconds(meta);
      return jsonResponse(
        { ...meta, ageSeconds: age },
        { "x-feed-source": SOURCE, "x-feed-status": "META" }
      );
    }

    // JSON endpoint for Make
    if (url.pathname === "/feeds/childsafety/news.json") {
      return serveJson(request, env, ctx);
    }

    // RSS endpoint for readers
    if (
      url.pathname === "/feeds/childsafety/news.rss" ||
      url.pathname === "/feeds/childsafety/news.xml"
    ) {
      return serveRss(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },

  /**
   * Cloudflare Cron Trigger.
   * Configure this in your Worker (Triggers -> Cron) e.g. every 30 minutes.
   */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await refreshNow(env);
  },
};
