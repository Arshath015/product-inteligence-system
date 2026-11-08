import type { BulkIngestSummary, BulkStatus, BulkUrlResult } from "@/lib/bulk/pipeline";
import type { ContentKind } from "@/lib/bulk/classify";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Coarse category for UI styling (faded/neutral/red) of a progress line. */
export function uiStatus(status: BulkStatus): "success" | "duplicate" | "failed" {
  if (status === "failed") return "failed";
  if (status === "product_duplicate" || status === "manufacturer_duplicate" || status === "inspiration_duplicate") {
    return "duplicate";
  }
  return "success";
}

const DIRECTORY_KIND_LABEL: Partial<Record<ContentKind, string>> = {
  artisan_profile: "Artisan profile",
  artisan_directory: "Artisan directory",
  gallery: "Gallery reference",
  collection: "Collection reference",
  brand: "Brand reference",
  general: "Reference",
};

/** One human-readable progress line per processed URL, streamed as it completes. */
export function describeResult(r: BulkUrlResult, indent = ""): string {
  const host = hostOf(r.url);
  switch (r.status) {
    case "product_created":
      return `${indent}✓ Product added — "${r.product?.name ?? host}"${r.product?.brand?.name ? ` by ${r.product.brand.name}` : ""}`;
    case "product_duplicate":
      return `${indent}• Already in the catalogue — "${r.product?.name ?? host}"`;
    case "brand_saved":
      return `${indent}✓ ${r.message}`;
    case "collection_processed":
      return `${indent}✓ Collection page (${host}) — ${r.message}`;
    case "gallery_saved":
      return `${indent}✓ Gallery page (${host}) — ${r.message}`;
    case "manufacturer_saved":
      return `${indent}✓ ${DIRECTORY_KIND_LABEL[r.kind] ?? "Manufacturer"} saved to Manufacturers — "${r.inspiration?.title ?? host}"`;
    case "manufacturer_duplicate":
      return `${indent}• Already saved to Manufacturers (${host})`;
    case "inspiration_saved":
      return `${indent}✓ Saved to Inspiration — "${r.inspiration?.title ?? host}"`;
    case "inspiration_duplicate":
      return `${indent}• Already saved to Inspiration (${host})`;
    case "failed":
      return `${indent}✗ Failed — ${host}: ${r.message}`;
    default:
      return `${indent}${host}: ${r.message}`;
  }
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function getFailedUrls(summary: BulkIngestSummary): string[] {
  return summary.results.filter((r) => r.status === "failed").map((r) => r.url);
}

/** Deterministic completion summary — no LLM call, exact counts every time. */
export function summarizeBulk(summary: BulkIngestSummary): string {
  const c = summary.counts;
  const parts: string[] = [];
  if (c.productsAdded > 0) parts.push(`${pluralize(c.productsAdded, "product")} added`);
  if (c.discoveredProductsAdded > 0) {
    parts.push(`${pluralize(c.discoveredProductsAdded, "additional product")} discovered on collection/brand pages`);
  }
  if (c.brandsCreated > 0) parts.push(`${pluralize(c.brandsCreated, "new brand")} identified`);
  if (c.brandsMatched > 0) parts.push(`${pluralize(c.brandsMatched, "brand")} matched to existing records`);
  if (c.manufacturersSaved > 0) parts.push(`${pluralize(c.manufacturersSaved, "manufacturer/artisan reference")} saved`);
  if (c.inspirationSaved > 0) parts.push(`${pluralize(c.inspirationSaved, "inspiration reference")} saved`);
  if (c.duplicates > 0) parts.push(`${pluralize(c.duplicates, "duplicate")} skipped`);
  if (c.failed > 0) parts.push(`${pluralize(c.failed, "URL")} failed`);

  const body = parts.length > 0 ? parts.join(", ") : "nothing usable found";
  return `${pluralize(summary.total, "link")} processed: ${body}.`;
}
