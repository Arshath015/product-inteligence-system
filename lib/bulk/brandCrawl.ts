import { fetchPageSignals } from "@/lib/pageSignals";
import type { PageSignals } from "@/lib/pageSignals";
import {
  discoverProductLinks,
  discoverCollectionLinks,
  discoverFromSitemap,
} from "@/lib/bulk/discoverLinks";
import { tavilySearch } from "@/lib/tavily";

export interface BrandCrawlResult {
  productUrls: string[];
  stats: {
    sitemapUsed: boolean;
    collectionsCrawled: number;
    tavilyFallback: boolean;
    totalDiscovered: number;
  };
}

const COLLECTION_CONCURRENCY = 3;
const COLLECTION_TIMEOUT_MS = 12_000;

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

async function fetchSignalsSafe(url: string): Promise<PageSignals | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), COLLECTION_TIMEOUT_MS);
  try {
    const signals = await fetchPageSignals(url);
    clearTimeout(timer);
    return signals;
  } catch {
    clearTimeout(timer);
    return null;
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
 *   2. Homepage HTML → nav/collection links → crawl each for product URLs
 *      Works with Italian, French, German, Spanish URL structures (not just English)
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

  const seen = new Set<string>();
  const productUrls: string[] = [];
  let sitemapUsed = false;
  let collectionsCrawled = 0;
  let tavilyFallback = false;

  function addUrl(url: string): boolean {
    if (seen.has(url) || productUrls.length >= maxProducts) return false;
    seen.add(url);
    productUrls.push(url);
    return true;
  }

  // ── 1. Sitemap ─────────────────────────────────────────────────────────────
  onProgress?.(`Checking ${host} sitemap…`);
  const sitemapResult = await discoverFromSitemap(baseUrl, maxProducts).catch(() => ({
    productUrls: [] as string[],
    collectionUrls: [] as string[],
  }));

  for (const u of sitemapResult.productUrls) addUrl(u);

  if (productUrls.length >= 5) {
    sitemapUsed = true;
    onProgress?.(`Found ${productUrls.length} product URL(s) via sitemap.`);
  }

  // ── 2. HTML crawl: homepage → collection pages → products ──────────────────
  if (productUrls.length < maxProducts) {
    // Seed collection candidates from homepage HTML + sitemap collection URLs
    const collectionCandidates = new Set<string>();

    if (homepageSignals) {
      for (const u of discoverProductLinks(homepageSignals, 20)) addUrl(u);
      for (const u of discoverCollectionLinks(homepageSignals, maxCollections)) {
        collectionCandidates.add(u);
      }
    }

    for (const u of sitemapResult.collectionUrls.slice(0, maxCollections)) {
      collectionCandidates.add(u);
    }

    const toVisit = [...collectionCandidates].slice(0, maxCollections);
    if (toVisit.length > 0) {
      onProgress?.(`Crawling ${toVisit.length} collection page(s) on ${host}…`);
    }

    await runPool(toVisit, COLLECTION_CONCURRENCY, async (collUrl) => {
      if (productUrls.length >= maxProducts) return;
      const signals = await fetchSignalsSafe(collUrl);
      if (!signals) return;
      collectionsCrawled++;

      let added = 0;
      for (const u of discoverProductLinks(signals, 20)) {
        if (addUrl(u)) added++;
      }

      // One level deeper: if this collection page links to sub-collections, crawl those too
      if (added === 0) {
        const subCollections = discoverCollectionLinks(signals, 5);
        for (const sub of subCollections) {
          if (productUrls.length >= maxProducts) break;
          const subSignals = await fetchSignalsSafe(sub);
          if (!subSignals) continue;
          collectionsCrawled++;
          for (const u of discoverProductLinks(subSignals, 20)) {
            if (addUrl(u)) added++;
          }
        }
      }

      if (added > 0) {
        try {
          onProgress?.(`+${added} products from ${new URL(collUrl).pathname}`);
        } catch {
          onProgress?.(`+${added} products found`);
        }
      }
    });
  }

  // ── 3. Tavily fallback for JS-rendered catalogues ──────────────────────────
  if (productUrls.length < 3) {
    onProgress?.(`No HTML products found — searching ${host} via Tavily…`);
    tavilyFallback = true;
    try {
      const { results } = await tavilySearch(`site:${host} furniture product`, {
        maxResults: 20,
        includeImages: false,
        searchDepth: "advanced",
      });
      for (const r of results) {
        if (hostOf(r.url) === host) addUrl(r.url);
      }
      // Try furniture-specific queries if first attempt thin
      if (productUrls.length < 3) {
        const { results: r2 } = await tavilySearch(`${host} products collection`, {
          maxResults: 15,
          includeImages: false,
          searchDepth: "basic",
        });
        for (const r of r2) {
          if (hostOf(r.url) === host) addUrl(r.url);
        }
      }
    } catch {
      // Tavily unavailable — report zero products
    }
  }

  return {
    productUrls,
    stats: { sitemapUsed, collectionsCrawled, tavilyFallback, totalDiscovered: productUrls.length },
  };
}
