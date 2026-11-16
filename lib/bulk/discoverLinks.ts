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
  try {
    return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, "");
  } catch { return false; }
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
 * Returns the 2-letter language code from a URL path prefix, handling both
 * /en/ and /en-US/ patterns. e.g. "en" for /en/, /en-US/, /en-GB/, /en-RW/.
 */
function detectLangPrefix(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/^\/([a-z]{2})(?:-[A-Za-z]{2})?\//);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * Fetches /sitemap.xml (and /sitemap_index.xml) from the brand's domain,
 * returning up to `limit` product URLs and up to 20 collection URLs.
 * When the baseUrl has a language prefix (/en/, /it/ etc.) only URLs with
 * that prefix are returned — avoids picking 7 multilingual copies of the
 * same product when brands publish one sitemap for all languages.
 * Never throws — a missing or malformed sitemap returns empty arrays.
 */
export async function discoverFromSitemap(
  baseUrl: string,
  limit = 80,
): Promise<{ productUrls: string[]; collectionUrls: string[] }> {
  let origin: string;
  try { origin = new URL(baseUrl).origin; } catch { return { productUrls: [], collectionUrls: [] }; }

  // e.g. "en" for https://pianca.com/en/ — used to filter multi-language sitemaps
  const preferredLang = detectLangPrefix(baseUrl);

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

  /** Pick preferred sub-sitemaps: language-matched first, then product-named, then first-N. */
  function rankSubSitemaps(subs: string[], lang: string | null): string[] {
    // Prefer subs that contain the preferred language code
    const langPat = lang ? new RegExp(`[/_-]${lang}[/_.-]|[/_-]${lang}$`, "i") : null;
    const byLang = langPat ? subs.filter((s) => langPat.test(s.replace(/^https?:\/\/[^/]+/, ""))) : [];
    if (byLang.length > 0) {
      // Among language matches, prefer product-named ones
      const prodMatch = byLang.filter((s) => /product|item|catalog|catalogue|prodotti/i.test(s));
      return prodMatch.length > 0 ? prodMatch.slice(0, 3) : byLang.slice(0, 3);
    }
    // No language match — prefer product-named, else first 2
    const prodSubs = subs.filter((s) => /product|item|catalog|catalogue|prodotti/i.test(s));
    return prodSubs.length > 0 ? prodSubs.slice(0, 3) : subs.slice(0, 2);
  }

  /** Extract `<sitemap>` or `<url>` loc entries that look like sitemap references. */
  function extractSubSitemapRefs($doc: ReturnType<typeof cheerio.load>): string[] {
    const refs: string[] = [];
    // Standard <sitemapindex> pattern
    $doc("sitemap > loc, Sitemap > Loc").each((_, el) => {
      const loc = $doc(el).text().trim();
      if (loc) refs.push(loc);
    });
    if (refs.length > 0) return refs;
    // Non-standard: <url> entries pointing to XML sitemaps (Molteni-style)
    $doc("url > loc, Url > Loc").each((_, el) => {
      const loc = $doc(el).text().trim();
      if (loc && /\.xml(\?|$)/i.test(loc) && !/SKIP_SET/.test(loc)) refs.push(loc);
    });
    return refs;
  }

  for (const candidate of candidates) {
    const xml = await fetchXml(candidate);
    if (!xml) continue;

    const $ = cheerio.load(xml, { xmlMode: true });

    // ── Level 1: sitemap index? ───────────────────────────────────────────────
    const level1Subs = extractSubSitemapRefs($);
    if (level1Subs.length > 0) {
      const toFetch1 = rankSubSitemaps(level1Subs, preferredLang);
      for (const sub of toFetch1) {
        const subXml = await fetchXml(sub);
        if (!subXml) continue;
        const $sub = cheerio.load(subXml, { xmlMode: true });

        // ── Level 2: another index? (Calligaris: sitemap-0 → sitemap_index → locale) ──
        const level2Subs = extractSubSitemapRefs($sub);
        if (level2Subs.length > 0) {
          const toFetch2 = rankSubSitemaps(level2Subs, preferredLang);
          for (const sub2 of toFetch2) {
            const sub2Xml = await fetchXml(sub2);
            if (!sub2Xml) continue;
            const $sub2 = cheerio.load(sub2Xml, { xmlMode: true });

            // ── Level 3: yet another index? (Calligaris locale → sitemap-products) ──
            const level3Subs = extractSubSitemapRefs($sub2);
            if (level3Subs.length > 0) {
              const toFetch3 = rankSubSitemaps(level3Subs, preferredLang);
              for (const sub3 of toFetch3.slice(0, 2)) {
                const sub3Xml = await fetchXml(sub3);
                if (!sub3Xml) continue;
                const $sub3 = cheerio.load(sub3Xml, { xmlMode: true });
                $sub3("url > loc, Url > Loc, url loc").each((_, el) => {
                  const loc = $sub3(el).text().trim();
                  if (loc && !/\.xml(\?|$)/i.test(loc)) locs.push(loc);
                });
              }
            } else {
              $sub2("url > loc, Url > Loc, url loc").each((_, el) => {
                const loc = $sub2(el).text().trim();
                if (loc && !/\.xml(\?|$)/i.test(loc)) locs.push(loc);
              });
            }
          }
        } else {
          $sub("url > loc, Url > Loc, url loc").each((_, el) => {
            const loc = $sub(el).text().trim();
            if (loc && !/\.xml(\?|$)/i.test(loc)) locs.push(loc);
          });
        }
      }
      break;
    }

    // ── Flat sitemap: regular <url> entries ───────────────────────────────────
    $("url > loc, Url > Loc, url loc").each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) locs.push(loc);
    });
    if (locs.length > 0) break;
  }

  // When the brand URL has a language prefix, sort preferred-language URLs
  // to the front so the cap doesn't get eaten by other-language duplicates.
  // e.g. pianca.com/en/ → put all /en/... URLs first, then others.
  const sortedLocs = preferredLang
    ? [
        ...locs.filter((l) => { try { return new URL(l).pathname.startsWith(`/${preferredLang}/`); } catch { return false; } }),
        ...locs.filter((l) => { try { return !new URL(l).pathname.startsWith(`/${preferredLang}/`); } catch { return true; } }),
      ]
    : locs;

  const productUrls: string[] = [];
  const collectionUrls: string[] = [];

  for (const loc of sortedLocs) {
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
