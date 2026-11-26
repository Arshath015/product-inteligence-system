import * as cheerio from "cheerio";
import { gunzipSync } from "node:zlib";
import type { AnyNode } from "domhandler";
import { BROWSER_HEADERS } from "@/lib/pageSignals";
import type { PageSignals } from "@/lib/pageSignals";
import {
  PRODUCT_WORD_SET,
  isCategoryRoute,
  isCollectionPathSegment,
  isDeepProductUrl,
  isProductPageUrl,
  isSkippedSegment,
  normalizedSegs,
} from "@/lib/bulk/urlClassification";
export { isProductPageUrl } from "@/lib/bulk/urlClassification";

// ── helpers ──────────────────────────────────────────────────────────────────

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, "");
  } catch { return false; }
}

const SITE_CHROME_PATTERN = /^(?:nav|navigation|header|footer|breadcrumb|language|search)$/i;
const PRODUCT_CARD_PATTERN = /(?:product|item|card|tile|result)/i;
const MENU_CONTAINER_PATTERN = /^(?:container-menu|main-prodotti-menu|inner-menu-mobile|sub-menu)(?:-|$)/i;

function isInsideSiteChrome($: ReturnType<typeof cheerio.load>, element: AnyNode): boolean {
  let node = $(element);
  while (node.length) {
    const tagName = node[0]?.type === "tag" ? (node[0] as { name?: string }).name : "";
    if (tagName && /^(?:nav|header|footer)$/i.test(tagName)) return true;
    const classes = `${node.attr("id") ?? ""} ${node.attr("class") ?? ""}`.split(/\s+/);
    if (classes.some((token) => SITE_CHROME_PATTERN.test(token))) return true;
    if (classes.some((token) => MENU_CONTAINER_PATTERN.test(token))) return true;
    if (SITE_CHROME_PATTERN.test(node.attr("role") ?? "")) return true;
    node = node.parent();
  }
  return false;
}

function productCardLinks(signals: PageSignals): string[] {
  const $ = cheerio.load(signals.html);
  const found = new Set<string>();
  const add = (rawUrl: string | undefined, element: AnyNode) => {
    if (!rawUrl || isInsideSiteChrome($, element)) return;
    const node = $(element);
    const identity = `${node.attr("id") ?? ""} ${node.attr("class") ?? ""}`;
    if (!node.is("a") && !node.find("img").length && !PRODUCT_CARD_PATTERN.test(identity)) return;
    try {
      const url = new URL(rawUrl, signals.finalUrl).toString();
      if (sameHost(url, signals.finalUrl) && isProductPageUrl(url)) found.add(url);
    } catch {
      // Ignore malformed page-provided URLs.
    }
  };

  $("[data-url], [data-href], [data-link], [data-product-url]").each((_, element) => {
    const node = $(element);
    add(
      node.attr("data-product-url") ?? node.attr("data-url") ?? node.attr("data-href") ?? node.attr("data-link"),
      element,
    );
  });
  $("a[href]").each((_, element) => {
    const node = $(element);
    if (isInsideSiteChrome($, element)) return;
    let container = node;
    let cardSignal = false;
    for (let depth = 0; depth < 4 && container.length; depth++, container = container.parent()) {
      const identity = `${container.attr("id") ?? ""} ${container.attr("class") ?? ""}`;
      const tagName = container[0]?.type === "tag" ? (container[0] as { name?: string }).name : "";
      if (
        container.find("img").length > 0 ||
        PRODUCT_CARD_PATTERN.test(identity) ||
        /^(?:main|article)$/i.test(tagName ?? "")
      ) {
        cardSignal = true;
        break;
      }
    }
    if (cardSignal) add(node.attr("href"), element);
  });
  return [...found];
}

