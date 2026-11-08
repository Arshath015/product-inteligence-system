import { generateObject } from "ai";
import { z } from "zod";
import { withGroqRetry } from "@/lib/groq/client";
import { tavilyExtract } from "@/lib/tavily";
import { tokensFrom } from "@/lib/textTokens";
import { absolutize, fetchPageSignals, hasUsableSignal, extractOrgNames, looksLikeSiteOwner, type PageSignals } from "@/lib/pageSignals";
import type { ExtractedProductData } from "@/lib/types";

const CATEGORY_SLUGS = [
  "sofas",
  "armchairs",
  "lounge-chairs",
  "dining-chairs",
  "tables",
  "coffee-tables",
  "side-tables",
  "beds",
  "lighting",
  "accessories",
  "rugs",
  "storage",
  "outdoor",
  "other",
] as const;
type CategorySlug = (typeof CATEGORY_SLUGS)[number];

const extractionSchema = z.object({
  name: z.string().describe("The product's name/model, without the brand name prefixed"),
  brandName: z.string().nullable().describe("Manufacturer/brand name"),
  designerName: z.string().nullable().describe("Designer name if credited, else null"),
  categoryHint: z.enum(CATEGORY_SLUGS).describe("Best matching category"),
  description: z.string().nullable().describe("1-3 sentence product description"),
  materials: z.string().nullable(),
  dimensions: z.string().nullable(),
  priceText: z.string().nullable().describe("Price as displayed, with currency, or null"),
});

// Filenames/paths containing these tokens are almost never the product photo
// itself — covers newsletter/promo popups, cookie banners, ads, and site
// chrome that can end up in an image's URL even when fetchPageSignals'
// DOM-container exclusion (popup/modal containers) didn't catch it, e.g. a
// promo image sitting directly in the page body outside any named wrapper.
export const IMAGE_BLACKLIST = [
  "logo", "icon", "favicon", "sprite", "banner", "badge", "placeholder",
  "avatar", "social-share", "social_share", "og-image", "og_image",
  "default-image", "default_image", "wordmark", "brandmark",
  "newsletter", "popup", "pop-up", "modal", "subscribe", "sign-up", "signup",
  "cookie", "consent", "gdpr", "promo", "promotion", "advert", "advertisement",
  "klaviyo", "mailchimp", "privy", "sumo", "optin", "opt-in",
];

const STRUCTURAL_PATH_WORDS = new Set([
  "en", "us", "uk", "it", "fr", "de", "www", "product", "products", "p",
  "category", "categories", "collection", "collections", "shop", "store",
  "catalogue", "catalog", "page", "pages", "detail", "details", "index",
]);

/**
 * Last-resort brand fallback: when nothing on the page names a distinct
 * brand/maker (no JSON-LD brand, no byline, no dataLayer), derive one from
 * the site's own identity rather than leaving the product with no brand at
 * all — e.g. a gallery/boutique selling pieces under its own name with no
 * separate manufacturer, where "no brand found" would otherwise mean every
 * one of its pieces shows as an orphaned "Unknown brand". Prefers the JSON-LD
 * Organization name; otherwise looks for a short title segment that names
 * the site but shares no words with the product's own name — e.g. "Mint –
 * Poodle Armchair" splits into "Mint" (the site) and "Poodle Armchair" (the
 * product); "Mint" has no overlap with the product name, so it's the
 * candidate. Never invents anything: returns null if no such segment exists.
 */
function siteIdentityFallback(title: string | null, productName: string, orgNames: string[]): string | null {
  const fromOrg = orgNames.find((n) => n.trim().length > 0 && n.trim().length <= 60);
  if (fromOrg) return fromOrg.trim();

  if (!title) return null;
  const segments = title
    .split(/[|\-–—:]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length < 2) return null;
  const productTokens = new Set(tokensFrom(productName));
  const candidate = segments.find((seg) => {
    const segTokens = tokensFrom(seg);
    if (segTokens.length === 0 || segTokens.length > 4) return false;
    return segTokens.every((t) => !productTokens.has(t));
  });
  return candidate ?? null;
}

