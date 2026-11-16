import * as cheerio from "cheerio";
import { BROWSER_HEADERS } from "@/lib/pageSignals";
import type { PageSignals } from "@/lib/pageSignals";

// ── word lists ───────────────────────────────────────────────────────────────

/** Path segments that mark an individual product detail page. Multilingual. */
const PRODUCT_WORD_SET = new Set([
  // English
  "product", "products", "piece", "pieces", "pdp", "item", "items",
  "collectible", "collectibles",
  // Italian
  "prodotto", "prodotti",
  // French
  "produit", "produits",
  // German
  "produkt", "produkte",
  // Spanish
  "producto", "productos",
]);

/** Path segments typical of collection / category listing pages. Multilingual. */
const COLLECTION_WORD_SET = new Set([
  // English
  "collection", "collections", "category", "categories", "catalogue", "catalog",
  "range", "ranges", "series", "line", "lines", "furniture",
  "seating", "sofas", "sofa", "chairs", "chair", "armchair", "armchairs",
  "tables", "table", "beds", "bed", "storage", "bedroom", "living",
  "dining", "outdoor", "accessories", "lighting", "wardrobes", "wardrobe",
  "shelving", "shelves", "desks", "desk", "cabinets", "cabinet",
  // Italian
  "collezione", "collezioni", "arredamento", "divani", "poltrone",
  "tavoli", "letti", "armadi", "complementi", "sedute", "librerie",
  "madie", "comodini", "cabine", "sistemi",
  // French
  "mobilier", "meubles", "canapes", "fauteuils",
  // German
  "kollektion", "kollektionen", "moebel",
  // Spanish
  "coleccion", "colecciones", "muebles",
]);

/** Segments that definitively mark non-catalogue pages — always skip. */
const SKIP_SET = new Set([
  "gift-card", "giftcard", "voucher", "sample", "swatch",
  "shipping", "delivery", "returns", "warranty",
  "about", "contact", "press", "news", "blog", "career", "careers", "jobs",
  "privacy", "cookies", "terms", "login", "register", "account",
  "wishlist", "checkout", "cart", "search", "404", "sitemap",
  "dealers", "dealer", "stores", "store-locator", "find-a-store",
  "faq", "help", "support", "newsletter", "sustainability", "company",
]);

// ── helpers ──────────────────────────────────────────────────────────────────

function sameHost(a: string, b: string): boolean {
  try { return new URL(a).hostname === new URL(b).hostname; } catch { return false; }
}

function pathSegs(url: string): string[] {
  try { return new URL(url).pathname.toLowerCase().split("/").filter(Boolean); } catch { return []; }
}

/**
 * Returns true when a URL sits deep under a collection hierarchy and the
 * final segment looks like a specific product, not a sub-category.
 * e.g. /en/collections/piuma/piuma-wardrobe-sliding-doors → true
 *      /en/collections/piuma/                              → false
 */
function isDeepProductUrl(segs: string[]): boolean {
  const collIdx = segs.findIndex((s) => COLLECTION_WORD_SET.has(s));
  if (collIdx === -1) return false;
  const afterColl = segs.slice(collIdx + 1);
  if (afterColl.length < 2) return false;
  const slug = afterColl[afterColl.length - 1];
  return (
    slug.includes("-") &&
    slug.length > 8 &&
    !COLLECTION_WORD_SET.has(slug) &&
    !SKIP_SET.has(slug)
  );
}

// ── public functions ─────────────────────────────────────────────────────────

/**
 * Scans a page's links for individual product detail pages.
 * Works with English AND multilingual URL structures (Italian, French, German,
 * Spanish). Also detects deep collection-hierarchy URLs where the product slug
 * sits two or more levels under a collection marker.
 */
export function discoverProductLinks(signals: PageSignals, limit = 20): string[] {
  const seen = new Set<string>();
  const found: string[] = [];

  for (const { href } of signals.links) {
    if (found.length >= limit) break;
    if (!sameHost(href, signals.finalUrl)) continue;
    if (seen.has(href)) continue;

    const segs = pathSegs(href);
    if (segs.length === 0) continue;
    const last = segs[segs.length - 1];
    if (SKIP_SET.has(last) || SKIP_SET.has(segs[0])) continue;

    // Standard pattern: /products/[slug], /prodotti/[slug], etc.
    const productIdx = segs.findIndex((s) => PRODUCT_WORD_SET.has(s));
    if (productIdx !== -1 && productIdx < segs.length - 1) {
      seen.add(href);
      found.push(href);
      continue;
    }

    // Deep collection URL: /en/collections/piuma/piuma-wardrobe-sliding
    if (isDeepProductUrl(segs)) {
      seen.add(href);
      found.push(href);
    }
  }

  return found;
}

