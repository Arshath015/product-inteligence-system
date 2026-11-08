import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

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

export interface ImageCandidate {
  url: string;
  alt: string | null;
  /** Inside a container whose id/class/itemtype names it as product imagery (strong positive signal). */
  inProductContainer: boolean;
  /** Inside a container identifiable as a popup/newsletter/cookie-banner/ad/nav chrome (hard exclusion). */
  inExcludedContainer: boolean;
}

export interface PageSignals {
  html: string;
  finalUrl: string;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  ogImages: string[];
  galleryImages: ImageCandidate[];
  jsonLd: unknown[];
  jsonLdTypes: string[];
  links: { href: string; text: string }[];
  textSnippet: string;
}

// Containers that are never the product itself — promotional/consent/site-chrome
// overlays. Matched against the combined id+class of an image and every
// ancestor, so a delayed newsletter popup that's already in the DOM (just
// hidden until a JS timer reveals it) is excluded the same as a visible one.
const EXCLUDED_CONTAINER_KEYWORDS = [
  "newsletter", "popup", "pop-up", "modal", "subscribe", "sign-up", "signup",
  "cookie", "consent", "gdpr", "overlay", "lightbox", "dialog",
  "promo", "promotion", "advert", "advertisement", "banner", "announcement-bar", "sticky-bar",
  "header", "footer", "klaviyo", "mailchimp", "privy", "sumo", "optin",
  "social-share", "cart-drawer", "mini-cart", "chat-widget",
];

// Containers that explicitly identify themselves as holding the product's
// own imagery — a strong positive signal regardless of filename.
const PRODUCT_CONTAINER_KEYWORDS = [
  "product-image", "product-images", "product-gallery", "product-photo",
  "product-photos", "product-media", "pdp-image", "gallery", "main-image",
  "hero-image", "item-image", "product-detail", "product-slider", "product-carousel",
];

function containerFlags($: CheerioAPI, el: Cheerio<AnyNode>): {
  inProductContainer: boolean;
  inExcludedContainer: boolean;
} {
  const chain = [el, ...el.parents().toArray().map((p) => $(p))];
  let inProductContainer = false;
  let inExcludedContainer = false;
  for (const node of chain) {
    const idClass = `${node.attr("id") ?? ""} ${node.attr("class") ?? ""}`.toLowerCase();
    const itemtype = (node.attr("itemtype") ?? "").toLowerCase();
    if (!inExcludedContainer && EXCLUDED_CONTAINER_KEYWORDS.some((k) => idClass.includes(k))) {
      inExcludedContainer = true;
    }
    if (!inProductContainer && (PRODUCT_CONTAINER_KEYWORDS.some((k) => idClass.includes(k)) || itemtype.includes("product"))) {
      inProductContainer = true;
    }
  }
  // An exclusion always wins — a "gallery" inside a "newsletter-popup" is
  // still part of the popup.
  if (inExcludedContainer) inProductContainer = false;
  return { inProductContainer, inExcludedContainer };
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

  const galleryImages: ImageCandidate[] = [];
  $("img").each((_, el) => {
    const node = $(el);
    const raw =
      node.attr("src") ||
      node.attr("data-src") ||
      node.attr("data-lazy-src") ||
      node.attr("data-original") ||
      (node.attr("srcset") || "").split(",")[0]?.trim().split(" ")[0];
    if (!raw || raw.startsWith("data:")) return;
    const abs = absolutize(raw, finalUrl);
    if (!abs) return;
    const { inProductContainer, inExcludedContainer } = containerFlags($, node);
    // Hard-drop anything sitting inside a known popup/consent/chrome
    // container — never even a candidate, regardless of filename.
    if (inExcludedContainer) return;
    galleryImages.push({ url: abs, alt: node.attr("alt")?.trim() || null, inProductContainer, inExcludedContainer });
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
