import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { Product } from "@/lib/types";

const SELECT_WITH_RELATIONS =
  "*, brand:brands(*), designer:designers(*), category:categories(*), images:product_images(*)";

/** Fetches a product only if it's visible (owned or referenced) in the given project. */
export async function getProductWithRelations(id: string, projectId?: string): Promise<Product | null> {
  const supabase = getSupabaseAdmin();
  if (projectId) {
    const { data: visible } = await supabase
      .from("project_products")
      .select("product_id")
      .eq("project_id", projectId)
      .eq("product_id", id)
      .maybeSingle();
    if (!visible) return null;
  }
  const { data } = await supabase
    .from("products")
    .select(SELECT_WITH_RELATIONS)
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  const product = data as unknown as Product;
  if (projectId) (product as Product & { is_owner?: boolean }).is_owner = product.project_id === projectId;
  return product;
}

export async function logActivity(
  action: string,
  entityType?: string,
  entityId?: string,
  details?: Record<string, unknown>
) {
  const supabase = getSupabaseAdmin();
  await supabase.from("activity_log").insert({
    action,
    entity_type: entityType ?? null,
    entity_id: entityId ?? null,
    details: details ?? null,
  });
}

export interface ProductFilters {
  projectId: string;
  q?: string;
  categorySlug?: string;
  brandSlug?: string;
  status?: string;
  limit?: number;
  offset?: number;
  sort?: "newest" | "name";
}

/** Lists products VISIBLE to a project (owned + referenced from other projects via the reuse mechanism). */
export async function listProducts(filters: ProductFilters): Promise<{ products: Product[]; total: number }> {
  const supabase = getSupabaseAdmin();
  const limit = Math.min(filters.limit ?? 60, 120);
  const offset = filters.offset ?? 0;

  const { data: visibleRows } = await supabase
    .from("project_products")
    .select("product_id")
    .eq("project_id", filters.projectId);
  const visibleIds = (visibleRows ?? []).map((r) => r.product_id as string);
  if (visibleIds.length === 0) return { products: [], total: 0 };

  let query = supabase.from("products").select(SELECT_WITH_RELATIONS, { count: "exact" }).in("id", visibleIds);
  const status = filters.status ?? "published";
  if (status !== "all") query = query.eq("status", status);

  if (filters.categorySlug) {
    const { data: cat } = await supabase
      .from("categories")
      .select("id")
      .eq("slug", filters.categorySlug)
      .maybeSingle();
    query = query.eq("category_id", cat?.id ?? "00000000-0000-0000-0000-000000000000");
  }

  if (filters.brandSlug) {
    const { data: visibleBrandRows } = await supabase
      .from("project_brands")
      .select("brand_id")
      .eq("project_id", filters.projectId);
    const visibleBrandIds = (visibleBrandRows ?? []).map((r) => r.brand_id as string);
    const { data: brand } = await supabase
      .from("brands")
      .select("id")
      .eq("slug", filters.brandSlug)
      .in("id", visibleBrandIds.length > 0 ? visibleBrandIds : ["00000000-0000-0000-0000-000000000000"])
      .maybeSingle();
    query = query.eq("brand_id", brand?.id ?? "00000000-0000-0000-0000-000000000000");
  }

  if (filters.q) {
    query = query.or(`name.ilike.%${filters.q}%,description.ilike.%${filters.q}%,materials.ilike.%${filters.q}%`);
  }

  query =
    filters.sort === "name"
      ? query.order("name", { ascending: true })
      : query.order("created_at", { ascending: false });
  query = query.range(offset, offset + limit - 1);

  const { data, count, error } = await query;
  if (error) throw new Error(error.message);
  const products = ((data as unknown as Product[]) ?? []).map((p) => ({
    ...p,
    is_owner: p.project_id === filters.projectId,
  }));
  return { products, total: count ?? 0 };
}

export const PRODUCT_SELECT_WITH_RELATIONS = SELECT_WITH_RELATIONS;
