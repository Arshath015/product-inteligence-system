import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchPageSignals, type PageSignals } from "@/lib/pageSignals";
import { classifyFromPath, classifyFromSignals, type ContentKind } from "@/lib/bulk/classify";
import { discoverProductLinks } from "@/lib/bulk/discoverLinks";
import { ingestProductUrl } from "@/lib/ingest";
import { saveInspirationUrl } from "@/lib/inspiration";
import { resolveBrandDetailed } from "@/lib/catalog";
import { extractManufacturerInfo } from "@/lib/manufacturerExtraction";
import { tavilySearch } from "@/lib/tavily";
import type { Product, Inspiration } from "@/lib/types";

export type BulkStatus =
  | "product_created"
  | "product_duplicate"
  | "brand_saved"
  | "collection_processed"
  | "gallery_saved"
  | "manufacturer_saved"
  | "manufacturer_duplicate"
  | "inspiration_saved"
  | "inspiration_duplicate"
  | "failed";

export interface BulkUrlResult {
  url: string;
  kind: ContentKind;
  status: BulkStatus;
  message: string;
  product?: Product | null;
  inspiration?: Inspiration | null;
  /** Set whenever this URL's processing resolved a brand (directly, or via a product it created). */
  brandId?: string | null;
  /** True only when `brandId` was newly created by this call — false for a matched/existing brand. */
  brandCreated?: boolean;
  discovered?: BulkUrlResult[];
}

export interface BulkIngestSummary {
  total: number;
  results: BulkUrlResult[];
  counts: {
    productsAdded: number;
    discoveredProductsAdded: number;
    brandsCreated: number;
    brandsMatched: number;
    manufacturersSaved: number;
    inspirationSaved: number;
    duplicates: number;
    failed: number;
  };
}

const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 15_000;
const DISCOVERY_LIMIT = 4;

async function runPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function runner() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
  return results;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function fetchSignalsWithTimeout(url: string): Promise<PageSignals | null> {
  return Promise.race([
    fetchPageSignals(url).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
  ]);
}

function guessBrandName(signals: PageSignals | null, url: string): string {
  if (signals?.title) {
    const first = signals.title.split(/[|\-–—]/)[0]?.trim();
    if (first && first.length > 1 && first.length < 60) return first;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  } catch {
    return url;
  }
}

/**
 * Best-effort escalation when a collection/gallery/brand page's own HTML
 * has no discoverable product links — usually because its catalogue grid is
 * client-rendered and a plain fetch never sees it. Asks Tavily (which does
 * crawl/index JS-rendered pages) for pages on the same domain, then lets the
 * normal product-ingestion validation (name presence, generic-listing
 * rejection) decide which of those actually turn out to be real products.
 * Never throws — a failed search here just means no discovery happened,
 * same as the empty-array case this replaces.
 */
async function discoverViaSearch(url: string): Promise<string[]> {
  const host = hostOf(url);
  if (!host) return [];
  try {
    const { results } = await tavilySearch(`site:${host} product`, { maxResults: DISCOVERY_LIMIT, includeImages: false });
    return results.map((r) => r.url).filter((u) => u !== url && hostOf(u) === host);
  } catch {
    return [];
  }
}

async function processDiscovered(projectId: string, urls: string[]): Promise<BulkUrlResult[]> {
  if (urls.length === 0) return [];
  return runPool(urls, CONCURRENCY, async (url) => {
    const result = await ingestProductUrl(projectId, url).catch((err) => ({
      status: "failed" as const,
      product: null,
      message: (err as Error).message,
      brandCreated: undefined as boolean | undefined,
    }));
    return {
      url,
      kind: "product" as ContentKind,
      status: result.status === "created" ? "product_created" : result.status === "failed" ? "failed" : "product_duplicate",
      message: result.message,
      product: result.product,
      brandId: result.product?.brand?.id ?? null,
      brandCreated: result.brandCreated,
    };
  });
}

const KIND_LABEL: Record<ContentKind, string> = {
  pinterest: "Pinterest link",
  instagram: "Instagram link",
  product: "individual product page",
  collection: "collection/category page",
  brand: "brand website",
  gallery: "design gallery",
  artisan_profile: "artisan profile",
  artisan_directory: "artisan directory",
  general: "general page",
};

/**
 * Saves a directory-type entry (artisan/manufacturer/gallery/collection
 * reference) to the Manufacturers section — backed by the `inspirations`
 * table (tagged, `platform: "manufacturer"`) so it's never mixed into the
 * genuine Pinterest/Instagram Inspiration library, enriched with
 * name/location/craft pulled from the page via `extractManufacturerInfo` so
 * it has real fields to display instead of a bare link.
 */
