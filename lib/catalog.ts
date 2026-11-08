import { getSupabaseAdmin } from "@/lib/supabase/server";
import { slugify } from "@/lib/slug";

export interface ResolvedBrand {
  id: string;
  /** True only when this call inserted a brand row that didn't exist before — false for every match (fuzzy, slug, or race-recovery). */
  created: boolean;
}

/**
 * True if one name is a word-boundary prefix of the other once both are
 * lowercased — e.g. "CVL" vs "CVL Luminaires", "Mint" vs "Mint Gallery".
 * This catches extraction variance (a short form vs. the fuller name from a
 * different source page) that trigram similarity often misses because the
 * strings differ too much in length to score as "similar" despite one
 * clearly being a short form of the other. Rejects partial-word matches
 * ("Cat" vs "Cattelan") by requiring the character right after the shared
 * prefix to be a boundary (end-of-string or non-alphanumeric).
 */
function isPrefixOf(shorter: string, longer: string): boolean {
  if (shorter.length < 2 || !longer.startsWith(shorter)) return false;
  const nextChar = longer[shorter.length];
  return nextChar === undefined || !/[a-z0-9]/i.test(nextChar);
}

function brandNamesLikelyMatch(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na === nb) return true;
  return na.length <= nb.length ? isPrefixOf(na, nb) : isPrefixOf(nb, na);
}

/**
 * Finds a brand among those VISIBLE to this project (owned or referenced
 * from another project via the reuse mechanism) by fuzzy name match, or
 * creates a new brand OWNED by this project if nothing close exists.
 * Never matches against another project's brands that haven't been
 * explicitly referenced into this one — that would leak data across the
 * project boundary. Reports whether the brand was newly created so callers
 * can report accurate "new vs. matched" counts instead of treating every
 * resolution as a fresh identification.
 */
export async function resolveBrandDetailed(
  projectId: string,
  name: string | null,
  websiteUrl?: string | null
): Promise<ResolvedBrand | null> {
  if (!name || !name.trim()) return null;
  const supabase = getSupabaseAdmin();
  const trimmed = name.trim();

  const { data: similar } = await supabase.rpc("find_similar_brands", {
    p_project_id: projectId,
    p_name: trimmed,
    p_threshold: 0.6,
  });
  if (similar && similar.length > 0) {
    return { id: similar[0].id as string, created: false };
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
    return { id: existingBySlug.id as string, created: false };
  }

  // Trigram similarity scores short-vs-full-name pairs ("CVL" vs "CVL
  // Luminaires") too low to match even though one is clearly a short form of
  // the other — check prefix containment against every brand already
  // visible to this project before concluding none exists.
  const { data: visibleBrands } = await supabase
    .from("project_brands")
    .select("brand:brands(id, name)")
    .eq("project_id", projectId);
  for (const row of visibleBrands ?? []) {
    const brand = Array.isArray(row.brand) ? row.brand[0] : row.brand;
    if (brand && brandNamesLikelyMatch(trimmed, brand.name as string)) {
      return { id: brand.id as string, created: false };
    }
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
    return retry ? { id: retry.id as string, created: false } : null;
  }
  await ensureBrandVisible(projectId, created.id as string);
  return { id: created.id as string, created: true };
}

/** Convenience wrapper over {@link resolveBrandDetailed} for callers that only need the id. */
export async function resolveBrand(
  projectId: string,
  name: string | null,
  websiteUrl?: string | null
): Promise<string | null> {
  const resolved = await resolveBrandDetailed(projectId, name, websiteUrl);
  return resolved?.id ?? null;
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