/** Detects listing pages from structured list data or repeated product cards. */
export function isProductListingPage(signals: PageSignals): boolean {
  const listTypes = new Set(["collectionpage", "itemlist", "offercatalog"]);
  if (signals.jsonLdTypes.some((type) => listTypes.has(type.toLowerCase()))) return true;

  if (productCardLinks(signals).length < 3) return false;
  const $ = cheerio.load(signals.html);
  const detailEvidence = $(
    '[itemtype*="Product" i], [itemprop="sku" i], [itemprop="offers" i], ' +
      '[class*="product-detail" i], [class*="product-gallery" i], [class*="gallery-product" i], ' +
      '[class*="single-product" i], [class*="pdp" i]',
  ).length > 0;
  const productGallery = $(".gallery-element, [class*='product-gallery' i], [class*='gallery-product' i]").length >= 2;
  return !detailEvidence && !productGallery;
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

  const add = (href: string) => {
    if (found.length >= limit || !sameHost(href, signals.finalUrl) || seen.has(href)) return;
    const segs = normalizedSegs(href);
    if (segs.length === 0 || segs.some(isSkippedSegment)) return;
    if (!isProductPageUrl(href)) return;
    seen.add(href);
    found.push(href);
  };

  for (const href of productCardLinks(signals)) {
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
    if (isProduct) {
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
      if (key !== "@type") visitStructured(value, isProductList);
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
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(href);
      pathname = parsedUrl.pathname;
    } catch { continue; }
    if ([...parsedUrl.searchParams.keys()].some((key) => !/^(page|paged|page_num|p|pg|offset|cursor)$/i.test(key))) {
      continue;
    }
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

    const linkText = signals.links.find((l) => l.href === href)?.text ?? "";
    if (isProductPageUrl(href) && !isCollectionPathSegment(linkText.toLowerCase().trim())) continue;
    const collectionLabel = /products?|collections?|categories|catalog(?:ue)?|sofas?|chairs?|armchairs?|tables?|beds?|lighting|outdoor|divani|poltrone|tavoli|sedie|madie|librerie|prodotti|collezioni|cat[eé]gories|meubles|muebles/i;
    if (
      segs.some((s) => isCollectionPathSegment(s)) ||
      isCategoryRoute(segs[segs.length - 1]) ||
      collectionLabel.test(linkText)
    ) {
      seen.add(href);
      found.push(href);
    }
  }

  return found;
}

/**
 * Returns ambiguous one-segment catalogue routes for bounded page-type
 * inspection. Their names are intentionally not compared with a category list:
 * the fetched page determines whether each route is a listing or a product.
 */
export function discoverPotentialCollectionLinks(signals: PageSignals, limit = 15): string[] {
  const productCards = new Set(productCardLinks(signals));
  const found = new Set<string>();

  for (const { href } of signals.links) {
    if (found.size >= limit || !sameHost(href, signals.finalUrl) || productCards.has(href)) continue;
    const segments = normalizedSegs(href);
    const productIndex = segments.findIndex((segment) => PRODUCT_WORD_SET.has(segment));
    if (productIndex === -1 || segments.length !== productIndex + 2) continue;
    if (segments.some(isSkippedSegment) || isCollectionPathSegment(segments.at(-1) ?? "")) continue;
    if (!isProductPageUrl(href)) continue;
    found.add(href);
  }
  return [...found];
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
  $('[class*="pagination" i], [id*="pagination" i], nav[aria-label*="pagination" i], .page-numbers')
    .find("a[href]")
    .each((_, el) => add($(el).attr("href"), true));
  $("a[href]").each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr("href");
    const text = `${anchor.text()} ${anchor.attr("aria-label") ?? ""}`.trim();
    if (/^(?:next|older|more products|(?:load|show|view) more(?: products| items| results)?|›|»|→)$/i.test(text)) {
      add(href, false);
    }
  });
  $("button, [role='button']").each((_, el) => {
    const button = $(el);
    const text = `${button.text()} ${button.attr("aria-label") ?? ""}`.trim();
    if (!/^(?:next|older|more products|(?:load|show|view) more(?: products| items| results)?|›|»|→)$/i.test(text)) return;
    add(
      button.attr("data-next-url") ??
        button.attr("data-url") ??
        button.attr("data-href") ??
        button.find("a[href]").attr("href"),
      true,
    );
  });
  return [...found].slice(0, limit);
}

