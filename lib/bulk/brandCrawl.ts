import { fetchPageSignals } from "@/lib/pageSignals";
import type { PageSignals } from "@/lib/pageSignals";
import {
  discoverProductLinks,
  discoverCollectionLinks,
  discoverPotentialCollectionLinks,
  discoverPaginationLinks,
  hasUnlinkedLoadMoreControl,
  discoverFromSitemap,
  isProductPageUrl,
  isProductListingPage,
  getLocalePrefix,
} from "@/lib/bulk/discoverLinks";
import { tavilySearch } from "@/lib/tavily";
import type { BrandImportDiagnostic } from "@/lib/bulk/brandImportDiagnostics";

export interface BrandCrawlResult {
  productUrls: string[];
  stats: {
    sitemapUsed: boolean;
    collectionsCrawled: number;
    tavilyFallback: boolean;
    totalDiscovered: number;
    truncated: boolean;
  };
}

const COLLECTION_CONCURRENCY = 3;
const COLLECTION_TIMEOUT_MS = 12_000;

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function belongsToBrand(url: string, host: string): boolean {
  const candidateHost = hostOf(url);
  return candidateHost === host || candidateHost.endsWith(`.${host}`);
}

async function fetchSignalsSafe(url: string): Promise<{ signals: PageSignals | null; reason: string | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const signals = await Promise.race([
      fetchPageSignals(url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${COLLECTION_TIMEOUT_MS}ms.`)), COLLECTION_TIMEOUT_MS);
      }),
    ]);
    return { signals, reason: null };
  } catch (error) {
    return { signals: null, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function runner() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
}

/**
 * Multi-level brand catalogue crawler.
 *
 * Strategy (in order):
 *   1. Sitemap.xml — most comprehensive when available; skips JS-rendering issues entirely
 *   2. Homepage HTML → navigation/category links → bounded listing/pagination crawl
 *      Supports custom taxonomies and multilingual product URL structures
 *   3. Tavily site-search fallback for JS-heavy single-page-app catalogues
 *
 * Returns deduplicated product URLs ready for ingestion, plus crawl stats for
 * accurate reporting ("via sitemap", "crawled N collection pages", etc.).
 */
export async function crawlBrandCatalogue(
  baseUrl: string,
  homepageSignals: PageSignals | null,
  onProgress?: (msg: string) => void,
  opts?: {
    maxProducts?: number;
    maxCollections?: number;
    onDiagnostic?: (diagnostic: BrandImportDiagnostic) => void;
  },
): Promise<BrandCrawlResult> {
  const maxProducts = opts?.maxProducts ?? 60;
  const maxCollections = opts?.maxCollections ?? 15;
  const host = hostOf(baseUrl);
  let preferredLocale = getLocalePrefix(baseUrl);
  let enforceLocale = preferredLocale !== null;

  const seen = new Set<string>();
  const productUrls: string[] = [];
  const listingPageUrls = new Set<string>();
  // URLs confirmed live by appearing in an actual category page listing.
  // These are always reachable, unlike some sitemap entries that point to
  // discontinued/renamed product pages that now 404. Confirmed URLs are
  // moved to the front of productUrls so ingestion tries them first.
  const confirmedByNav = new Set<string>();
  let sitemapUsed = false;
  let collectionsCrawled = 0;
  let tavilyFallback = false;
  let truncated = false;
  const onDiagnostic = opts?.onDiagnostic;
  onDiagnostic?.({ stage: "crawl_started", outcome: "started", url: baseUrl });

  function matchesPreferredLocale(url: string): boolean {
    if (!enforceLocale) return true;
    const locale = getLocalePrefix(url);
    return locale === preferredLocale || (preferredLocale !== null && locale === null);
  }

  function addUrl(url: string): boolean {
    let normalized = url;
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      for (const key of [...parsed.searchParams.keys()]) {
        if (/^(utm_.+|fbclid|gclid|_ga)$/i.test(key)) parsed.searchParams.delete(key);
      }
      normalized = parsed.toString();
    } catch {
      return false;
    }
    if (!matchesPreferredLocale(normalized)) return false;
    if (seen.has(normalized)) return false;
    if (productUrls.length >= maxProducts) {
      truncated = true;
      return false;
    }
    seen.add(normalized);
    productUrls.push(normalized);
    return true;
  }

  // ── 1. Sitemap ─────────────────────────────────────────────────────────────
  onProgress?.(`Checking ${host} sitemap…`);
  let sitemapFailure: string | null = null;
  const sitemapResult = await discoverFromSitemap(
    baseUrl,
    maxProducts,
    maxCollections,
    homepageSignals?.finalUrl ?? baseUrl,
    (url, outcome, reason) => {
      if (outcome !== "readable") {
        onDiagnostic?.({ stage: "sitemap_fetch", outcome, url, reason });
      }
    },
  ).catch((error: unknown) => {
    sitemapFailure = error instanceof Error ? error.message : String(error);
    return {
      productUrls: [] as string[],
      collectionUrls: [] as string[],
      truncated: false,
    };
  });
  onDiagnostic?.({
    stage: "sitemap_discovery",
    outcome: sitemapResult.productUrls.length > 0 || sitemapResult.collectionUrls.length > 0
      ? "found"
      : sitemapFailure ? "failed" : "empty",
    url: baseUrl,
    counts: {
      products: sitemapResult.productUrls.length,
      collections: sitemapResult.collectionUrls.length,
      truncated: sitemapResult.truncated,
    },
    urls: sitemapResult.productUrls.slice(0, 500),
    reason: sitemapResult.productUrls.length === 0 && sitemapResult.collectionUrls.length === 0
      ? sitemapFailure ?? "No accessible sitemap contained product or collection URLs."
      : undefined,
  });

  if (!enforceLocale) {
    const homepageLocale = getLocalePrefix(homepageSignals?.finalUrl ?? "");
    if (homepageLocale) {
      preferredLocale = homepageLocale;
      enforceLocale = true;
    }
  }
  if (!enforceLocale && sitemapResult.productUrls.length > 0) {
    preferredLocale = getLocalePrefix(sitemapResult.productUrls[0]);
    enforceLocale = true;
  }
  if (!enforceLocale) {
    const catalogueLinks = [
      ...(homepageSignals ? discoverCollectionLinks(homepageSignals, maxCollections) : []),
      ...sitemapResult.collectionUrls,
    ];
    if (catalogueLinks.some((url) => getLocalePrefix(url) === null)) {
      enforceLocale = true;
    } else {
      const localeCounts = new Map<string, number>();
      for (const url of catalogueLinks) {
        const locale = getLocalePrefix(url);
        if (locale) localeCounts.set(locale, (localeCounts.get(locale) ?? 0) + 1);
      }
      const dominantLocale = [...localeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (dominantLocale) {
        preferredLocale = dominantLocale;
        enforceLocale = true;
      }
    }
  }
  for (const u of sitemapResult.productUrls) addUrl(u);
  truncated = truncated || sitemapResult.truncated;

  if (productUrls.length > 0) {
    sitemapUsed = true;
    onProgress?.(`Found ${productUrls.length} product URL(s) via sitemap.`);
  }

  // ── 2. HTML crawl: homepage → collection pages → products ──────────────────
  // Always run this even when sitemap found products — collection pages only
  // list live products, so a URL found here is confirmed reachable. We track
  // those as confirmedByNav and sort them to the front before ingestion so
  // dead/stale sitemap entries (which 404) don't eat the per-run ingest cap.
  {
    // Seed collection candidates from homepage HTML + sitemap collection URLs
    const collectionCandidates = new Set<string>();

    if (homepageSignals) {
      for (const u of discoverProductLinks(homepageSignals, maxProducts + 1)) addUrl(u);
      const homepageCollections = discoverCollectionLinks(homepageSignals, maxCollections);
      for (const u of homepageCollections) {
        if (matchesPreferredLocale(u)) collectionCandidates.add(u);
      }
      for (const u of discoverPotentialCollectionLinks(homepageSignals, maxCollections)) {
        if (collectionCandidates.size >= maxCollections) break;
        if (matchesPreferredLocale(u)) collectionCandidates.add(u);
      }
      if (isProductListingPage(homepageSignals) && matchesPreferredLocale(homepageSignals.finalUrl)) {
        collectionCandidates.add(homepageSignals.finalUrl);
      }
    }

    if (sitemapResult.collectionUrls.length > maxCollections) truncated = true;
    for (const u of sitemapResult.collectionUrls.slice(0, maxCollections)) {
      if (matchesPreferredLocale(u)) collectionCandidates.add(u);
    }

    const queue = [...collectionCandidates].slice(0, maxCollections);
    if (collectionCandidates.size > maxCollections) truncated = true;
    const queued = new Set(queue);
    const visited = new Set<string>();
    if (queue.length > 0) {
      onProgress?.(`Crawling up to ${Math.min(maxCollections, queue.length)} catalogue page(s) on ${host}…`);
    }

    while (queue.length > 0 && collectionsCrawled < maxCollections && productUrls.length < maxProducts) {
      const batch = queue.splice(0, Math.min(COLLECTION_CONCURRENCY, maxCollections - collectionsCrawled));
      await runPool(batch, COLLECTION_CONCURRENCY, async (collUrl) => {
        if (visited.has(collUrl) || productUrls.length >= maxProducts) return;
        visited.add(collUrl);
        const fetched = await fetchSignalsSafe(collUrl);
        const signals = fetched.signals;
        if (!signals) {
          onDiagnostic?.({
            stage: "collection_fetch",
            outcome: "failed",
            url: collUrl,
            reason: fetched.reason ?? "Could not read the page.",
          });
          return;
        }
        collectionsCrawled++;
        if (isProductListingPage(signals)) listingPageUrls.add(collUrl);

        const pageProducts = discoverProductLinks(signals, maxProducts + 1);
        const beforeProducts = productUrls.length;
        let added = 0;
        for (const u of pageProducts) {
          confirmedByNav.add(u);
          if (addUrl(u)) added++;
        }

        const paginationLinks = discoverPaginationLinks(signals, Math.min(20, maxCollections));
        const unlinkedLoadMore = hasUnlinkedLoadMoreControl(signals) && paginationLinks.length === 0;
        if (unlinkedLoadMore) truncated = true;
        for (const nextPage of paginationLinks) {
          if (matchesPreferredLocale(nextPage) && !queued.has(nextPage) && !visited.has(nextPage)) {
            queued.add(nextPage);
            queue.unshift(nextPage);
          }
        }

        // Listings can contain both products and links to nested categories.
        // Follow those category links too, but keep the crawl bounded.
        const subCollections = [
          ...discoverCollectionLinks(signals, 10),
          ...discoverPotentialCollectionLinks(signals, 10),
        ];
        for (const sub of subCollections) {
          if (matchesPreferredLocale(sub) && !queued.has(sub) && !visited.has(sub)) {
            queued.add(sub);
            queue.push(sub);
          }
        }
        onDiagnostic?.({
          stage: "collection_discovery",
          outcome: "processed",
          url: collUrl,
          counts: {
            candidates: pageProducts.length,
            newlyDiscovered: productUrls.length - beforeProducts,
            pagination: paginationLinks.length,
            nestedCollections: subCollections.length,
            unlinkedLoadMore,
          },
          reason: unlinkedLoadMore
            ? "The page exposes a load-more control without a public next-page URL; further items were not fetched."
            : undefined,
          urls: pageProducts.slice(0, 500),
        });

        if (added > 0) {
          let pathname = "catalogue listing";
          try { pathname = new URL(collUrl).pathname; } catch { /* keep generic label */ }
          onProgress?.(`+${added} products from ${pathname}`);
        }
      });
    }
    if (queue.length > 0) truncated = true;

    if (listingPageUrls.size > 0) {
      productUrls.splice(0, productUrls.length, ...productUrls.filter((url) => !listingPageUrls.has(url)));
      for (const url of listingPageUrls) {
        onDiagnostic?.({
          stage: "listing_page_classification",
          outcome: "collection",
          url,
        });
      }
    }

    // Promote nav-confirmed URLs to the front so ingestion tries live pages first.
    // Sitemap-only URLs (which may 404) go after the confirmed batch.
    if (confirmedByNav.size > 0) {
      const confirmed = productUrls.filter((u) => confirmedByNav.has(u));
      const unconfirmed = productUrls.filter((u) => !confirmedByNav.has(u));
      productUrls.splice(0, productUrls.length, ...confirmed, ...unconfirmed);
    }
  }

  // ── 3. Tavily fallback for JS-rendered / CDN-blocked catalogues ───────────
  if (productUrls.length < 3) {
    onProgress?.(`No HTML products found — searching ${host} via Tavily…`);
    tavilyFallback = true;
    try {
      // Run category-specific queries in parallel to find individual product
      // detail pages (not just category landing pages). Without site: restriction
      // so search engines' per-page indexing surfaces specific model pages.
      const CATEGORY_TERMS = ["sofa", "armchair", "table", "chair", "bed", "wardrobe", "storage"];
      const categorySearches = CATEGORY_TERMS.slice(0, 5).map((term) =>
        tavilySearch(`site:${host} ${term}`, { maxResults: 8, includeImages: false, searchDepth: "basic" }).catch(() => null)
      );
      const categoryResults = await Promise.all(categorySearches);
      for (const batch of categoryResults) {
        if (!batch) continue;
        for (const r of batch.results) {
          // Prefer URLs that look like product detail pages, skip category roots
          if (belongsToBrand(r.url, host) && isProductPageUrl(r.url)) addUrl(r.url);
        }
      }

      // Broad site: search as a catch-all when category queries found nothing
      if (productUrls.length < 3) {
        const broadSearches = await Promise.all(
          CATEGORY_TERMS.slice(5).map((term) =>
            tavilySearch(`site:${host} ${term}`, {
              maxResults: 8,
              includeImages: false,
              searchDepth: "basic",
            }).catch(() => null)
          ),
        );
        for (const result of broadSearches) {
          for (const r of result?.results ?? []) {
            if (belongsToBrand(r.url, host) && isProductPageUrl(r.url)) addUrl(r.url);
          }
        }
      }
    } catch (error) {
      onDiagnostic?.({
        stage: "search_fallback",
        outcome: "failed",
        url: baseUrl,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  onDiagnostic?.({
    stage: "crawl_finished",
    outcome: truncated ? "truncated" : "complete",
    url: baseUrl,
    counts: {
      products: productUrls.length,
      collectionsCrawled,
      sitemapUsed,
      tavilyFallback,
      truncated,
    },
    urls: productUrls.slice(0, 1000),
  });

  return {
    productUrls,
    stats: { sitemapUsed, collectionsCrawled, tavilyFallback, totalDiscovered: productUrls.length, truncated },
  };
}
