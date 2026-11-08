import * as cheerio from "cheerio";
import { generateObject } from "ai";
import { z } from "zod";
import { withGroqRetry } from "@/lib/groq/client";
import { tavilyExtract } from "@/lib/tavily";
import { tokensFrom } from "@/lib/textTokens";
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

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
};

function absolutize(url: string, base: string): string | null {
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

interface PageSignals {
  html: string | null;
  finalUrl: string;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  ogImages: string[];
  galleryImages: string[];
  jsonLd: unknown[];
  textSnippet: string;
}

// Filenames/paths containing these tokens are almost never the product photo itself.
const IMAGE_BLACKLIST = [
  "logo", "icon", "favicon", "sprite", "banner", "badge", "placeholder",
  "avatar", "social-share", "social_share", "og-image", "og_image",
  "default-image", "default_image", "wordmark", "brandmark",
];

const STRUCTURAL_PATH_WORDS = new Set([
  "en", "us", "uk", "it", "fr", "de", "www", "product", "products", "p",
  "category", "categories", "collection", "collections", "shop", "store",
  "catalogue", "catalog", "page", "pages", "detail", "details", "index",
]);

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

function scoreImage(url: string, tier: number, hints: string[], brandTokens: string[]): number {
  const lower = url.toLowerCase();
  if (IMAGE_BLACKLIST.some((k) => lower.includes(k))) return -100;

  let score = -tier * 3; // lower tier (more authoritative source) scores higher
  const matchedHint = hints.some((h) => lower.includes(h));
  if (matchedHint) score += 10;

  const matchedBrandOnly = !matchedHint && brandTokens.some((b) => lower.includes(b));
  if (matchedBrandOnly) score -= 6; // likely a brand lifestyle/banner shot, not this product

  if (/\d{3,4}x\d{3,4}/.test(lower)) score += 1; // explicit dimensions suggest a real asset, not a tiny icon
  return score;
}

function rankImageCandidates(
  tiers: { urls: string[]; tier: number }[],
  hints: string[],
  brandTokens: string[]
): ScoredImage[] {
  const seen = new Map<string, ScoredImage>();
  for (const { urls, tier } of tiers) {
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.set(url, { url, score: scoreImage(url, tier, hints, brandTokens) });
    }
  }
  return [...seen.values()]
    .filter((c) => c.score > -100)
    .sort((a, b) => b.score - a.score);
}

async function fetchPageSignals(url: string): Promise<PageSignals> {
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
  });
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
  $('meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"]').each(
    (_, el) => {
      const content = $(el).attr("content");
      const abs = content ? absolutize(content, finalUrl) : null;
      if (abs) ogImages.push(abs);
    }
  );

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

  // Real <img> tags on the page — the only signal available on sites that
  // don't mark products up with JSON-LD and only expose a generic og:image.
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
    textSnippet: bodyText,
  };
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

/**
 * A direct fetch can return 200 with an HTML shell that has no real
 * content — a JS-rendered SPA page before hydration, or a bot-detection
 * page that doesn't bother 403ing. Either way there's nothing here worth
 * sending to the model, so this is treated the same as a failed fetch and
 * escalates to the next extraction method.
 */
function hasUsableSignal(
  signals: PageSignals | null,
  fallbackText: string | null,
  fallbackImages: string[]
): boolean {
  if (signals) {
    const substantialText = signals.textSnippet.length > 150;
    const hasMeta = Boolean(signals.title || signals.metaDescription);
    const hasStructuredData = signals.jsonLd.length > 0;
    const hasImages = signals.ogImages.length > 0 || signals.galleryImages.length > 0;
    return substantialText || hasMeta || hasStructuredData || hasImages;
  }
  return Boolean((fallbackText && fallbackText.length > 150) || fallbackImages.length > 0);
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
 */
export async function extractProductFromUrl(url: string): Promise<ExtractedProductData> {
  let signals: PageSignals | null = null;
  let fallbackText: string | null = null;
  let fallbackImages: string[] = [];
  let finalUrl = url;

  try {
    const fetched = await fetchPageSignals(url);
    finalUrl = fetched.finalUrl;
    if (hasUsableSignal(fetched, null, [])) {
      signals = fetched;
    }
  } catch {
    // network/DNS/HTTP failure — fall through to the Tavily escalation below
  }

  if (!signals) {
    const [extracted] = await tavilyExtract([url]).catch(() => []);
    if (extracted) {
      fallbackText = extracted.raw_content?.slice(0, 6000) ?? null;
      fallbackImages = extracted.images ?? [];
    }
  }

  if (!hasUsableSignal(signals, fallbackText, fallbackImages)) {
    throw new Error(
      "Couldn't retrieve any readable content from that page — it may be unreachable, blocked, or require JavaScript rendering that isn't supported."
    );
  }

  const jsonLdImages = signals ? imagesFromJsonLd(signals.jsonLd, finalUrl) : [];
  const nameHints = buildNameHints(signals?.title ?? null, finalUrl);

  const context = signals
    ? [
        `Page title: ${signals.title ?? ""}`,
        `Meta description: ${signals.metaDescription ?? ""}`,
        signals.jsonLd.length ? `JSON-LD data: ${JSON.stringify(signals.jsonLd).slice(0, 3000)}` : "",
        `Page text: ${signals.textSnippet}`,
      ]
        .filter(Boolean)
        .join("\n\n")
    : `Page text: ${fallbackText ?? ""}`;

  const { object } = await withGroqRetry((model) =>
    generateObject({
      model,
      schema: extractionSchema,
      prompt: `Extract structured product information for a luxury furniture/interior-design catalogue from the following webpage content. The source URL is ${url}. If a value is not clearly present, use null (or "other" for categoryHint). If the content doesn't actually describe a specific product at all, return an empty string for name — do not invent one.\n\n${context}`,
    })
  );

  if (!object.name.trim()) {
    throw new Error("Couldn't identify a specific product from that page's content.");
  }

  const host = (() => {
    try {
      return new URL(finalUrl).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  })();

  // Re-score with the model's resolved name/brand now that we have them —
  // more precise than the page-title/URL-slug hints alone.
  const hints = Array.from(new Set([...nameHints, ...tokensFrom(object.name)]));
  const brandTokens = object.brandName ? tokensFrom(object.brandName) : host ? tokensFrom(host) : [];

  const ranked = rankImageCandidates(
    [
      { urls: jsonLdImages, tier: 0 },
      { urls: signals?.galleryImages ?? [], tier: 1 },
      { urls: [...(signals?.ogImages ?? []), ...fallbackImages], tier: 2 },
    ],
    hints,
    brandTokens
  );

  const imageUrls = ranked.slice(0, 10).map((c) => c.url);
  // No candidate matched the product's own name/category at all — the only
  // images we have are generic (brand banner, lifestyle shot, etc.), so
  // whatever we pick should get a vision sanity-check before being saved.
  const imagesLowConfidence = ranked.length === 0 || ranked[0].score < 5;

  return {
    name: object.name,
    brandName: object.brandName,
    designerName: object.designerName,
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
