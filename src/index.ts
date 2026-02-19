// src/index.ts
import { load } from "cheerio";

type FeedItem = {
  title: string;
  link: string;
  pubDate?: string;
  description?: string;
  guid: string;
  hash: string; // stable ID for Make dedupe
  source: string;
};

function escapeXml(str: string) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stableHash(input: string) {
  // Simple deterministic hash (djb2 variant). Good enough for stable IDs/dedupe.
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function toRss(title: string, link: string, items: FeedItem[]) {
  const now = new Date().toUTCString();
  const itemXml = items
    .map((i) => {
      const desc = i.description ? `<description>${escapeXml(i.description)}</description>` : "";
      const pub = i.pubDate ? `<pubDate>${escapeXml(i.pubDate)}</pubDate>` : "";
      // GUID should stay stable forever (we use link-based guid)
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

async function fetchChildSafetyNews(): Promise<FeedItem[]> {
  const listUrl = "https://www.childsafety.gov.au/news";
  const res = await fetch(listUrl, {
    headers: {
      // Basic, polite UA
      "user-agent": "childsafetyawarenesswa-rss-poc/1.0",
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    throw new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const $ = load(html);

  const items: FeedItem[] = [];
  const links = $("main a[href^='/news/']").toArray();

  for (const a of links) {
    const el = $(a);
    const href = el.attr("href") || "";
    const title = el.text().trim();

    if (!href || !title) continue;
    if (href === "/news") continue; // skip the listing itself

    const link = new URL(href, "https://www.childsafety.gov.au").toString();

    // Find surrounding text for date + snippet.
    const parent = el.parent();
    const dateText = parent.next().text().trim();
    const snippetText = parent.nextAll().eq(1).text().trim();

    // Stable GUID and hash for dedupe
    const guid = `childsafety:${link}`;
    const hash = stableHash(guid);

    items.push({
      title,
      link,
      pubDate: dateText || undefined,
      description: snippetText || undefined,
      guid,
      hash,
      source: "childsafety.gov.au",
    });
  }

  // Deduplicate by link (nav links can sometimes match)
  const deduped = Array.from(new Map(items.map((i) => [i.link, i])).values());

  // Keep a sensible number from page 1
  return deduped.slice(0, 15);
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/") {
      return new Response("Worker is live", { headers: { "content-type": "text/plain" } });
    }

    // JSON endpoint (Make-friendly)
    if (url.pathname === "/feeds/childsafety/news.json") {
      try {
        const items = await fetchChildSafetyNews();
        const json = items.map((i) => ({
          title: i.title,
          link: i.link,
          published: i.pubDate ?? null,
          summary: i.description ?? null,
          guid: i.guid,
          hash: i.hash,
          source: i.source,
        }));

        return new Response(JSON.stringify(json, null, 2), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=1800",
          },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err?.message || String(err) }, null, 2), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    // RSS endpoint
    if (url.pathname === "/feeds/childsafety/news") {
      try {
        const items = await fetchChildSafetyNews();
        const rss = toRss("ChildSafety.gov.au - News (Latest)", "https://www.childsafety.gov.au/news", items);

        return new Response(rss, {
          headers: {
            "content-type": "application/rss+xml; charset=utf-8",
            // cache a bit so we’re nice to upstream
            "cache-control": "public, max-age=1800",
          },
        });
      } catch (err: any) {
        return new Response(`Error generating feed: ${err?.message || String(err)}`, {
          status: 500,
          headers: { "content-type": "text/plain" },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
