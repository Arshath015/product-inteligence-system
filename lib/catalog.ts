import { getSupabaseAdmin } from "@/lib/supabase/server";
import { slugify } from "@/lib/slug";

/** Finds a brand by fuzzy name match, or creates it if nothing close exists. */
export async function resolveBrand(
  name: string | null,
  websiteUrl?: string | null
): Promise<string | null> {
  if (!name || !name.trim()) return null;
  const supabase = getSupabaseAdmin();
  const trimmed = name.trim();

  const { data: similar } = await supabase.rpc("find_similar_brands", {
    p_name: trimmed,
    p_threshold: 0.6,
  });
  if (similar && similar.length > 0) {
    return similar[0].id as string;
  }

  const slug = slugify(trimmed);
  const { data: existingBySlug } = await supabase
    .from("brands")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (existingBySlug) return existingBySlug.id as string;

  const { data: created, error } = await supabase
    .from("brands")
    .insert({ name: trimmed, slug, website_url: websiteUrl ?? null })
    .select("id")
    .single();
  if (error) {
    // Slug collision race — fetch the one that just got created elsewhere.
    const { data: retry } = await supabase
      .from("brands")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    return (retry?.id as string) ?? null;
  }
  return created.id as string;
}

export async function resolveDesigner(name: string | null): Promise<string | null> {
  if (!name || !name.trim()) return null;
  const supabase = getSupabaseAdmin();
  const trimmed = name.trim();
  const slug = slugify(trimmed);

  const { data: existing } = await supabase
    .from("designers")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (existing) return existing.id as string;

  const { data: created, error } = await supabase
    .from("designers")
    .insert({ name: trimmed, slug })
    .select("id")
    .single();
  if (error) {
    const { data: retry } = await supabase
      .from("designers")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    return (retry?.id as string) ?? null;
  }
  return created.id as string;
}

export async function resolveCategory(slugOrName: string | null): Promise<string | null> {
  if (!slugOrName) return null;
  const supabase = getSupabaseAdmin();
  const slug = slugify(slugOrName);
  const { data } = await supabase
    .from("categories")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (data) return data.id as string;
  const { data: other } = await supabase
    .from("categories")
    .select("id")
    .eq("slug", "other")
    .maybeSingle();
  return (other?.id as string) ?? null;
}

export interface DuplicateMatch {
  productId: string;
  reason: "canonical_url" | "name_similarity";
  similarity?: number;
}

/** Duplicate detection order: canonical URL first, then fuzzy name match within the same brand. */
export async function findDuplicateProduct(opts: {
  canonicalUrl: string | null;
  name: string;
  brandId: string | null;
}): Promise<DuplicateMatch | null> {
  const supabase = getSupabaseAdmin();

  if (opts.canonicalUrl) {
    const { data } = await supabase
      .from("products")
      .select("id")
      .eq("canonical_url", opts.canonicalUrl)
      .maybeSingle();
    if (data) return { productId: data.id as string, reason: "canonical_url" };
  }

  const { data: similar } = await supabase.rpc("find_similar_products", {
    p_name: opts.name,
    p_brand_id: opts.brandId,
    p_threshold: 0.5,
  });
  if (similar && similar.length > 0) {
    return {
      productId: similar[0].id as string,
      reason: "name_similarity",
      similarity: similar[0].similarity as number,
    };
  }

  return null;
}
