import * as cheerio from "cheerio";
import { generateObject } from "ai";
import { z } from "zod";
import { withGroqRetry } from "@/lib/groq/client";
import { tavilyExtract } from "@/lib/tavily";
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
  jsonLd: unknown[];
  textSnippet: string;
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

  const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 6000);

  return {
    html,
    finalUrl,
    title,
    metaDescription,
    canonicalUrl,
    ogImages,
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
 * Pulls product signals from a URL, falling back to Tavily's extraction
 * service when the site blocks direct fetches, then asks the Groq text
 * model to normalize everything into a structured record.
 */
export async function extractProductFromUrl(url: string): Promise<ExtractedProductData> {
  let signals: PageSignals | null = null;
  let fallbackText: string | null = null;
  let fallbackImages: string[] = [];
  let finalUrl = url;

  try {
    signals = await fetchPageSignals(url);
    finalUrl = signals.finalUrl;
  } catch {
    const [extracted] = await tavilyExtract([url]).catch(() => []);
    if (extracted) {
      fallbackText = extracted.raw_content?.slice(0, 6000) ?? null;
      fallbackImages = extracted.images ?? [];
    }
  }

  const jsonLdImages = signals ? imagesFromJsonLd(signals.jsonLd, finalUrl) : [];
  const candidateImages = Array.from(
    new Set([...jsonLdImages, ...(signals?.ogImages ?? []), ...fallbackImages])
  ).slice(0, 8);

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
      prompt: `Extract structured product information for a luxury furniture/interior-design catalogue from the following webpage content. The source URL is ${url}. If a value is not clearly present, use null (or "other" for categoryHint).\n\n${context}`,
    })
  );

  const host = (() => {
    try {
      return new URL(finalUrl).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  })();

  return {
    name: object.name,
    brandName: object.brandName,
    designerName: object.designerName,
    categoryHint: object.categoryHint,
    description: object.description,
    materials: object.materials,
    dimensions: object.dimensions,
    priceText: object.priceText,
    imageUrls: candidateImages,
    canonicalUrl: signals?.canonicalUrl ?? finalUrl,
    sourceDomain: host,
  };
}
