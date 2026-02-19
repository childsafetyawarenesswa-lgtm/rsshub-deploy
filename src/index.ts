// src/index.ts
import { load } from "cheerio";

type FeedItem = {
  title: string;
  link: string;
  pubDate?: string;
  description?: string;
  guid: string;
};

function escapeXml(input: string) {
  const str = String(input ?? "");
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
      const desc = i.description
        ? `<description>${escapeXml(i.description)}</description>`
        : "";
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

function withTimeout(ms: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { controller, cancel: () => clearTimeout(id) };
}

function normalizeWhitespace(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function tryParseDate(dateText: string): Date | null {
  const d = new Date(dateText);
  if (!isNaN(d.getTime())) return d;
  return null;
}

async function fetchChildSafetyNews(): Promise<FeedItem[]> {
  const listUrl = "https://www.childsafety.gov.au/news";

  const { controller, cancel } = withTimeout(12000);
  let res: Response;

  try {
    res = await fetch(listUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-AU,en;q=0.9",
        "referer": "https://www.childsafety.gov.au/",
      },
      cf: {
        cacheTtl: 900,
        cacheEverything: false,
      } as any,
    });
  } finally {
    cancel();
  }

  if (!res.ok) {
    const bodySnippet = (await res.text()).slice(0, 800);
    throw new Error(
      `Upstream fetch failed: ${res.status} ${res.statusText}\n${bodySnippet}`
    );
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    const sample = (await res.text()).slice(0, 200);
    throw new Error(`Upstream not HTML. content-type=${contentType}\n${sample}`);
  }

  const html = await res.text();
  const $ = load(html);

  const items: FeedItem[] = [];

  const candidateLinks = $("main a[href^='/news/']").toArray();

  for (const a of candidateLinks) {
    const el = $(a);
    const href = (el.attr("href") || "").trim();
    const rawTitle = normalizeWhitespace(el.text());

    if (!href || !rawTitle) continue;
    if (href === "/news") continue;
    if (!/^\/news\/[^/?#]+\/?$/.test(href)) continue;

    const link = new URL(
      href,
      "https://www.childsafety.gov.au"
    ).toString();

    const container =
      el.closest("article").length
        ? el.closest("article")
        : el.closest("li").length
        ? el.closest("li")
        : el.closest("div").length
        ? el.closest("div")
        : el.parent();

    let pubDateText = "";
    const timeEl = container.find("time").first();
    if (timeEl.length) {
      pubDateText =
        (timeEl.attr("datetime") || "").trim() ||
        normalizeWhitespace(timeEl.text());
    }

    let snippet = "";
    const paragraphs = container
      .find("p")
      .toArray()
      .map((x) => normalizeWhitespace($(x).text()));

    if (paragraphs.length) {
      snippet =
        paragraphs.find((t) => t && t !== rawTitle) || "";
    }

    if (snippet.length > 500) {
      snippet = snippet.slice(0, 497) + "...";
    }

    items.push({
      title: rawTitle,
      link,
      pubDate: pubDateText || undefined,
      description: snippet || undefined,
      guid: `childsafety:${link}`,
    });
  }

  const deduped = Array.from(
    new Map(items.map((i) => [i.link, i])).values()
  );

  deduped.sort((a, b) => {
    const da = a.pubDate ? tryParseDate(a.pubDate) : null;
    const db = b.pubDate ? tryParseDate(b.pubDate) : null;
    if (da && db) return db.getTime() - da.getTime();
    return 0;
  });

  return deduped.slice(0, 15);
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Worker is live", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/feeds/childsafety/news") {
      const cacheKey = new Request(url.toString(), { method: "GET" });
      const cache = caches.default;

      // Serve cached immediately if present
      const cached = await cache.match(cacheKey);
      if (cached) {
        return cached;
      }

      try {
        const items = await fetchChildSafetyNews();
        const rss = toRss(
          "ChildSafety.gov.au - News (Latest)",
          "https://www.childsafety.gov.au/news",
          items
        );

        const response = new Response(rss, {
          headers: {
            "content-type": "application/rss+xml; charset=utf-8",
            "cache-control": "public, max-age=1800",
          },
        });

        await cache.put(cacheKey, response.clone());
        return response;
      } catch (err: any) {
        const stale = await cache.match(cacheKey);
        if (stale) {
          const headers = new Headers(stale.headers);
          headers.set(
            "x-feed-warning",
            "Upstream failed; served cached feed"
          );
          return new Response(stale.body, {
            status: 200,
            headers,
          });
        }

        return new Response(
          `Error generating feed:\n${err?.stack || err?.message || String(err)}`,
          {
            status: 502,
            headers: {
              "content-type": "text/plain; charset=utf-8",
            },
          }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
