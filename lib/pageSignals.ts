import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { tokensFrom } from "@/lib/textTokens";

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
  /** Designer/brand names pulled from a page byline, ecommerce dataLayer, or
   * description text — a fallback signal for when JSON-LD itself omits
   * `brand`/`manufacturer` (common even on well-structured product pages).
   * Never the retailer/site's own name — see `looksLikeSiteOwner`. */
  byline: BylineSignals;
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

// Matches element class/id tokens that mark a byline as naming the
// individual DESIGNER credited for the piece — e.g. "designer-name",
// "designer-single", and the common real-world typo "desinger-single"
// (swapped letters). Deliberately not required to end in "-name": themes
// label a single designer byline element many ways, and in practice the
// first such element on a product page is reliably the byline itself.
const DESIGNER_CLASS_PATTERN = /des(ign|ing)er/i;

// Matches element class/id tokens that mark a byline as naming the
// commercial brand/manufacturer/maker/vendor — e.g. "pp-maker-name",
// "brand-name", "vendor-name". Kept to a tighter "-name" suffix than the
// designer pattern since "brand"/"maker"/"vendor" alone are common words
// that show up in unrelated site chrome (nav, footer links).
const BRAND_CLASS_PATTERN = /(maker|brand|vendor|artist|creator)s?-?name/i;

export function extractOrgNames(jsonLd: unknown[]): string[] {
  const names: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if ((obj["@type"] === "Organization" || obj["@type"] === "WebSite") && typeof obj.name === "string") {
      names.push(obj.name);
    }
    for (const key of Object.keys(obj)) {
      if (key === "@type") continue;
      const val = obj[key];
      if (Array.isArray(val)) val.forEach(visit);
      else if (val && typeof val === "object") visit(val);
    }
  };
  jsonLd.forEach(visit);
  return names;
}

/**
 * True if `candidate` is just the site/retailer's own name rather than a
 * distinct brand/designer — compared against the hostname and any
 * Organization/WebSite names found in the page's own JSON-LD. Never trust a
 * byline-style signal that turns out to just be "by <this website>".
 */
export function looksLikeSiteOwner(candidate: string, host: string | null, orgNames: string[]): boolean {
  const cTokens = tokensFrom(candidate);
  if (cTokens.length === 0) return true;
  const overlapRatio = (tokens: string[]): number => {
    if (tokens.length === 0) return 0;
    const set = new Set(tokens);
    const overlap = cTokens.filter((t) => set.has(t)).length;
    return overlap / Math.min(cTokens.length, tokens.length);
  };
  if (host && overlapRatio(tokensFrom(host)) >= 0.8) return true;
  return orgNames.some((org) => overlapRatio(tokensFrom(org)) >= 0.8);
}

export interface BylineSignals {
  /** A commercial brand/manufacturer/maker name — distinct from the individual designer and from the retailer. */
  brandName: string | null;
  /** An individual designer credited for the piece. */
  designerName: string | null;
}

// Trigger words that plausibly introduce a "by <name>" authorship phrase
// about the item itself — as opposed to "Established in 1998 by ..." or
// other retailer/company-history prose that happens to contain "by".
const AUTHORSHIP_TRIGGERS = ["designed", "created", "crafted", "made", "piece", "handmade", "handcrafted"];

/**
 * Pulls designer/brand byline signals out of the page — used as a fallback
 * when JSON-LD doesn't carry a `brand`/`manufacturer` field, which is common
 * even on otherwise well-structured product pages (the brand/designer is
 * only in a visible byline, an ecommerce analytics dataLayer, or prose).
 * Distinguishes an individual DESIGNER byline from a commercial
 * BRAND/maker/vendor byline so the two are never conflated, and checks every
 * candidate against the site's own name so the retailer is never mistaken
 * for either.
 */
