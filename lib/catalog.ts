import { getSupabaseAdmin } from "@/lib/supabase/server";
import { slugify } from "@/lib/slug";

/**
 * Finds a brand among those VISIBLE to this project (owned or referenced
 * from another project via the reuse mechanism) by fuzzy name match, or
 * creates a new brand OWNED by this project if nothing close exists.
 * Never matches against another project's brands that haven't been
 * explicitly referenced into this one — that would leak data across the
 * project boundary.
 */
export async function resolveBrand(
  projectId: string,
  name: string | null,
  websiteUrl?: string | null
): Promise<string | null> {
  if (!name || !name.trim()) return null;
  const supabase = getSupabaseAdmin();
  const trimmed = name.trim();

  const { data: similar } = await supabase.rpc("find_similar_brands", {
    p_project_id: projectId,
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
    .eq("project_id", projectId)
    .eq("slug", slug)
    .maybeSingle();
  if (existingBySlug) {
    await ensureBrandVisible(projectId, existingBySlug.id as string);
    return existingBySlug.id as string;
  }

  const { data: created, error } = await supabase
    .from("brands")
    .insert({ project_id: projectId, name: trimmed, slug, website_url: websiteUrl ?? null })
    .select("id")
    .single();
  if (error) {
    // Slug collision race — fetch the one that just got created elsewhere.
    const { data: retry } = await supabase
      .from("brands")
      .select("id")
      .eq("project_id", projectId)
      .eq("slug", slug)
      .maybeSingle();
    if (retry) await ensureBrandVisible(projectId, retry.id as string);
    return (retry?.id as string) ?? null;
  }
  await ensureBrandVisible(projectId, created.id as string);
  return created.id as string;
}

async function ensureBrandVisible(projectId: string, brandId: string) {
  const supabase = getSupabaseAdmin();
  await supabase
    .from("project_brands")
    .upsert({ project_id: projectId, brand_id: brandId }, { onConflict: "project_id,brand_id", ignoreDuplicates: true });
}

async function ensureProductVisible(projectId: string, productId: string) {
  const supabase = getSupabaseAdmin();
  await supabase
    .from("project_products")
    .upsert(
      { project_id: projectId, product_id: productId },
      { onConflict: "project_id,product_id", ignoreDuplicates: true }
    );
}

/** Designers are shared reference data (not client-specific), same as categories — no project scoping. */
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

/**
 * Duplicate detection order: canonical URL first, then fuzzy name match
 * within the same brand — scoped to products VISIBLE to this project
 * (owned or referenced), never across the project boundary implicitly.
 */
export async function findDuplicateProduct(opts: {
  projectId: string;
  canonicalUrl: string | null;
  name: string;
  brandId: string | null;
}): Promise<DuplicateMatch | null> {
  const supabase = getSupabaseAdmin();

  if (opts.canonicalUrl) {
    const { data: visibleIds } = await supabase
      .from("project_products")
      .select("product_id")
      .eq("project_id", opts.projectId);
    const ids = (visibleIds ?? []).map((r) => r.product_id as string);
    if (ids.length > 0) {
      const { data } = await supabase
        .from("products")
        .select("id")
        .eq("canonical_url", opts.canonicalUrl)
        .in("id", ids)
        .maybeSingle();
      if (data) return { productId: data.id as string, reason: "canonical_url" };
    }
  }

  const { data: similar } = await supabase.rpc("find_similar_products", {
    p_project_id: opts.projectId,
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

export { ensureProductVisible };
