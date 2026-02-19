// src/index.ts
import { load } from "cheerio";

type FeedItem = {
  title: string;
  link: string;
  pubDate?: string;
  description?: string;
  guid: string;
};

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
      const desc = i.description ? `<description>${escapeXml(i.description)}</description>` : "";
      const pub = i.pubDate ? `<pubDate>${escapeXml(i.pubDate)}</pubDate>` : "";
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
      "accept": "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    throw new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const $ = load(html);

  // The page is a list of news items with a title link to /news/<slug>,
  // plus date text and snippet. We'll collect all /news/<slug> links inside main content.
  const items: FeedItem[] = [];

  // Collect candidate links
  const links = $("main a[href^='/news/']").toArray();

  for (const a of links) {
    const el = $(a);
    const href = el.attr("href") || "";
    const title = el.text().trim();

    if (!href || !title) continue;
    if (href === "/news") continue; // skip the listing itself

    const link = new URL(href, "https://www.childsafety.gov.au").toString();

    // Find surrounding text for date + snippet.
    // We'll use a simple proximity approach: look at parent and next siblings.
    const parent = el.parent();
    const dateText = parent.next().text().trim();
    const snippetText = parent.nextAll().eq(1).text().trim();

    // Create stable guid
    const guid = `childsafety:${link}`;

    items.push({
      title,
      link,
      pubDate: dateText || undefined,
      description: snippetText || undefined,
      guid,
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

    // POC feed endpoint
    if (url.pathname === "/feeds/childsafety/news") {
      try {
        const items = await fetchChildSafetyNews();
        const rss = toRss(
          "ChildSafety.gov.au - News (Latest)",
          "https://www.childsafety.gov.au/news",
          items
        );
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
