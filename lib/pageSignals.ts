import * as cheerio from "cheerio";

export const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
};

export function absolutize(url: string, base: string): string | null {
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

export interface PageSignals {
  html: string;
  finalUrl: string;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  ogImages: string[];
  galleryImages: string[];
  jsonLd: unknown[];
  jsonLdTypes: string[];
  links: { href: string; text: string }[];
  textSnippet: string;
}

/**
 * One fetch + parse per URL, shared by classification, product extraction,
 * and link discovery — so a single bulk-ingest URL never gets fetched
 * twice. Throws on network/HTTP failure; callers decide the fallback
 * (Tavily extract, mark failed, etc.).
 */
export async function fetchPageSignals(url: string): Promise<PageSignals> {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
  const finalUrl = res.url || url;
  if (!res.ok) {
    throw new Error(`Fetch failed with status ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim() || null;
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    null;
  const canonicalRaw = $('link[rel="canonical"]').attr("href");
  const canonicalUrl = canonicalRaw ? absolutize(canonicalRaw, finalUrl) : null;

  const ogImages: string[] = [];
  $('meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"]').each((_, el) => {
    const content = $(el).attr("content");
    const abs = content ? absolutize(content, finalUrl) : null;
    if (abs) ogImages.push(abs);
  });

  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) jsonLd.push(...parsed);
      else jsonLd.push(parsed);
    } catch {
      // ignore malformed JSON-LD blocks
    }
  });
  const jsonLdTypes: string[] = [];
  const collectTypes = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") jsonLdTypes.push(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && jsonLdTypes.push(x));
    if (Array.isArray(obj["@graph"])) (obj["@graph"] as unknown[]).forEach(collectTypes);
  };
  jsonLd.forEach(collectTypes);

  const galleryImages: string[] = [];
  $("img").each((_, el) => {
    const raw =
      $(el).attr("src") ||
      $(el).attr("data-src") ||
      $(el).attr("data-lazy-src") ||
      $(el).attr("data-original") ||
      ($(el).attr("srcset") || "").split(",")[0]?.trim().split(" ")[0];
    if (!raw || raw.startsWith("data:")) return;
    const abs = absolutize(raw, finalUrl);
    if (abs) galleryImages.push(abs);
  });

  const links: { href: string; text: string }[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    const abs = absolutize(href, finalUrl);
    if (!abs) return;
    links.push({ href: abs, text: $(el).text().trim().slice(0, 80) });
  });

  const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 6000);

  return {
    html,
    finalUrl,
    title,
    metaDescription,
    canonicalUrl,
    ogImages,
    galleryImages,
    jsonLd,
    jsonLdTypes,
    links,
    textSnippet: bodyText,
  };
}

/**
 * A direct fetch can return 200 with an HTML shell that has no real
 * content — a JS-rendered SPA page before hydration, or a bot-detection
 * page that doesn't bother 403ing. Either way there's nothing here worth
 * sending to the model.
 */
export function hasUsableSignal(signals: PageSignals | null): boolean {
  if (!signals) return false;
  const substantialText = signals.textSnippet.length > 150;
  const hasMeta = Boolean(signals.title || signals.metaDescription);
  const hasStructuredData = signals.jsonLd.length > 0;
  const hasImages = signals.ogImages.length > 0 || signals.galleryImages.length > 0;
  return substantialText || hasMeta || hasStructuredData || hasImages;
}