/** Tokens likely to identify THIS product: from the page title and URL path segments. */
function buildNameHints(title: string | null, url: string): string[] {
  const hints = new Set<string>();
  if (title) {
    tokensFrom(title.split(/[|\-–—]/)[0]).forEach((t) => hints.add(t));
  }
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    for (const seg of segs) {
      tokensFrom(seg.replace(/-\d+$/, "")).forEach((t) => {
        if (!STRUCTURAL_PATH_WORDS.has(t)) hints.add(t);
      });
    }
  } catch {
    // ignore
  }
  return [...hints];
}

interface ScoredImage {
  url: string;
  score: number;
}

function scoreImage(
  url: string,
  tier: number,
  hints: string[],
  brandTokens: string[],
  inProductContainer: boolean
): number {
  const lower = url.toLowerCase();
  if (IMAGE_BLACKLIST.some((k) => lower.includes(k))) return -100;

  let score = -tier * 3; // lower tier (more authoritative source) scores higher
  // A page telling us directly "this is the product gallery" outweighs
  // filename guessing — this is what keeps a newsletter-popup image (which
  // might otherwise coincidentally match a brand/name token) from ever
  // outscoring the real product photo.
  if (inProductContainer) score += 15;

  const matchedHint = hints.some((h) => lower.includes(h));
  if (matchedHint) score += 10;

  const matchedBrandOnly = !matchedHint && brandTokens.some((b) => lower.includes(b));
  if (matchedBrandOnly) score -= 6; // likely a brand lifestyle/banner shot, not this product

  if (/\d{3,4}x\d{3,4}/.test(lower)) score += 1; // explicit dimensions suggest a real asset, not a tiny icon
  return score;
}

function rankImageCandidates(
  tiers: { urls: string[]; tier: number; productContainerUrls?: Set<string> }[],
  hints: string[],
  brandTokens: string[]
): ScoredImage[] {
  const seen = new Map<string, ScoredImage>();
  for (const { urls, tier, productContainerUrls } of tiers) {
    for (const url of urls) {
      if (seen.has(url)) continue;
      const inProductContainer = productContainerUrls?.has(url) ?? false;
      seen.set(url, { url, score: scoreImage(url, tier, hints, brandTokens, inProductContainer) });
    }
  }
  return [...seen.values()]
    .filter((c) => c.score > -100)
    .sort((a, b) => b.score - a.score);
}

function galleryUrls(signals: PageSignals | null): string[] {
  return signals?.galleryImages.map((c) => c.url) ?? [];
}

function galleryProductContainerUrls(signals: PageSignals | null): Set<string> {
  return new Set((signals?.galleryImages ?? []).filter((c) => c.inProductContainer).map((c) => c.url));
}

function imagesFromJsonLd(jsonLd: unknown[], baseUrl: string): string[] {
  const urls: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj["@type"] === "Product" || obj.image) {
      const img = obj.image;
      if (typeof img === "string") {
        const abs = absolutize(img, baseUrl);
        if (abs) urls.push(abs);
      } else if (Array.isArray(img)) {
        for (const i of img) {
          if (typeof i === "string") {
            const abs = absolutize(i, baseUrl);
            if (abs) urls.push(abs);
          } else if (i && typeof i === "object" && typeof (i as Record<string, unknown>).url === "string") {
            const abs = absolutize((i as Record<string, unknown>).url as string, baseUrl);
            if (abs) urls.push(abs);
          }
        }
      } else if (img && typeof img === "object" && typeof (img as Record<string, unknown>).url === "string") {
        const abs = absolutize((img as Record<string, unknown>).url as string, baseUrl);
        if (abs) urls.push(abs);
      }
    }
    for (const key of Object.keys(obj)) {
      if (key === "@type") continue;
      const val = obj[key];
      if (Array.isArray(val)) val.forEach(visit);
      else if (val && typeof val === "object") visit(val);
    }
  };
  jsonLd.forEach(visit);
  return urls;
}

