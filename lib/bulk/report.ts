import type { BulkIngestSummary, BulkStatus, BulkUrlResult } from "@/lib/bulk/pipeline";

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
  if (status === "product_duplicate" || status === "inspiration_duplicate") return "duplicate";
  return "success";
}

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
    case "artisan_profile_saved":
      return `${indent}✓ Artisan profile saved — "${r.inspiration?.title ?? host}"`;
    case "artisan_directory_saved":
      return `${indent}✓ Artisan directory saved for reference (${host})`;
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
  if (c.brandsIdentified > 0) parts.push(`${pluralize(c.brandsIdentified, "brand")} identified`);
  if (c.inspirationSaved > 0) parts.push(`${pluralize(c.inspirationSaved, "inspiration reference")} saved`);
  if (c.duplicates > 0) parts.push(`${pluralize(c.duplicates, "duplicate")}`);
  if (c.failed > 0) parts.push(`${pluralize(c.failed, "unsuccessful extraction")}`);

  const extra =
    c.discoveredProductsAdded > 0
      ? ` (plus ${pluralize(c.discoveredProductsAdded, "additional product")} discovered on collection/brand pages)`
      : "";

  const body = parts.length > 0 ? parts.join(", ") : "nothing usable found";
  return `${pluralize(summary.total, "link")} processed: ${body}.${extra}`;
}