async function saveDirectoryEntry(projectId: string, url: string, signals: PageSignals | null, tags: string[]) {
  const isDirectory = tags.includes("artisan-directory");
  const info = await extractManufacturerInfo(url, signals, isDirectory);
  const overrides = info
    ? { title: info.name, caption: info.location, description: info.craft ?? info.description }
    : undefined;
  return saveInspirationUrl(projectId, url, undefined, signals, tags, overrides).catch((err) => ({
    status: "failed" as const,
    inspiration: null,
    message: (err as Error).message,
  }));
}

function directoryStatus(saveStatus: "created" | "duplicate" | "failed"): BulkStatus {
  return saveStatus === "created" ? "manufacturer_saved" : saveStatus === "failed" ? "failed" : "manufacturer_duplicate";
}

async function processOneUrl(
  projectId: string,
  url: string,
  onPhase?: (text: string) => void
): Promise<BulkUrlResult> {
  const host = hostOf(url);
  onPhase?.(`Detecting and classifying ${host}…`);
  const pathKind = classifyFromPath(url);

  if (pathKind === "pinterest" || pathKind === "instagram") {
    onPhase?.(`${KIND_LABEL[pathKind]} — saving to Inspiration…`);
    const result = await saveInspirationUrl(projectId, url, pathKind).catch((err) => ({
      status: "failed" as const,
      inspiration: null,
      message: (err as Error).message,
    }));
    return {
      url,
      kind: pathKind,
      status: result.status === "created" ? "inspiration_saved" : result.status === "failed" ? "failed" : "inspiration_duplicate",
      message: result.message,
      inspiration: result.inspiration,
    };
  }

  const signals = await fetchSignalsWithTimeout(url);
  const kind = pathKind ?? classifyFromSignals(url, signals);
  onPhase?.(`Classified as ${KIND_LABEL[kind]} (${host}) — checking catalogue for duplicates…`);

  switch (kind) {
    case "product": {
      onPhase?.(`Extracting product details and retrieving image for ${host}…`);
      const result = await ingestProductUrl(projectId, url, signals).catch((err) => ({
        status: "failed" as const,
        product: null,
        message: (err as Error).message,
        brandCreated: undefined as boolean | undefined,
      }));
      return {
        url,
        kind,
        status: result.status === "created" ? "product_created" : result.status === "failed" ? "failed" : "product_duplicate",
        message: result.message,
        product: result.product,
        brandId: result.product?.brand?.id ?? null,
        brandCreated: result.brandCreated,
      };
    }

    case "collection":
    case "gallery": {
      let discoveredUrls = signals ? discoverProductLinks(signals, DISCOVERY_LIMIT) : [];
      if (discoveredUrls.length === 0) {
        onPhase?.(`No product links found directly on ${host} — searching for its products…`);
        discoveredUrls = await discoverViaSearch(url);
      }
      if (discoveredUrls.length > 0) {
        const discovered = await processDiscovered(projectId, discoveredUrls);
        const added = discovered.filter((d) => d.status === "product_created").length;
        const matched = discovered.filter((d) => d.status === "product_duplicate").length;
        // Only treat this as a successful collection/gallery pass if at
        // least one discovered link actually turned out to be a real
        // product — a Tavily site-search that only surfaces non-product
        // pages (about, shipping, etc.) must still fall through to the
        // directory-entry save below, not leave this URL with nothing
        // saved at all.
        if (added + matched > 0) {
          return {
            url,
            kind,
            status: kind === "collection" ? "collection_processed" : "gallery_saved",
            message: `Found ${discoveredUrls.length} product link(s) on this page — added ${added} new product(s).`,
            discovered,
          };
        }
      }
      const result = await saveDirectoryEntry(projectId, url, signals, [kind]);
      return {
        url,
        kind,
        status: directoryStatus(result.status),
        message: result.message,
        inspiration: result.inspiration,
      };
    }

    case "brand": {
      if (!signals) {
        const result = await saveDirectoryEntry(projectId, url, null, ["brand"]);
        return {
          url,
          kind,
          status: directoryStatus(result.status),
          message: result.message,
          inspiration: result.inspiration,
        };
      }
      const brandName = guessBrandName(signals, url);
      const resolvedBrand = await resolveBrandDetailed(projectId, brandName, url).catch(() => null);
      if (resolvedBrand && signals.metaDescription) {
        const supabase = getSupabaseAdmin();
        await supabase
          .from("brands")
          .update({ description: signals.metaDescription.slice(0, 500) })
          .eq("id", resolvedBrand.id)
          .is("description", null);
      }
      let discoveredUrls = discoverProductLinks(signals, DISCOVERY_LIMIT);
      if (discoveredUrls.length === 0) discoveredUrls = await discoverViaSearch(url);
      const discovered = discoveredUrls.length > 0 ? await processDiscovered(projectId, discoveredUrls) : [];
      const added = discovered.filter((d) => d.status === "product_created").length;
      return {
        url,
        kind,
        status: resolvedBrand ? "brand_saved" : "failed",
        message: resolvedBrand
          ? `Identified brand "${brandName}"${added > 0 ? ` and added ${added} product(s) from their site.` : "."}`
          : `Couldn't resolve a brand from that page.`,
        brandId: resolvedBrand?.id ?? null,
        brandCreated: resolvedBrand?.created,
        discovered: discovered.length > 0 ? discovered : undefined,
      };
    }

    case "artisan_profile":
    case "artisan_directory": {
      const tag = kind === "artisan_profile" ? "artisan" : "artisan-directory";
      const result = await saveDirectoryEntry(projectId, url, signals, [tag]);
      return {
        url,
        kind,
        status: directoryStatus(result.status),
        message: result.message,
        inspiration: result.inspiration,
      };
    }

    case "general":
    default: {
      if (!signals) {
        return { url, kind: "general", status: "failed", message: "Couldn't retrieve any readable content from that page." };
      }
      const result = await saveDirectoryEntry(projectId, url, signals, ["reference"]);
      return {
        url,
        kind: "general",
        status: directoryStatus(result.status),
        message: result.message,
        inspiration: result.inspiration,
      };
    }
  }
}

