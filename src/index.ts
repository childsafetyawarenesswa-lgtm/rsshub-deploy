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

const CLIENT_MAX_AGE_SECONDS = 1800;

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

async function fetchChildSafetyNews(): Promise<FeedItem[]> {
  const res = await fetch(LIST_URL, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; rsshub-wa/1.0; +https://rsshub-wa.childsafetyawarenesswa.workers.dev)",
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
    const href = (el.attr("href") || "").trim();
    const title = el.text().trim();

    if (!href || !title || href === "/news") continue;

    const link = new URL(href, "https://www.childsafety.gov.au").toString();
    const guid = `childsafety:${link}`;
    const hash = await sha1Hex(guid);

    const parent = el.parent();
    const dateText = parent.next().text().trim();
    const snippetText = parent.nextAll().eq(1).text().trim();

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

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
    },
  });
}

function rssResponse(rss: string) {
  return new Response(rss, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Worker is live", {
        headers: { "content-type": "text/plain" },
      });
    }

    try {
      if (url.pathname === "/feeds/childsafety/news.json") {
        const items = await fetchChildSafetyNews();
        return jsonResponse(items);
      }

      if (
        url.pathname === "/feeds/childsafety/news.rss" ||
        url.pathname === "/feeds/childsafety/news.xml"
      ) {
        const items = await fetchChildSafetyNews();
        const rss = toRss(
          "ChildSafety.gov.au - News (Latest)",
          LIST_URL,
          items
        );
        return rssResponse(rss);
      }

      return new Response("Not found", { status: 404 });
    } catch (err: any) {
      return jsonResponse(
        { error: err?.message || "Worker exception" }
      );
    }
  },
};