/**
 * Finds collection / category listing pages on a brand homepage that are
 * worth crawling to discover individual product URLs. Looks at URL structure
 * and nav/header element placement.
 */
export function discoverCollectionLinks(signals: PageSignals, limit = 15): string[] {
  const seen = new Set<string>();
  const found: string[] = [];

  let homePathname = "/";
  try { homePathname = new URL(signals.finalUrl).pathname; } catch { /* ignore */ }

  for (const { href } of signals.links) {
    if (found.length >= limit) break;
    if (!sameHost(href, signals.finalUrl)) continue;
    if (seen.has(href)) continue;

    let pathname: string;
    try { pathname = new URL(href).pathname; } catch { continue; }
    if (pathname === homePathname || pathname === "/" || pathname === "") continue;

    const segs = pathSegs(href);
    if (segs.length === 0) continue;

    // Skip non-catalogue paths
    if (segs.some((s) => SKIP_SET.has(s))) continue;

    // A deep product URL is not a collection page
    if (isDeepProductUrl(segs)) continue;

    // Product listing root (/products/, /prodotti/) with nothing after = collection index
    const productIdx = segs.findIndex((s) => PRODUCT_WORD_SET.has(s));
    if (productIdx !== -1 && productIdx === segs.length - 1) {
      seen.add(href);
      found.push(href);
      continue;
    }

    // Any path that contains a known collection/category word
    if (segs.some((s) => COLLECTION_WORD_SET.has(s))) {
      seen.add(href);
      found.push(href);
    }
  }

  return found;
}

/**
 * Fetches /sitemap.xml (and /sitemap_index.xml) from the brand's domain,
 * returning up to `limit` product URLs and up to 20 collection URLs.
 * Never throws — a missing or malformed sitemap returns empty arrays.
 */
export async function discoverFromSitemap(
  baseUrl: string,
  limit = 80,
): Promise<{ productUrls: string[]; collectionUrls: string[] }> {
  let origin: string;
  try { origin = new URL(baseUrl).origin; } catch { return { productUrls: [], collectionUrls: [] }; }

  const candidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
  ];

  async function fetchXml(url: string): Promise<string | null> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { headers: BROWSER_HEADERS, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      return res.text();
    } catch {
      return null;
    }
  }

  const locs: string[] = [];

  for (const candidate of candidates) {
    const xml = await fetchXml(candidate);
    if (!xml) continue;

    const $ = cheerio.load(xml, { xmlMode: true });

    // Sitemap index — look for product-related sub-sitemaps
    const subSitemaps: string[] = [];
    $("sitemap > loc, Sitemap > Loc, sitemap loc").each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) subSitemaps.push(loc);
    });

    if (subSitemaps.length > 0) {
      const productSubs = subSitemaps
        .filter((s) => /product|item|catalog|catalogue|collezioni|prodotti/i.test(s))
        .slice(0, 3);
      const toFetch = productSubs.length > 0 ? productSubs : subSitemaps.slice(0, 2);
      for (const sub of toFetch) {
        const subXml = await fetchXml(sub);
        if (!subXml) continue;
        const $sub = cheerio.load(subXml, { xmlMode: true });
        $sub("url > loc, Url > Loc, url loc").each((_, el) => {
          const loc = $sub(el).text().trim();
          if (loc) locs.push(loc);
        });
      }
      break;
    }

    // Regular sitemap
    $("url > loc, Url > Loc, url loc").each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) locs.push(loc);
    });
    if (locs.length > 0) break;
  }

  const productUrls: string[] = [];
  const collectionUrls: string[] = [];

  for (const loc of locs) {
    if (productUrls.length >= limit && collectionUrls.length >= 20) break;
    if (!sameHost(loc, baseUrl)) continue;

    const segs = pathSegs(loc);
    if (segs.length === 0) continue;
    if (segs.some((s) => SKIP_SET.has(s))) continue;

    const productIdx = segs.findIndex((s) => PRODUCT_WORD_SET.has(s));
    const isProductPage =
      (productIdx !== -1 && productIdx < segs.length - 1) || isDeepProductUrl(segs);
    const isCollectionPage =
      !isProductPage && segs.some((s) => COLLECTION_WORD_SET.has(s));

    if (isProductPage && productUrls.length < limit) {
      productUrls.push(loc);
    } else if (isCollectionPage && collectionUrls.length < 20) {
      collectionUrls.push(loc);
    }
  }

  return { productUrls, collectionUrls };
}
