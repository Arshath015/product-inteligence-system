import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchPageSignals, type PageSignals } from "@/lib/pageSignals";
import { classifyFromPath, classifyFromSignals, type ContentKind } from "@/lib/bulk/classify";
import { discoverProductLinks } from "@/lib/bulk/discoverLinks";
import { ingestProductUrl } from "@/lib/ingest";
import { saveInspirationUrl } from "@/lib/inspiration";
import { resolveBrand } from "@/lib/catalog";
import { extractManufacturerInfo } from "@/lib/manufacturerExtraction";
import type { Product, Inspiration } from "@/lib/types";

export type BulkStatus =
  | "product_created"
  | "product_duplicate"
  | "brand_saved"
  | "collection_processed"
  | "gallery_saved"
  | "artisan_profile_saved"
  | "artisan_directory_saved"
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
  discovered?: BulkUrlResult[];
}

export interface BulkIngestSummary {
  total: number;
  results: BulkUrlResult[];
  counts: {
    productsAdded: number;
    brandsIdentified: number;
    inspirationSaved: number;
    duplicates: number;
    failed: number;
    discoveredProductsAdded: number;
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

async function processDiscovered(projectId: string, urls: string[]): Promise<BulkUrlResult[]> {
  if (urls.length === 0) return [];
  return runPool(urls, CONCURRENCY, async (url) => {
    const result = await ingestProductUrl(projectId, url).catch((err) => ({
      status: "failed" as const,
      product: null,
      message: (err as Error).message,
    }));
    return {
      url,
      kind: "product" as ContentKind,
      status: result.status === "created" ? "product_created" : result.status === "failed" ? "failed" : "product_duplicate",
      message: result.message,
      product: result.product,
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
 * reference) to Inspiration, enriching it with name/location/craft pulled
 * from the page via `extractManufacturerInfo` so the Manufacturers section
 * has real fields to display instead of a bare link.
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
      }));
      return {
        url,
        kind,
        status: result.status === "created" ? "product_created" : result.status === "failed" ? "failed" : "product_duplicate",
        message: result.message,
        product: result.product,
      };
    }

    case "collection":
    case "gallery": {
      const discoveredUrls = signals ? discoverProductLinks(signals, DISCOVERY_LIMIT) : [];
      if (discoveredUrls.length > 0) {
        const discovered = await processDiscovered(projectId, discoveredUrls);
        const added = discovered.filter((d) => d.status === "product_created").length;
        return {
          url,
          kind,
          status: kind === "collection" ? "collection_processed" : "gallery_saved",
          message: `Found ${discoveredUrls.length} product link(s) on this page — added ${added} new product(s).`,
          discovered,
        };
      }
      const result = await saveDirectoryEntry(projectId, url, signals, [kind]);
      return {
        url,
        kind,
        status: result.status === "created" ? "inspiration_saved" : result.status === "failed" ? "failed" : "inspiration_duplicate",
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
          status: result.status === "created" ? "inspiration_saved" : result.status === "failed" ? "failed" : "inspiration_duplicate",
          message: result.message,
          inspiration: result.inspiration,
        };
      }
      const brandName = guessBrandName(signals, url);
      const brandId = await resolveBrand(projectId, brandName, url).catch(() => null);
      if (brandId && signals.metaDescription) {
        const supabase = getSupabaseAdmin();
        await supabase
          .from("brands")
          .update({ description: signals.metaDescription.slice(0, 500) })
          .eq("id", brandId)
          .is("description", null);
      }
      const discoveredUrls = discoverProductLinks(signals, DISCOVERY_LIMIT);
      const discovered = discoveredUrls.length > 0 ? await processDiscovered(projectId, discoveredUrls) : [];
      const added = discovered.filter((d) => d.status === "product_created").length;
      return {
        url,
        kind,
        status: "brand_saved",
        message: brandId
          ? `Identified brand "${brandName}"${added > 0 ? ` and added ${added} product(s) from their site.` : "."}`
          : `Couldn't resolve a brand from that page.`,
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
        status:
          result.status === "created"
            ? kind === "artisan_profile"
              ? "artisan_profile_saved"
              : "artisan_directory_saved"
            : result.status === "failed"
              ? "failed"
              : "inspiration_duplicate",
        message: result.message,
        inspiration: result.inspiration,
      };
    }

    case "general":
    default: {
      if (!signals) {
        return { url, kind: "general", status: "failed", message: "Couldn't retrieve any readable content from that page." };
      }
      const result = await saveInspirationUrl(projectId, url, undefined, signals, ["reference"]).catch((err) => ({
        status: "failed" as const,
        inspiration: null,
        message: (err as Error).message,
      }));
      return {
        url,
        kind: "general",
        status: result.status === "created" ? "inspiration_saved" : result.status === "failed" ? "failed" : "inspiration_duplicate",
        message: result.message,
        inspiration: result.inspiration,
      };
    }
  }
}

/**
 * Processes every URL in `urls` independently with bounded concurrency —
 * one slow or failed site never blocks the rest, and every URL gets a
 * result (never silently dropped). Classification and extraction are
 * heuristic/structured-data first; an LLM call only happens inside
 * extractProductFromUrl when JSON-LD doesn't already give a complete
 * product record.
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

  const counts = {
    productsAdded: 0,
    brandsIdentified: 0,
    inspirationSaved: 0,
    duplicates: 0,
    failed: 0,
    discoveredProductsAdded: 0,
  };
  for (const r of results) {
    switch (r.status) {
      case "product_created":
        counts.productsAdded++;
        break;
      case "brand_saved":
        counts.brandsIdentified++;
        break;
      case "collection_processed":
      case "gallery_saved":
        // Only counts as an inspiration save when nothing was discovered —
        // when it found products, those are already counted separately via
        // discoveredProductsAdded below, so this URL isn't a bare reference.
        if (!r.discovered) counts.inspirationSaved++;
        break;
      case "inspiration_saved":
      case "artisan_profile_saved":
      case "artisan_directory_saved":
        counts.inspirationSaved++;
        break;
      case "product_duplicate":
      case "inspiration_duplicate":
        counts.duplicates++;
        break;
      case "failed":
        counts.failed++;
        break;
    }
    if (r.discovered) {
      counts.discoveredProductsAdded += r.discovered.filter((d) => d.status === "product_created").length;
    }
  }

  return { total: urls.length, results, counts };
}