function extractBylineSignals(
  $: CheerioAPI,
  html: string,
  host: string | null,
  jsonLd: unknown[],
  metaDescription: string | null,
  title: string | null
): BylineSignals {
  const orgNames = extractOrgNames(jsonLd);
  const accept = (candidate: string | undefined | null): string | null => {
    const trimmed = candidate?.trim();
    if (!trimmed || trimmed.length > 60) return null;
    if (looksLikeSiteOwner(trimmed, host, orgNames)) return null;
    return trimmed;
  };

  let designerName: string | null = null;
  let brandName: string | null = null;
  $("a, span, div, p, h1, h2, h3, h4").each((_, el) => {
    if (designerName && brandName) return false;
    const node = $(el);
    const idClass = `${node.attr("id") ?? ""} ${node.attr("class") ?? ""}`.toLowerCase();
    if (!designerName && DESIGNER_CLASS_PATTERN.test(idClass)) {
      const found = accept(node.text());
      if (found) designerName = found;
    }
    if (!brandName && BRAND_CLASS_PATTERN.test(idClass)) {
      const found = accept(node.text());
      if (found) brandName = found;
    }
  });

  if (!brandName) {
    const dataLayerMatch = html.match(/item_brand["']?\s*:\s*["']([^"'{}]{1,80})["']/i);
    brandName = accept(dataLayerMatch?.[1]);
  }

  // A "by <name>" phrase in the description is only trustworthy as a
  // product-authorship signal when it's actually introduced in that
  // context — e.g. "the Terra Chair by Tom Blackmore" or "designed by
  // Tom Blackmore" — not "Established in 1998 by <gallery founder>", which
  // is prose about the retailer's own history and just happens to contain
  // "by". Require the text right before the match to reference either the
  // product's own title or an authorship trigger word.
  if (!brandName && !designerName && metaDescription) {
    const titleTokens = new Set(title ? tokensFrom(title) : []);
    const re = /\bby\s+([A-Z][A-Za-z0-9&.'’\- ]{1,50}?)(?:,|\.|\s+exclusively|\s+available|$)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(metaDescription))) {
      const precedingContext = metaDescription.slice(Math.max(0, match.index - 60), match.index).toLowerCase();
      const precedingTokens = tokensFrom(precedingContext);
      const hasTitleOverlap = precedingTokens.some((t) => titleTokens.has(t));
      const hasTrigger = AUTHORSHIP_TRIGGERS.some((w) => precedingContext.includes(w));
      if (hasTitleOverlap || hasTrigger) {
        const found = accept(match[1]);
        if (found) {
          brandName = found;
          break;
        }
      }
    }
  }

  return { brandName, designerName };
}

/** Picks the highest-resolution URL from a `srcset`-style attribute ("url 400w, url 800w, ..."). */
function bestFromSrcset(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let best: { url: string; size: number } | null = null;
  for (const entry of value.split(",")) {
    const [url, descriptor] = entry.trim().split(/\s+/);
    if (!url) continue;
    const size = descriptor ? parseFloat(descriptor) : 0;
    if (!best || size > best.size) best = { url, size };
  }
  return best?.url;
}

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
    // Lazy-load attributes take priority over `src` — a lazy-loaded image's
    // `src` is near-universally a blank/placeholder data: URI (1x1 pixel or
    // empty SVG) until JS swaps it in, so checking `src` first means the
    // OR-chain stops on a worthless placeholder and never reaches the real
    // URL. Covers the common conventions plus NitroPack's `nitro-lazy-*`
    // (a widely-used WordPress performance plugin, not site-specific).
    const raw =
      node.attr("data-src") ||
      node.attr("data-lazy-src") ||
      node.attr("data-original") ||
      node.attr("nitro-lazy-src") ||
      (node.attr("src") && !node.attr("src")!.startsWith("data:") ? node.attr("src") : undefined) ||
      bestFromSrcset(node.attr("nitro-lazy-srcset")) ||
      bestFromSrcset(node.attr("data-srcset")) ||
      bestFromSrcset(node.attr("srcset"));
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

  let host: string | null = null;
  try {
    host = new URL(finalUrl).hostname.replace(/^www\./, "");
  } catch {
    // ignore
  }
  const byline = extractBylineSignals($, html, host, jsonLd, metaDescription, title);

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
    byline,
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
