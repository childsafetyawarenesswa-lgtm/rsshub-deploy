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

// Edge cache TTL (Cloudflare)
const EDGE_CACHE_TTL = 60 * 60; // 1 hour

// Client cache TTL
const CLIENT_MAX_AGE = 30 * 60; // 30 minutes

/* ------------------------------------------------ */
/* Utility Functions */
/* ------------------------------------------------ */

function escapeXml(str: string) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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

/* ------------------------------------------------ */
/* Upstream Fetch (with retry + browser headers) */
/* ------------------------------------------------ */

async function fetchWithRetry(url: string, tries = 3): Promise<Response> {
  let lastErr: any;

  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-AU,en;q=0.9",
        },
        cf: {
          cacheTtl: 300,
          cacheEverything: false,
        },
      });

      if (res.ok) return res;

      if (res.status >= 500) {
        lastErr = new Error(
          `Upstream fetch failed: ${res.status} ${res.statusText}`
        );
      } else {
        throw new Error(
          `Upstream fetch failed: ${res.status} ${res.statusText}`
        );
      }
    } catch (e) {
      lastErr = e;
    }

    if (attempt < tries) {
      await sleep(300 * attempt);
    }
  }

  throw lastErr ?? new Error("Upstream fetch failed");
}

/* ------------------------------------------------ */
/* Scrape News */
/* ------------------------------------------------ */

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

    if (!href || !title || href === "/news") continue;

    const link = new URL(href, LIST_URL).toString();

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

  const deduped = Array.from(
    new Map(items.map((i) => [i.link, i])).values()
  );

  return deduped.slice(0, 15);
}

/* ------------------------------------------------ */
/* Output Builders */
/* ------------------------------------------------ */

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CLIENT_MAX_AGE}`,
    },
  });
}

function rssResponse(title: string, link: string, items: FeedItem[]) {
  const now = new Date().toUTCString();

  const itemXml = items
    .map((i) => {
      const desc = i.summary
        ? `<description>${escapeXml(i.summary)}</description>`
        : "";
      const pub = i.published
        ? `<pubDate>${escapeXml(i.published)}</pubDate>`
        : "";

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

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(link)}</link>
    <description>${escapeXml(title)}</description>
    <lastBuildDate>${escapeXml(now)}</lastBuildDate>
    ${itemXml}
  </channel>
</rss>`;

  return new Response(rss, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${CLIENT_MAX_AGE}`,
    },
  });
}

/* ------------------------------------------------ */
/* Worker */
/* ------------------------------------------------ */

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/") {
        return new Response("Worker is live", {
          headers: { "content-type": "text/plain" },
        });
      }

      // JSON endpoint (for Make)
      if (url.pathname === "/feeds/childsafety/news.json") {
        const items = await fetchChildSafetyNews();
        return jsonResponse(items);
      }

      // RSS endpoints
      if (
        url.pathname === "/feeds/childsafety/news" ||
        url.pathname === "/feeds/childsafety/news.rss" ||
        url.pathname === "/feeds/childsafety/news.xml"
      ) {
        const items = await fetchChildSafetyNews();
        return rssResponse(
          "ChildSafety.gov.au - News (Latest)",
          LIST_URL,
          items
        );
      }

      return new Response("Not found", { status: 404 });
    } catch (err: any) {
      return jsonResponse({
        error: err?.message || "Unknown error",
      });
    }
  },
};