const CATEGORY_KEYWORDS: [CategorySlug, string[]][] = [
  ["sofas", ["sofa", "settee", "couch", "sectional"]],
  ["armchairs", ["armchair", "accent chair", "lounge chair", "easy chair"]],
  ["lounge-chairs", ["lounge chair", "recliner", "chaise"]],
  ["dining-chairs", ["dining chair", "chair"]],
  ["coffee-tables", ["coffee table", "cocktail table", "low table"]],
  ["side-tables", ["side table", "end table", "nightstand"]],
  ["tables", ["table", "desk"]],
  ["beds", ["bed", "headboard"]],
  ["lighting", ["lamp", "light", "lighting", "chandelier", "sconce", "pendant"]],
  ["rugs", ["rug", "carpet"]],
  ["storage", ["cabinet", "shelf", "shelving", "storage", "sideboard", "credenza", "bookcase"]],
  ["outdoor", ["outdoor", "patio", "garden"]],
  ["accessories", ["vase", "accessory", "decor", "mirror", "tray"]],
];

/** Cheap keyword match against a free-text product-type string — no LLM needed. */
function guessCategorySlug(text: string | null | undefined): CategorySlug {
  if (!text) return "other";
  const lower = text.toLowerCase();
  for (const [slug, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return slug;
  }
  return "other";
}

interface JsonLdProduct {
  name: string;
  brandName: string | null;
  description: string | null;
  priceText: string | null;
  categoryHint: CategorySlug;
  images: string[];
}

function textOf(val: unknown): string | null {
  if (typeof val === "string") return val.trim() || null;
  if (val && typeof val === "object") {
    const name = (val as Record<string, unknown>).name;
    if (typeof name === "string") return name.trim() || null;
  }
  return null;
}

/**
 * Pulls a complete product record straight out of schema.org JSON-LD when
 * the page provides one — no model call needed. Returns null if the
 * JSON-LD doesn't actually describe a single product with a name.
 */
function productFromJsonLd(jsonLd: unknown[], baseUrl: string): JsonLdProduct | null {
  let found: Record<string, unknown> | null = null;
  const visit = (node: unknown) => {
    if (found || !node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj["@type"] === "Product" && typeof obj.name === "string" && obj.name.trim()) {
      found = obj;
      return;
    }
    if (Array.isArray(obj["@graph"])) (obj["@graph"] as unknown[]).forEach(visit);
  };
  jsonLd.forEach(visit);
  if (!found) return null;
  const p = found as Record<string, unknown>;

  const name = (p.name as string).trim();
  const brandName = textOf(p.brand) ?? textOf(p.manufacturer);
  const description = typeof p.description === "string" ? p.description.trim().slice(0, 600) : null;

  let priceText: string | null = null;
  const offers = p.offers;
  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (offer && typeof offer === "object") {
    const o = offer as Record<string, unknown>;
    const price = o.price;
    const currency = o.priceCurrency;
    if (price != null) priceText = currency ? `${currency} ${price}` : String(price);
  }

  const categorySource = [textOf(p.category), name, description ?? ""].filter(Boolean).join(" ");
  const images = imagesFromJsonLd([p], baseUrl);

  return {
    name,
    brandName,
    description,
    priceText,
    categoryHint: guessCategorySlug(categorySource),
    images,
  };
}

/**
 * Pulls product signals from a URL. Tries a direct fetch first; if that
 * fails outright (network/DNS/HTTP error) or succeeds but yields no real
 * content (JS-only page, bot wall), escalates to Tavily's extraction
 * service — this is also ALTOSSA's answer to "JavaScript-rendered pages":
 * rather than embedding a headless browser in the app, Tavily's crawler
 * (which does render JS) is the fallback layer for pages a plain fetch
 * can't read. If neither method produces anything usable, this throws
 * instead of asking the model to invent a product from nothing — callers
 * (lib/ingest.ts) must not create a catalogue record in that case.
 *
 * `preloaded` lets a caller that already fetched the page (e.g. the bulk
 * classifier) hand the signals over instead of fetching twice.
 */
export async function extractProductFromUrl(
  url: string,
  preloaded?: PageSignals | null
): Promise<ExtractedProductData> {
  let signals: PageSignals | null = preloaded ?? null;
  let fallbackText: string | null = null;
  let fallbackImages: string[] = [];
  let finalUrl = signals?.finalUrl ?? url;

  if (!signals) {
    try {
      const fetched = await fetchPageSignals(url);
      finalUrl = fetched.finalUrl;
      if (hasUsableSignal(fetched)) signals = fetched;
    } catch {
      // network/DNS/HTTP failure — fall through to the Tavily escalation below
    }
  }

  if (!signals) {
    const [extracted] = await tavilyExtract([url]).catch(() => []);
    if (extracted) {
      fallbackText = extracted.raw_content?.slice(0, 6000) ?? null;
      fallbackImages = extracted.images ?? [];
    }
  }

  if (!hasUsableSignal(signals) && !((fallbackText && fallbackText.length > 150) || fallbackImages.length > 0)) {
    throw new Error(
      "Couldn't retrieve any readable content from that page — it may be unreachable, blocked, or require JavaScript rendering that isn't supported."
    );
  }

  // Fast path: schema.org JSON-LD already gives us a named product with at
  // least one image — skip the model call entirely.
  if (signals) {
    const fromJsonLd = productFromJsonLd(signals.jsonLd, finalUrl);
    if (fromJsonLd && fromJsonLd.images.length > 0) {
      const host = hostOf(finalUrl);
      // JSON-LD frequently omits `brand`/`manufacturer` even on otherwise
      // complete product schemas — fall back to a byline/dataLayer signal
      // pulled from the page itself rather than reporting no brand at all.
      // Some sites' JSON-LD also literally sets brand to the retailer's own
      // name (a seller/brand mixup in their schema), so apply the same
      // site-owner guard here as the model path does below.
      const orgNames = extractOrgNames(signals.jsonLd);
      const jsonLdBrandIsSiteOwner = fromJsonLd.brandName ? looksLikeSiteOwner(fromJsonLd.brandName, host, orgNames) : false;
      const brandName =
        (jsonLdBrandIsSiteOwner ? null : fromJsonLd.brandName) ??
        signals.byline.brandName ??
        siteIdentityFallback(signals.title, fromJsonLd.name, orgNames);
      const designerName = signals.byline.designerName;
      const nameHints = buildNameHints(signals.title, finalUrl);
      const hints = Array.from(new Set([...nameHints, ...tokensFrom(fromJsonLd.name)]));
      const brandTokens = brandName ? tokensFrom(brandName) : host ? tokensFrom(host) : [];
      const ranked = rankImageCandidates(
        [
          { urls: fromJsonLd.images, tier: 0 },
          { urls: galleryUrls(signals), tier: 1, productContainerUrls: galleryProductContainerUrls(signals) },
          { urls: signals.ogImages, tier: 2 },
        ],
        hints,
        brandTokens
      );
      const imageUrls = ranked.slice(0, 10).map((c) => c.url);
      return {
        name: fromJsonLd.name,
        brandName,
        designerName,
        categoryHint: fromJsonLd.categoryHint,
        description: fromJsonLd.description,
        materials: null,
        dimensions: null,
        priceText: fromJsonLd.priceText,
        imageUrls,
        imagesLowConfidence: ranked.length === 0 || ranked[0].score < 12,
        canonicalUrl: signals.canonicalUrl ?? finalUrl,
        sourceDomain: host,
      };
    }
  }

  const jsonLdImages = signals ? imagesFromJsonLd(signals.jsonLd, finalUrl) : [];
  const nameHints = buildNameHints(signals?.title ?? null, finalUrl);

  const context = signals
    ? [
        `Page title: ${signals.title ?? ""}`,
        `Meta description: ${signals.metaDescription ?? ""}`,
        signals.jsonLd.length ? `JSON-LD data: ${JSON.stringify(signals.jsonLd).slice(0, 3000)}` : "",
        signals.byline.brandName ? `A byline elsewhere on the page names "${signals.byline.brandName}" as the brand/maker — use it for brandName unless the page content clearly says otherwise.` : "",
        signals.byline.designerName ? `A byline elsewhere on the page names "${signals.byline.designerName}" as the individual designer — use it for designerName unless the page content clearly says otherwise.` : "",
        `Page text: ${signals.textSnippet}`,
      ]
        .filter(Boolean)
        .join("\n\n")
    : `Page text: ${fallbackText ?? ""}`;

  const { object } = await withGroqRetry((model) =>
    generateObject({
      model,
      schema: extractionSchema,
      prompt: `Extract structured product information for a luxury furniture/interior-design catalogue from the following webpage content. The source URL is ${url}. If a value is not clearly present, use null (or "other" for categoryHint). If the content doesn't actually describe a specific product at all, return an empty string for name — do not invent one. Distinguish the product's brand/manufacturer from the retailer or marketplace selling it (the website itself is often just the retailer, not the brand) and from the individual designer credited for it, when those are different.\n\n${context}`,
    })
  );

  if (!object.name.trim()) {
    throw new Error("Couldn't identify a specific product from that page's content.");
  }

  const host = hostOf(finalUrl);
  // The model sometimes infers the retailer's own name as the brand (e.g.
  // from a page title like "Mint – Poodle Armchair") when no real
  // product-specific brand is stated anywhere — never trust that guess.
  const orgNames = signals ? extractOrgNames(signals.jsonLd) : [];
  const modelBrandIsSiteOwner = object.brandName ? looksLikeSiteOwner(object.brandName, host, orgNames) : false;
  const brandName =
    (modelBrandIsSiteOwner ? null : object.brandName) ??
    signals?.byline.brandName ??
    siteIdentityFallback(signals?.title ?? null, object.name, orgNames);
  const designerName = object.designerName ?? signals?.byline.designerName ?? null;

  // Re-score with the model's resolved name/brand now that we have them —
  // more precise than the page-title/URL-slug hints alone.
  const hints = Array.from(new Set([...nameHints, ...tokensFrom(object.name)]));
  const brandTokens = brandName ? tokensFrom(brandName) : host ? tokensFrom(host) : [];

  const ranked = rankImageCandidates(
    [
      { urls: jsonLdImages, tier: 0 },
      { urls: galleryUrls(signals), tier: 1, productContainerUrls: galleryProductContainerUrls(signals) },
      { urls: [...(signals?.ogImages ?? []), ...fallbackImages], tier: 2 },
    ],
    hints,
    brandTokens
  );

  const imageUrls = ranked.slice(0, 10).map((c) => c.url);
  // No candidate matched the product's own name/category at all — the only
  // images we have are generic (brand banner, lifestyle shot, etc.), so
  // whatever we pick should get a vision sanity-check before being saved.
  const imagesLowConfidence = ranked.length === 0 || ranked[0].score < 12;

  return {
    name: object.name,
    brandName,
    designerName,
    categoryHint: object.categoryHint,
    description: object.description,
    materials: object.materials,
    dimensions: object.dimensions,
    priceText: object.priceText,
    imageUrls,
    imagesLowConfidence,
    canonicalUrl: signals?.canonicalUrl ?? finalUrl,
    sourceDomain: host,
  };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
