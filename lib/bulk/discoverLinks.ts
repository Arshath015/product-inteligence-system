import * as cheerio from "cheerio";
import { gunzipSync } from "node:zlib";
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
  "seating", "sofas", "sofa", "chairs", "chair", "armchair", "armchairs", "lamp", "lamps",
  "tables", "table", "beds", "bed", "storage", "bedroom", "living",
  "dining", "outdoor", "accessories", "lighting", "wardrobes", "wardrobe",
  "shelving", "shelves", "desks", "desk", "cabinets", "cabinet",
  // Italian
  "collezione", "collezioni", "arredamento", "divani", "poltrone",
  "tavoli", "tavolini", "letti", "armadi", "complementi", "sedute", "sedie", "librerie",
  "madie", "comodini", "cabine", "sistemi", "contenitori", "prodotti_categorie",
  "product_category", "product-category",
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
const SKIP_PREFIXES = ["notice-", "spare-parts", "about-", "contact-", "terms-", "privacy-", "faq-"];
const CATEGORY_ROUTE_PREFIXES = ["clp-", "category-", "collection-"];

// ── helpers ──────────────────────────────────────────────────────────────────

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, "");
  } catch { return false; }
}

function pathSegs(url: string): string[] {
  try { return new URL(url).pathname.toLowerCase().split("/").filter(Boolean); } catch { return []; }
}

function isSkippedSegment(segment: string): boolean {
  const route = segment.startsWith("clp-") ? segment.slice(4) : segment;
  return SKIP_SET.has(route) || SKIP_PREFIXES.some((prefix) => route.startsWith(prefix));
}

function isCategoryRoute(segment: string | undefined): boolean {
  return Boolean(segment && CATEGORY_ROUTE_PREFIXES.some((prefix) => segment.startsWith(prefix)));
}

function normalizedSegs(url: string): string[] {
  return pathSegs(url).map((segment) => segment.replace(/\.(?:html?|php)$/i, ""));
}

/**
 * Returns true when a URL sits deep under a collection hierarchy and the
 * final segment looks like a specific product, not a sub-category.
 * e.g. /en/collections/piuma/piuma-wardrobe-sliding-doors → true
 *      /en/collections/piuma/                              → false
 */
function isDeepProductUrl(segs: string[]): boolean {
  const normalized = segs.map((segment) => segment.replace(/\.(?:html?|php)$/i, ""));
  const collIdx = normalized.findIndex((s) => COLLECTION_WORD_SET.has(s));
  if (collIdx === -1) return false;
  const afterColl = normalized.slice(collIdx + 1);
  if (afterColl.length < 2) return false;
  const slug = afterColl[afterColl.length - 1];
  return (
    slug.includes("-") &&
    slug.length > 8 &&
    !COLLECTION_WORD_SET.has(slug) &&
    !isSkippedSegment(slug)
  );
}

// ── public functions ─────────────────────────────────────────────────────────

/**
 * Returns true when a URL path looks like a specific product detail page —
 * not a category, collection root, or non-catalogue page. Used both for
 * sitemap classification and for filtering Tavily search results.
 */
export function isProductPageUrl(url: string): boolean {
  try {
    const segs = pathSegs(url);
    if (segs.length === 0) return false;
    const normalized = normalizedSegs(url);
    if (normalized.some(isSkippedSegment)) return false;
    const productIdx = normalized.findIndex((s) => PRODUCT_WORD_SET.has(s));
    if (productIdx !== -1 && productIdx < segs.length - 1) return true;
    if (isDeepProductUrl(normalized)) return true;
    const leaf = normalized[normalized.length - 1];
    const hasCollectionParent = normalized.slice(0, -1).some((segment) => COLLECTION_WORD_SET.has(segment));
    return !hasCollectionParent &&
      !isCategoryRoute(leaf) &&
      /\.(?:html?|php)$/i.test(segs[segs.length - 1]) &&
      leaf.split("-").filter(Boolean).length >= 3 &&
      !COLLECTION_WORD_SET.has(leaf) &&
      !isSkippedSegment(leaf);
  } catch {
    return false;
  }
}

/**
 * Scans a page's links for individual product detail pages.
 * Works with English AND multilingual URL structures (Italian, French, German,
 * Spanish). Also detects deep collection-hierarchy URLs where the product slug
 * sits two or more levels under a collection marker.
 */
