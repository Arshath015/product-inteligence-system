import { getSupabaseAdmin } from "@/lib/supabase/server";

export interface Project {
  id: string;
  name: string;
  client_name: string | null;
  description: string | null;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}

export interface ProjectStats {
  product_count: number;
  brand_count: number;
  inspiration_count: number;
  conversation_count: number;
  last_activity: string | null;
}

export async function listProjects(status: "active" | "archived" = "active") {
  const supabase = getSupabaseAdmin();
  const { data: projects } = await supabase
    .from("projects")
    .select("*")
    .eq("status", status)
    .order("updated_at", { ascending: false });

  if (!projects || projects.length === 0) return [];

  const withStats = await Promise.all(
    projects.map(async (p) => {
      const { data: stats } = await supabase.rpc("project_stats", { p_project_id: p.id }).maybeSingle();
      return { ...p, stats: (stats as ProjectStats) ?? null };
    })
  );
  return withStats;
}

export async function getProject(id: string) {
  const supabase = getSupabaseAdmin();
  const { data: project } = await supabase.from("projects").select("*").eq("id", id).maybeSingle();
  if (!project) return null;
  const { data: stats } = await supabase.rpc("project_stats", { p_project_id: id }).maybeSingle();
  return { ...project, stats: (stats as ProjectStats) ?? null };
}

export async function createProject(input: { name: string; clientName?: string | null; description?: string | null }) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("projects")
    .insert({
      name: input.name,
      client_name: input.clientName ?? null,
      description: input.description ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as Project;
}

export async function updateProject(
  id: string,
  patch: Partial<{ name: string; clientName: string | null; description: string | null; status: "active" | "archived" }>
) {
  const supabase = getSupabaseAdmin();
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.clientName !== undefined) row.client_name = patch.clientName;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.status !== undefined) row.status = patch.status;

  const { data, error } = await supabase.from("projects").update(row).eq("id", id).select("*").single();
  if (error) throw new Error(error.message);
  return data as Project;
}

export interface DeleteProjectResult {
  status: "deleted" | "blocked";
  reason?: string;
}

/**
 * Hard-deletes a project and everything it owns — but refuses if it owns
 * any product/brand that another project still references, so a delete
 * here can never silently break another project's catalogue. Archiving
 * (updateProject status: 'archived') is always safe and doesn't need this
 * check since nothing is removed.
 */
export async function deleteProject(id: string): Promise<DeleteProjectResult> {
  const supabase = getSupabaseAdmin();

  const [{ data: ownedProducts }, { data: ownedBrands }, { data: ownedInspirationsEarly }] = await Promise.all([
    supabase.from("products").select("id").eq("project_id", id),
    supabase.from("brands").select("id").eq("project_id", id),
    supabase.from("inspirations").select("id").eq("project_id", id),
  ]);

  const ownedProductIds = (ownedProducts ?? []).map((p) => p.id as string);
  const ownedBrandIds = (ownedBrands ?? []).map((b) => b.id as string);
  const ownedInspirationIds = (ownedInspirationsEarly ?? []).map((i) => i.id as string);

  const [productRefs, brandRefs, inspirationRefs] = await Promise.all([
    ownedProductIds.length > 0
      ? supabase.from("project_products").select("product_id").in("product_id", ownedProductIds).neq("project_id", id)
      : Promise.resolve({ data: [] as { product_id: string }[] }),
    ownedBrandIds.length > 0
      ? supabase.from("project_brands").select("brand_id").in("brand_id", ownedBrandIds).neq("project_id", id)
      : Promise.resolve({ data: [] as { brand_id: string }[] }),
    ownedInspirationIds.length > 0
      ? supabase
          .from("project_inspirations")
          .select("inspiration_id")
          .in("inspiration_id", ownedInspirationIds)
          .neq("project_id", id)
      : Promise.resolve({ data: [] as { inspiration_id: string }[] }),
  ]);

  if (productRefs.data && productRefs.data.length > 0) {
    const count = new Set(productRefs.data.map((r) => r.product_id)).size;
    return {
      status: "blocked",
      reason: `${count} product(s) owned by this project are still referenced by other projects. Remove those references first.`,
    };
  }
  if (brandRefs.data && brandRefs.data.length > 0) {
    const count = new Set(brandRefs.data.map((r) => r.brand_id)).size;
    return {
      status: "blocked",
      reason: `${count} brand(s) owned by this project are still referenced by other projects. Remove those references first.`,
    };
  }
  if (inspirationRefs.data && inspirationRefs.data.length > 0) {
    const count = new Set(inspirationRefs.data.map((r) => r.inspiration_id)).size;
    return {
      status: "blocked",
      reason: `${count} inspiration(s) owned by this project are still referenced by other projects. Remove those references first.`,
    };
  }

  // These six are independent of each other — run them concurrently instead
  // of one-by-one so a project with a lot of history doesn't take many
  // sequential round-trips (and feel like the delete silently did nothing)
  // before the row actually disappears.
  const cascadeResults = await Promise.all([
    supabase.from("conversations").delete().eq("project_id", id),
    supabase.from("memory_items").delete().eq("project_id", id),
    supabase.from("assistant_memory").delete().eq("project_id", id),
    supabase.from("inspirations").delete().eq("project_id", id),
    supabase.from("research_jobs").delete().eq("project_id", id),
    supabase.from("pending_discoveries").delete().eq("project_id", id),
  ]);
  const cascadeError = cascadeResults.find((r) => r.error)?.error;
  if (cascadeError) throw new Error(cascadeError.message);

  const ownedDeleteResults = await Promise.all([
    ownedProductIds.length > 0
      ? supabase.from("products").delete().eq("project_id", id)
      : Promise.resolve({ error: null }),
    ownedBrandIds.length > 0 ? supabase.from("brands").delete().eq("project_id", id) : Promise.resolve({ error: null }),
  ]);
  const ownedDeleteError = ownedDeleteResults.find((r) => r.error)?.error;
  if (ownedDeleteError) throw new Error(ownedDeleteError.message);

  const { error: projectError } = await supabase.from("projects").delete().eq("id", id);
  if (projectError) throw new Error(projectError.message);

  return { status: "deleted" };
}

