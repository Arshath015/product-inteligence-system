import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getVisibleInspirationIds } from "@/lib/inspirationVisibility";
import { computeCounts, type BulkIngestSummary, type BulkUrlResult } from "@/lib/bulk/pipeline";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function verifyProducts(projectId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const supabase = getSupabaseAdmin();
  const [{ data: existing }, { data: visible }] = await Promise.all([
    supabase.from("products").select("id").in("id", ids),
    supabase.from("project_products").select("product_id").eq("project_id", projectId).in("product_id", ids),
  ]);
  const existingIds = new Set((existing ?? []).map((r) => r.id as string));
  const visibleIds = new Set((visible ?? []).map((r) => r.product_id as string));
  return new Set(ids.filter((id) => existingIds.has(id) && visibleIds.has(id)));
}

async function verifyBrands(projectId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const supabase = getSupabaseAdmin();
  const [{ data: existing }, { data: visible }] = await Promise.all([
    supabase.from("brands").select("id").in("id", ids),
    supabase.from("project_brands").select("brand_id").eq("project_id", projectId).in("brand_id", ids),
  ]);
  const existingIds = new Set((existing ?? []).map((r) => r.id as string));
  const visibleIds = new Set((visible ?? []).map((r) => r.brand_id as string));
  return new Set(ids.filter((id) => existingIds.has(id) && visibleIds.has(id)));
}

async function verifyInspirations(projectId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const supabase = getSupabaseAdmin();
  const [visibleIds, { data: active }] = await Promise.all([
    getVisibleInspirationIds(projectId),
    supabase.from("inspirations").select("id").in("id", ids).eq("status", "active"),
  ]);
  const visible = new Set(visibleIds);
  const activeIds = new Set((active ?? []).map((r) => r.id as string));
  return new Set(ids.filter((id) => activeIds.has(id) && visible.has(id)));
}

/**
 * Re-queries the database for every entity a bulk run claims to have
 * created or saved, and rewrites the results to match reality — the
 * reported counts must describe what's actually persisted and visible to
 * this project, not just what each pipeline step believed it did in the
 * moment (a step can report success while an insert silently no-ops on a
 * race, a caught-and-swallowed error, etc.). Always call this on the full
 * summary before generating the text the user reads; the live per-URL
 * progress stream (sent before this runs) is best-effort and may disagree
 * with the final reconciled numbers in rare cases — that's expected, the
 * final summary is the authoritative one.
 */
export async function reconcileBulkSummary(projectId: string, summary: BulkIngestSummary): Promise<BulkIngestSummary> {
  const productIds = new Set<string>();
  const brandIds = new Set<string>();
  const inspirationIds = new Set<string>();

  const collect = (r: BulkUrlResult) => {
    if (r.status === "product_created" && r.product?.id) productIds.add(r.product.id);
    if (r.brandId) brandIds.add(r.brandId);
    if ((r.status === "manufacturer_saved" || r.status === "inspiration_saved") && r.inspiration?.id) {
      inspirationIds.add(r.inspiration.id);
    }
    for (const d of r.discovered ?? []) collect(d);
  };
  summary.results.forEach(collect);

  const [verifiedProducts, verifiedBrands, verifiedInspirations] = await Promise.all([
    verifyProducts(projectId, [...productIds]),
    verifyBrands(projectId, [...brandIds]),
    verifyInspirations(projectId, [...inspirationIds]),
  ]);

  const reconcileOne = (r: BulkUrlResult): BulkUrlResult => {
    let status = r.status;
    let message = r.message;
    let brandId = r.brandId;
    let brandCreated = r.brandCreated;

    if (status === "product_created" && (!r.product?.id || !verifiedProducts.has(r.product.id))) {
      status = "failed";
      message = `Couldn't confirm "${r.product?.name ?? hostOf(r.url)}" was actually saved to the catalogue.`;
    }
    if (
      (status === "manufacturer_saved" || status === "inspiration_saved") &&
      (!r.inspiration?.id || !verifiedInspirations.has(r.inspiration.id))
    ) {
      status = "failed";
      message = `Couldn't confirm that reference was actually saved.`;
    }
    if (brandId && !verifiedBrands.has(brandId)) {
      if (status === "brand_saved") {
        status = "failed";
        message = `Couldn't confirm a brand was actually saved from that page.`;
      }
      brandId = null;
      brandCreated = undefined;
    }

    const discovered = r.discovered ? r.discovered.map(reconcileOne) : undefined;
    return { ...r, status, message, brandId, brandCreated, discovered };
  };

  const results = summary.results.map(reconcileOne);
  return { total: summary.total, results, counts: computeCounts(results) };
}