export function discoverProductLinks(signals: PageSignals, limit = 20): string[] {
  const seen = new Set<string>();
  const found: string[] = [];

  const add = (href: string) => {
    if (found.length >= limit || !sameHost(href, signals.finalUrl) || seen.has(href)) return;
    const segs = normalizedSegs(href);
    if (segs.length === 0 || segs.some(isSkippedSegment)) return;
    const productIdx = segs.findIndex((s) => PRODUCT_WORD_SET.has(s));
    if ((productIdx === -1 || productIdx === segs.length - 1) && !isProductPageUrl(href)) return;
    seen.add(href);
    found.push(href);
  };

  for (const { href } of signals.links) {
    if (found.length >= limit) break;
    add(href);
  }

  const visitStructured = (node: unknown, inProductList = false) => {
    if (!node || typeof node !== "object" || found.length >= limit) return;
    if (Array.isArray(node)) {
      node.forEach((item) => visitStructured(item, inProductList));
      return;
    }
    const obj = node as Record<string, unknown>;
    const rawType = obj["@type"];
    const types = Array.isArray(rawType) ? rawType : [rawType];
    const isProduct = types.some((type) => typeof type === "string" && type.toLowerCase() === "product");
    const isProductList = inProductList || types.some((type) =>
      typeof type === "string" && ["itemlist", "offercatalog"].includes(type.toLowerCase())
    );
    if (isProduct || isProductList) {
      for (const value of [obj.url, obj["@id"]]) {
        if (typeof value === "string") {
          try {
            add(new URL(value, signals.finalUrl).toString());
          } catch {
            // Ignore malformed structured-data URLs.
          }
        }
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key !== "@type") visitStructured(value, isProduct || isProductList);
    }
  };
  signals.jsonLd.forEach((node) => visitStructured(node));

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

    const segs = normalizedSegs(href);
    if (segs.length === 0) continue;

    // Skip non-catalogue paths
    if (segs.some(isSkippedSegment)) continue;

    // A deep product URL is not a collection page
    if (isDeepProductUrl(segs)) continue;

    // Product listing root (/products/, /prodotti/) with nothing after = collection index
    const productIdx = segs.findIndex((s) => PRODUCT_WORD_SET.has(s));
    if (productIdx !== -1 && productIdx === segs.length - 1) {
      seen.add(href);
      found.push(href);
      continue;
    }

    const collectionLabel = /products?|collections?|categories|catalog(?:ue)?|sofas?|chairs?|armchairs?|tables?|beds?|lighting|outdoor|divani|poltrone|tavoli|sedie|madie|librerie|prodotti|collezioni|cat[eé]gories|meubles|muebles/i;
    if (
      segs.some((s) => COLLECTION_WORD_SET.has(s)) ||
      isCategoryRoute(segs[segs.length - 1]) ||
      collectionLabel.test(signals.links.find((l) => l.href === href)?.text ?? "")
    ) {
      seen.add(href);
      found.push(href);
    }
  }

  return found;
}

/** Finds a small number of explicit next-page links, never arbitrary query URLs. */
export function discoverPaginationLinks(signals: PageSignals, limit = 5): string[] {
  const $ = cheerio.load(signals.html);
  const found = new Set<string>();
  const add = (href: string | undefined, explicitlyNext: boolean) => {
    if (!href || found.size >= limit) return;
    let url: URL;
    try { url = new URL(href, signals.finalUrl); } catch { return; }
    if (!sameHost(url.toString(), signals.finalUrl) || url.toString() === signals.finalUrl) return;
    const isPageQuery = [...url.searchParams.keys()].some((key) => /^(page|paged|page_num|p|pg|offset|cursor)$/i.test(key));
    const isPagePath = /\/(?:page|pagina)\/\d+\/?$/i.test(url.pathname);
    if (explicitlyNext || isPageQuery || isPagePath) found.add(url.toString());
  };

  $('a[rel~="next"], link[rel~="next"]').each((_, el) => add($(el).attr("href"), true));
  $("a[href]").each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr("href");
    const text = `${anchor.text()} ${anchor.attr("aria-label") ?? ""}`.trim();
    if (/^(next|older|more products|load more|›|»|→)$/i.test(text)) add(href, false);
  });
  return [...found].slice(0, limit);
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