export interface ReuseSelection {
  sourceProjectId: string;
  productIds?: string[]; // omit/undefined = none; pass explicit ids to select specific ones
  brandIds?: string[];
  inspirationIds?: string[];
  allProducts?: boolean;
  allBrands?: boolean;
  allInspirations?: boolean;
}

/**
 * Links selected products/brands/inspirations from a source project into
 * the target project by inserting reference rows — never copies the
 * underlying record and never touches the source project.
 */
export async function reuseFromProject(targetProjectId: string, selection: ReuseSelection) {
  const supabase = getSupabaseAdmin();
  const { sourceProjectId } = selection;

  let productIds = selection.productIds ?? [];
  if (selection.allProducts) {
    const { data } = await supabase.from("project_products").select("product_id").eq("project_id", sourceProjectId);
    productIds = (data ?? []).map((r) => r.product_id as string);
  }

  let brandIds = selection.brandIds ?? [];
  if (selection.allBrands) {
    const { data } = await supabase.from("project_brands").select("brand_id").eq("project_id", sourceProjectId);
    brandIds = (data ?? []).map((r) => r.brand_id as string);
  }

  let inspirationIds = selection.inspirationIds ?? [];
  if (selection.allInspirations) {
    const { data } = await supabase
      .from("project_inspirations")
      .select("inspiration_id")
      .eq("project_id", sourceProjectId);
    inspirationIds = (data ?? []).map((r) => r.inspiration_id as string);
  }

  if (productIds.length > 0) {
    await supabase
      .from("project_products")
      .upsert(
        productIds.map((product_id) => ({ project_id: targetProjectId, product_id })),
        { onConflict: "project_id,product_id", ignoreDuplicates: true }
      );
  }
  if (brandIds.length > 0) {
    await supabase
      .from("project_brands")
      .upsert(
        brandIds.map((brand_id) => ({ project_id: targetProjectId, brand_id })),
        { onConflict: "project_id,brand_id", ignoreDuplicates: true }
      );
  }
  if (inspirationIds.length > 0) {
    await supabase
      .from("project_inspirations")
      .upsert(
        inspirationIds.map((inspiration_id) => ({ project_id: targetProjectId, inspiration_id })),
        { onConflict: "project_id,inspiration_id", ignoreDuplicates: true }
      );
  }

  return { productsLinked: productIds.length, brandsLinked: brandIds.length, inspirationsLinked: inspirationIds.length };
}

export async function removeProductReference(projectId: string, productId: string) {
  const supabase = getSupabaseAdmin();
  await supabase.from("project_products").delete().eq("project_id", projectId).eq("product_id", productId);
}

export async function removeBrandReference(projectId: string, brandId: string) {
  const supabase = getSupabaseAdmin();
  await supabase.from("project_brands").delete().eq("project_id", projectId).eq("brand_id", brandId);
}

export async function removeInspirationReference(projectId: string, inspirationId: string) {
  const supabase = getSupabaseAdmin();
  await supabase.from("project_inspirations").delete().eq("project_id", projectId).eq("inspiration_id", inspirationId);
}
