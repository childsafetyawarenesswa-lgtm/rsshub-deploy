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

// Best-effort parse date strings. If it fails, we keep original text in RSS.
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
        // Polite UA (some sites block blank/unknown UAs)
        "user-agent": "childsafetyawarenesswa-rss-poc/1.0 (+contact: admin@example.com)",
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-AU,en;q=0.9",
      },
      // Cloudflare Workers hinting
      cf: {
        cacheTtl: 900,
        cacheEverything: false,
      } as any,
    });
  } finally {
    cancel();
  }

  if (!res.ok) {
    const ct = res.headers.get("content-type") || "";
    const ray = res.headers.get("cf-ray") || "";
    const server = res.headers.get("server") || "";
    const bodySnippet = (await res.text()).slice(0, 800);

    throw new Error(
      `Upstream fetch failed: ${res.status} ${res.statusText}\n` +
      `content-type=${ct}\nserver=${server}\ncf-ray=${ray}\n` +
      `body-snippet:\n${bodySnippet}`
    );
  }


  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    const sample = (await res.text()).slice(0, 200);
    throw new Error(`Upstream not HTML (content-type=${contentType}). Sample: ${sample}`);
  }

  const html = await res.text();
  const $ = load(html);

  // Strategy:
  // 1) Only consider /news/<slug> links inside <main>
  // 2) Exclude obvious nav/footer noise by requiring a "card/container" ancestor,
  //    falling back to safe defaults if we can't find snippet/date.
  // 3) Deduplicate and cap count.

  const items: FeedItem[] = [];

  // Only capture direct news article links, not the /news listing or deeper paths.
  // Adjust if the site uses deeper paths.
  const candidateLinks = $("main a[href^='/news/']").toArray();

  for (const a of candidateLinks) {
    const el = $(a);
    const href = (el.attr("href") || "").trim();
    const rawTitle = normalizeWhitespace(el.text());

    if (!href || !rawTitle) continue;
    if (href === "/news") continue;

    // Keep only /news/<something> (avoid /news?x= and /news/category/... if present)
    if (!/^\/news\/[^/?#]+\/?$/.test(href)) continue;

    const link = new URL(href, "https://www.childsafety.gov.au").toString();

    // Find a “card-ish” container near the link (best effort)
    // Common patterns: article, li, div with some class, etc.
    const container =
      el.closest("article").length
        ? el.closest("article")
        : el.closest("li").length
          ? el.closest("li")
          : el.closest("div").length
            ? el.closest("div")
            : el.parent();

    // Best-effort date:
    // - look for <time datetime="..."> or a text node containing a date-like string
    let pubDateText = "";
    const timeEl = container.find("time").first();
    if (timeEl.length) {
      pubDateText =
        (timeEl.attr("datetime") || "").trim() ||
        normalizeWhitespace(timeEl.text());
    } else {
      // fallback: try find something that looks like a date in container text,
      // but keep it conservative to avoid grabbing whole page text.
      const text = normalizeWhitespace(container.text());
      const m = text.match(
        /\b(?:\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{4}-\d{2}-\d{2})\b/
      );
      pubDateText = m?.[0] || "";
    }

    // Best-effort snippet:
    // prefer first paragraph that isn't the title, else use trimmed container text.
    let snippet = "";
    const p = container.find("p").toArray().map((x) => normalizeWhitespace($(x).text()));
    if (p.length) {
      // pick first non-empty paragraph that isn't identical to title
      snippet = p.find((t) => t && t !== rawTitle) || "";
    } else {
      const text = normalizeWhitespace(container.text());
      // remove title from front if it’s included
      snippet = text.startsWith(rawTitle) ? normalizeWhitespace(text.slice(rawTitle.length)) : text;
    }

    // Trim snippet to something sane
    if (snippet.length > 500) snippet = snippet.slice(0, 497) + "...";

    const guid = `childsafety:${link}`;

    items.push({
      title: rawTitle,
      link,
      pubDate: pubDateText || undefined,
      description: snippet || undefined,
      guid,
    });
  }

  // Deduplicate by link
  const deduped = Array.from(new Map(items.map((i) => [i.link, i])).values());

  // Optional: sort by parsed date desc when possible (keeps “latest” first)
  deduped.sort((a, b) => {
    const da = a.pubDate ? tryParseDate(a.pubDate) : null;
    const db = b.pubDate ? tryParseDate(b.pubDate) : null;
    if (da && db) return db.getTime() - da.getTime();
    if (db && !da) return 1;
    if (da && !db) return -1;
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
            "cache-control": "public, max-age=1800",
          },
        });
      } catch (err: any) {
        // IMPORTANT: include stack where available; helps diagnose 520 causes instantly
        const msg = err?.stack || err?.message || String(err);
        return new Response(`Error generating feed:\n${msg}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