/** Tallies one result's brand resolution (direct or via a product it created) into `counts`, in place. */
function tallyBrand(counts: BulkIngestSummary["counts"], r: BulkUrlResult) {
  if (!r.brandId) return;
  if (r.brandCreated) counts.brandsCreated++;
  else counts.brandsMatched++;
}

/**
 * Deterministic tally from a results array — the single source of truth for
 * `BulkIngestSummary.counts`, used both for the initial pass and after
 * `reconcileBulkSummary` has verified/corrected statuses, so the two never
 * disagree on how a given status maps to a count.
 */
export function computeCounts(results: BulkUrlResult[]): BulkIngestSummary["counts"] {
  const counts = {
    productsAdded: 0,
    discoveredProductsAdded: 0,
    brandsCreated: 0,
    brandsMatched: 0,
    manufacturersSaved: 0,
    inspirationSaved: 0,
    duplicates: 0,
    failed: 0,
  };
  for (const r of results) {
    switch (r.status) {
      case "product_created":
        counts.productsAdded++;
        tallyBrand(counts, r);
        break;
      case "brand_saved":
        tallyBrand(counts, r);
        break;
      case "manufacturer_saved":
        counts.manufacturersSaved++;
        break;
      case "inspiration_saved":
        counts.inspirationSaved++;
        break;
      case "product_duplicate":
      case "manufacturer_duplicate":
      case "inspiration_duplicate":
        counts.duplicates++;
        tallyBrand(counts, r);
        break;
      case "failed":
        counts.failed++;
        break;
      // "collection_processed" / "gallery_saved" carry no direct tally of
      // their own — their value flows entirely through `discovered` below.
    }
    for (const d of r.discovered ?? []) {
      if (d.status === "product_created") counts.discoveredProductsAdded++;
      if (d.status === "product_created" || d.status === "product_duplicate") tallyBrand(counts, d);
    }
  }
  return counts;
}

/**
 * Processes every URL in `urls` independently with bounded concurrency —
 * one slow or failed site never blocks the rest, and every URL gets a
 * result (never silently dropped). Classification and extraction are
 * heuristic/structured-data first; an LLM call only happens inside
 * extractProductFromUrl when JSON-LD doesn't already give a complete
 * product record. Counts here reflect what the pipeline BELIEVES it did —
 * callers that need a response that's safe to quote exact numbers from
 * should pass this through `reconcileBulkSummary` first, which verifies
 * against the database.
 */
export async function processBulkUrls(
  projectId: string,
  urls: string[],
  onResult?: (result: BulkUrlResult) => void,
  onPhase?: (url: string, text: string) => void
): Promise<BulkIngestSummary> {
  const results = await runPool(urls, CONCURRENCY, async (url) => {
    const result = await processOneUrl(projectId, url, (text) => onPhase?.(url, text)).catch(
      (err): BulkUrlResult => ({ url, kind: "general", status: "failed", message: (err as Error).message }),
    );
    onResult?.(result);
    return result;
  });

  return { total: urls.length, results, counts: computeCounts(results) };
}
