import { fetchPageSignals } from "@/lib/pageSignals";
import type { PageSignals } from "@/lib/pageSignals";
import {
  discoverProductLinks,
  discoverCollectionLinks,
  discoverPaginationLinks,
  discoverFromSitemap,
  isProductPageUrl,
  getLocalePrefix,
} from "@/lib/bulk/discoverLinks";
import { tavilySearch } from "@/lib/tavily";

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

async function fetchSignalsSafe(url: string): Promise<PageSignals | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetchPageSignals(url),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), COLLECTION_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
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
  opts?: { maxProducts?: number; maxCollections?: number },
): Promise<BrandCrawlResult> {
  const maxProducts = opts?.maxProducts ?? 60;
  const maxCollections = opts?.maxCollections ?? 15;
  const host = hostOf(baseUrl);
  let preferredLocale = getLocalePrefix(baseUrl);

  const seen = new Set<string>();
  const productUrls: string[] = [];
  // URLs confirmed live by appearing in an actual category page listing.
  // These are always reachable, unlike some sitemap entries that point to
  // discontinued/renamed product pages that now 404. Confirmed URLs are
  // moved to the front of productUrls so ingestion tries them first.
  const confirmedByNav = new Set<string>();
  let sitemapUsed = false;
  let collectionsCrawled = 0;
  let tavilyFallback = false;
  let truncated = false;

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
    const locale = getLocalePrefix(normalized);
    if (preferredLocale && locale && locale !== preferredLocale) return false;
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
  const sitemapResult = await discoverFromSitemap(baseUrl, maxProducts, maxCollections).catch(() => ({
    productUrls: [] as string[],
    collectionUrls: [] as string[],
    truncated: false,
  }));

  const sitemapLocale = getLocalePrefix(sitemapResult.productUrls[0] ?? "");
  if (
    sitemapLocale &&
    (!preferredLocale || !sitemapResult.productUrls.some((url) => getLocalePrefix(url) === preferredLocale))
  ) {
    preferredLocale = sitemapLocale;
  } else if (!preferredLocale) {
    preferredLocale = getLocalePrefix(homepageSignals?.finalUrl ?? "");
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
      for (const u of discoverProductLinks(homepageSignals, 20)) addUrl(u);
      for (const u of discoverCollectionLinks(homepageSignals, maxCollections)) {
        const locale = getLocalePrefix(u);
        if (!preferredLocale || !locale || locale === preferredLocale) collectionCandidates.add(u);
      }
    }

    if (sitemapResult.collectionUrls.length > maxCollections) truncated = true;
    for (const u of sitemapResult.collectionUrls.slice(0, maxCollections)) {
      const locale = getLocalePrefix(u);
      if (!preferredLocale || !locale || locale === preferredLocale) collectionCandidates.add(u);
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
        const signals = await fetchSignalsSafe(collUrl);
        if (!signals) return;
        collectionsCrawled++;

        const pageProducts = discoverProductLinks(signals, 40);
        let added = 0;
        for (const u of pageProducts) {
          confirmedByNav.add(u);
          if (addUrl(u)) added++;
        }

        for (const nextPage of discoverPaginationLinks(signals, 5)) {
          const locale = getLocalePrefix(nextPage);
          if ((!preferredLocale || !locale || locale === preferredLocale) && !queued.has(nextPage) && !visited.has(nextPage)) {
            queued.add(nextPage);
            queue.unshift(nextPage);
          }
        }

        // Follow subcategories only from empty listings. This keeps the crawl
        // bounded and avoids recursively walking the entire site navigation.
        if (pageProducts.length === 0) {
          for (const sub of discoverCollectionLinks(signals, 5)) {
            const locale = getLocalePrefix(sub);
            if ((!preferredLocale || !locale || locale === preferredLocale) && !queued.has(sub) && !visited.has(sub)) {
              queued.add(sub);
              queue.push(sub);
            }
          }
        }

        if (added > 0) {
          let pathname = "catalogue listing";
          try { pathname = new URL(collUrl).pathname; } catch { /* keep generic label */ }
          onProgress?.(`+${added} products from ${pathname}`);
        }
      });
    }
    if (queue.length > 0) truncated = true;

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
    } catch {
      // The HTML and sitemap paths remain available when Tavily is unavailable.
    }
  }

  return {
    productUrls,
    stats: { sitemapUsed, collectionsCrawled, tavilyFallback, totalDiscovered: productUrls.length, truncated },
  };
}