/** Identifies explicit load-more controls that have no navigable URL to follow. */
export function hasUnlinkedLoadMoreControl(signals: PageSignals): boolean {
  const $ = cheerio.load(signals.html);
  let found = false;
  $("button, [role='button']").each((_, el) => {
    const button = $(el);
    const text = `${button.text()} ${button.attr("aria-label") ?? ""}`.trim();
    if (!/^(?:load|show|view) more(?: products| items| results)?$/i.test(text)) return;
    if (
      button.attr("data-next-url") ||
      button.attr("data-url") ||
      button.attr("data-href") ||
      button.find("a[href]").length
    ) return;
    found = true;
    return false;
  });
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
  localeUrl = baseUrl,
  onFetch?: (url: string, outcome: "readable" | "http_error" | "fetch_error", reason?: string) => void,
): Promise<{ productUrls: string[]; collectionUrls: string[]; truncated: boolean }> {
  let origin: string;
  try { origin = new URL(baseUrl).origin; } catch { return { productUrls: [], collectionUrls: [], truncated: false }; }

  // e.g. "en" for https://pianca.com/en/ — used to filter multi-language sitemaps
  const preferredLang = detectLangPrefix(localeUrl);
  const preferredLocale = getLocalePrefix(localeUrl);

  async function fetchXml(url: string): Promise<string | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS, signal: ctrl.signal });
      if (!res.ok) {
        onFetch?.(url, "http_error", `HTTP ${res.status}`);
        return null;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (/\.gz(?:\?|$)/i.test(url) || /application\/gzip/i.test(res.headers.get("content-type") ?? "")) {
        onFetch?.(url, "readable");
        return gunzipSync(bytes).toString("utf8");
      }
      onFetch?.(url, "readable");
      return bytes.toString("utf8");
    } catch (error) {
      onFetch?.(url, "fetch_error", error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const robots = await fetchXml(`${origin}/robots.txt`);
  const sitemapRefs = (robots ?? "").match(/^sitemap:\s*\S+/gim)?.map((line) => line.replace(/^sitemap:\s*/i, "")) ?? [];
  const sameOriginRefs = sitemapRefs.filter((url) => sameHost(url, baseUrl));
  const otherOriginRefs = sitemapRefs.filter((url) => !sameHost(url, baseUrl));
  const candidates = [...new Set([
    ...sameOriginRefs,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap.xml`,
    `${origin}/sitemap-index.xml`,
    `${origin}/sitemap.xml.gz`,
    ...otherOriginRefs,
  ])];

  const locs: string[] = [];
  const collectionLocs: string[] = [];
  let subSitemapsTruncated = false;

  /** Pick preferred sub-sitemaps: language-matched first, then product-named, then first-N. */
  function rankSubSitemaps(subs: string[], lang: string | null): string[] {
    const catalogPattern = /(?:products?|prodotti|produits?|produkte|productos?|catalog|catalogue|collection|product[_-]?categor|prodotti[_-]?categor)/i;
    const langPat = lang ? new RegExp(`[/_-]${lang}[/_.-]|[/_-]${lang}$`, "i") : null;
    const byLang = langPat ? subs.filter((s) => langPat.test(s.replace(/^https?:\/\/[^/]+/, ""))) : [];
    const catalogSubs = subs.filter((s) => catalogPattern.test(s));
    const ranked = catalogSubs.length > 0 ? catalogSubs : byLang.length > 0 ? byLang : subs.slice(0, 3);
    const localeRanked = byLang.length > 0
      ? [...ranked.filter((s) => byLang.includes(s)), ...ranked.filter((s) => !byLang.includes(s))]
      : ranked;
    if (localeRanked.length > 20) subSitemapsTruncated = true;
    return localeRanked.slice(0, 20);
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

  function isCategorySitemap(url: string): boolean {
    return /(?:product[_-]?categor|prodotti[_-]?categor|categorias|categories|category)/i.test(url);
  }

  function addUrlEntries($doc: ReturnType<typeof cheerio.load>, categorySitemap: boolean): void {
    $doc("url").each((_, el) => {
      const row = $doc(el);
      const loc = row.children("loc").first().text().trim();
      if (!loc) return;
      const preferredAlternate = preferredLang
        ? row.find("[hreflang]").toArray().find((alternate) => {
            const lang = ($doc(alternate).attr("hreflang") ?? "").toLowerCase().split("-")[0];
            return lang === preferredLang;
          })
        : undefined;
      const selectedLoc = preferredAlternate
        ? $doc(preferredAlternate).attr("href")?.trim() || loc
        : loc;
      (categorySitemap ? collectionLocs : locs).push(selectedLoc);
    });
  }

  for (const candidate of candidates) {
    const xml = await fetchXml(candidate);
    if (!xml) continue;

    const $ = cheerio.load(xml, { xmlMode: true });
    const startingProductCount = locs.length;
    const startingCollectionCount = collectionLocs.length;

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
              for (const sub3 of toFetch3) {
                const sub3Xml = await fetchXml(sub3);
                if (!sub3Xml) continue;
                const $sub3 = cheerio.load(sub3Xml, { xmlMode: true });
                addUrlEntries($sub3, isCategorySitemap(sub3));
              }
            } else {
              addUrlEntries($sub2, isCategorySitemap(sub2));
            }
          }
        } else {
          addUrlEntries($sub, isCategorySitemap(sub));
        }
      }
      if (
        locs.slice(startingProductCount).some((url) => sameHost(url, baseUrl)) ||
        collectionLocs.slice(startingCollectionCount).some((url) => sameHost(url, baseUrl))
      ) break;
      locs.length = startingProductCount;
      collectionLocs.length = startingCollectionCount;
      continue;
    }

    // ── Flat sitemap: regular <url> entries ───────────────────────────────────
    addUrlEntries($, isCategorySitemap(candidate));
    if (
      locs.slice(startingProductCount).some((url) => sameHost(url, baseUrl)) ||
      collectionLocs.slice(startingCollectionCount).some((url) => sameHost(url, baseUrl))
    ) break;
    locs.length = startingProductCount;
    collectionLocs.length = startingCollectionCount;
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
  const scopedCollectionLocs = collectionLocs.filter((url) => {
      const locale = getLocalePrefix(url);
      if (preferredLocale) return locale === preferredLocale || locale === null;
      return locale === null || locale === dominantLocale;
  });

  const productUrls: string[] = [];
  const collectionUrls: string[] = [];
  const collectionCandidates: string[] = [];
  let truncated = subSitemapsTruncated;

  for (const loc of [...sortedLocs, ...scopedCollectionLocs]) {
    if (!sameHost(loc, baseUrl)) continue;

    const segs = normalizedSegs(loc);
    if (segs.length === 0) continue;
    if (segs.some(isSkippedSegment)) continue;

    const isCollectionSitemapUrl = collectionLocs.includes(loc);
    const isProductPage = !isCollectionSitemapUrl && isProductPageUrl(loc);
    const isCollectionPage =
      !isProductPage && (segs.some((s) => isCollectionPathSegment(s)) || isCategoryRoute(segs[segs.length - 1]));

    if (isProductPage && productUrls.length < limit) {
      productUrls.push(loc);
      collectionCandidates.push(...collectionAncestorsFromProductUrl(loc));
    } else if (isProductPage) {
      truncated = true;
    } else if (isCollectionPage) {
      collectionCandidates.push(loc);
    }
  }

  for (const url of new Set(collectionCandidates)) {
    if (collectionUrls.length >= collectionLimit) {
      truncated = true;
      break;
    }
    collectionUrls.push(url);
  }

  return { productUrls, collectionUrls, truncated };
}

/** Infers listing-page ancestors from nested product URLs, without taxonomy names. */
export function collectionAncestorsFromProductUrl(url: string): string[] {
  try {
    const parsed = new URL(url);
    const rawSegments = parsed.pathname.split("/").filter(Boolean);
    const segments = normalizedSegs(url);
    const productIndex = segments.findIndex((segment) => PRODUCT_WORD_SET.has(segment));
    if (productIndex === -1) return [];

    const ancestors: string[] = [];
    for (let index = productIndex + 1; index < rawSegments.length - 1; index++) {
      const ancestor = new URL(parsed.toString());
      ancestor.pathname = `/${rawSegments.slice(0, index + 1).join("/")}/`;
      ancestor.search = "";
      ancestor.hash = "";
      ancestors.push(ancestor.toString());
    }
    return ancestors;
  } catch {
    return [];
  }
}