export function getLocalePrefix(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    if (/^[a-z]{2}-[a-z]{2}$/i.test(segments[0] ?? "")) return segments[0].toLowerCase();
    if (/^[a-z]{2}$/i.test(segments[0] ?? "") && /^[a-z]{2}$/i.test(segments[1] ?? "")) {
      return `${segments[0]}/${segments[1]}`.toLowerCase();
    }
    return /^[a-z]{2}$/i.test(segments[0] ?? "") ? segments[0].toLowerCase() : null;
  } catch {
    return null;
  }
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
  collectionLimit = 20,
): Promise<{ productUrls: string[]; collectionUrls: string[]; truncated: boolean }> {
  let origin: string;
  try { origin = new URL(baseUrl).origin; } catch { return { productUrls: [], collectionUrls: [], truncated: false }; }

  // e.g. "en" for https://pianca.com/en/ — used to filter multi-language sitemaps
  const preferredLang = detectLangPrefix(baseUrl);
  const preferredLocale = getLocalePrefix(baseUrl);

  async function fetchXml(url: string): Promise<string | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS, signal: ctrl.signal });
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (/\.gz(?:\?|$)/i.test(url) || /application\/gzip/i.test(res.headers.get("content-type") ?? "")) {
        return gunzipSync(bytes).toString("utf8");
      }
      return bytes.toString("utf8");
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const robots = await fetchXml(`${origin}/robots.txt`);
  const sitemapRefs = (robots ?? "").match(/^sitemap:\s*\S+/gim)?.map((line) => line.replace(/^sitemap:\s*/i, "")) ?? [];
  const candidates = [...new Set([
    ...sitemapRefs,
    `${origin}/sitemap.xml`,
    `${origin}/sitemap.xml.gz`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
  ])];

  const locs: string[] = [];

  /** Pick preferred sub-sitemaps: language-matched first, then product-named, then first-N. */
  function rankSubSitemaps(subs: string[], lang: string | null): string[] {
    // Prefer subs that contain the preferred language code
    const langPat = lang ? new RegExp(`[/_-]${lang}[/_.-]|[/_-]${lang}$`, "i") : null;
    const byLang = langPat ? subs.filter((s) => langPat.test(s.replace(/^https?:\/\/[^/]+/, ""))) : [];
    if (byLang.length > 0) {
      // Among language matches, prefer product-named ones
      const prodMatch = byLang.filter((s) => /product|\bitem\b|catalog|catalogue|prodotti|categor/i.test(s));
      return prodMatch.length > 0 ? prodMatch.slice(0, 5) : byLang.slice(0, 5);
    }
    // No language match — prefer product-named, else first 2
    // NOTE: use \bitem\b so "sitemap" (which contains "item") doesn't match every sub-sitemap.
    const prodSubs = subs.filter((s) => /product|\bitem\b|catalog|catalogue|prodotti|categor/i.test(s));
    return prodSubs.length > 0 ? prodSubs.slice(0, 5) : subs.slice(0, 2);
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

  // Keep one locale when a sitemap contains copies of the same catalogue for
  // many storefront regions; fall back only when the requested locale is absent.
  const localeCandidates = locs.filter(isProductPageUrl);
  const preferredMatches = preferredLocale
    ? localeCandidates.filter((url) => getLocalePrefix(url) === preferredLocale)
    : [];
  const unlocalizedMatches = localeCandidates.filter((url) => getLocalePrefix(url) === null);
  const localeCounts = new Map<string, number>();
  for (const url of localeCandidates) {
    const locale = getLocalePrefix(url);
    if (locale) localeCounts.set(locale, (localeCounts.get(locale) ?? 0) + 1);
  }
  const dominantLocale = [...localeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    ?? getLocalePrefix(locs[0] ?? "");
  const localeToKeep = preferredMatches.length > 0
    ? preferredLocale
    : unlocalizedMatches.length > 0 && !preferredLocale
      ? null
      : dominantLocale;
  const localeScopedLocs = locs.filter((url) => {
    const locale = getLocalePrefix(url);
    return localeToKeep ? locale === localeToKeep || locale === null : locale === null;
  });
  const sortedLocs = preferredLang
    ? [
        ...localeScopedLocs.filter((url) => detectLangPrefix(url) === preferredLang),
        ...localeScopedLocs.filter((url) => detectLangPrefix(url) !== preferredLang),
      ]
    : localeScopedLocs;

  const productUrls: string[] = [];
  const collectionUrls: string[] = [];
  let truncated = false;

  for (const loc of sortedLocs) {
    if (!sameHost(loc, baseUrl)) continue;

    const segs = normalizedSegs(loc);
    if (segs.length === 0) continue;
    if (segs.some(isSkippedSegment)) continue;

    const isProductPage = isProductPageUrl(loc);
    const isCollectionPage =
      !isProductPage && (segs.some((s) => COLLECTION_WORD_SET.has(s)) || isCategoryRoute(segs[segs.length - 1]));

    if (isProductPage && productUrls.length < limit) {
      productUrls.push(loc);
    } else if (isProductPage) {
      truncated = true;
    } else if (isCollectionPage) {
      if (collectionUrls.length < collectionLimit) collectionUrls.push(loc);
      else truncated = true;
    }
  }

  return { productUrls, collectionUrls, truncated };
}
