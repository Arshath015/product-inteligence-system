import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { Product } from "@/lib/types";

const SELECT_WITH_RELATIONS =
  "*, brand:brands(*), designer:designers(*), category:categories(*), images:product_images(*)";

export async function getProductWithRelations(id: string): Promise<Product | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("products")
    .select(SELECT_WITH_RELATIONS)
    .eq("id", id)
    .maybeSingle();
  return (data as unknown as Product) ?? null;
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
  q?: string;
  categorySlug?: string;
  brandSlug?: string;
  status?: string;
  limit?: number;
  offset?: number;
  sort?: "newest" | "name";
}

export async function listProducts(filters: ProductFilters): Promise<{ products: Product[]; total: number }> {
  const supabase = getSupabaseAdmin();
  const limit = Math.min(filters.limit ?? 60, 120);
  const offset = filters.offset ?? 0;

  let query = supabase.from("products").select(SELECT_WITH_RELATIONS, { count: "exact" });
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
    const { data: brand } = await supabase
      .from("brands")
      .select("id")
      .eq("slug", filters.brandSlug)
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
  return { products: (data as unknown as Product[]) ?? [], total: count ?? 0 };
}

export const PRODUCT_SELECT_WITH_RELATIONS = SELECT_WITH_RELATIONS;
