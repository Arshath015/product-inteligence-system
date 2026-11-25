import { nanoid } from "nanoid";
import { resolveBrandDetailed, resolveDesigner } from "@/lib/catalog";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { slugify } from "@/lib/slug";

type CopyImage = {
  original_url: string | null;
  storage_path: string | null;
  public_url: string | null;
  is_primary: boolean;
  status: "pending" | "stored" | "failed" | "missing";
  width: number | null;
  height: number | null;
};

type CopyProduct = {
  id: string;
  name: string;
  slug: string;
  source_url: string | null;
  canonical_url: string | null;
  source_domain: string | null;
  description: string | null;
  materials: string | null;
  dimensions: string | null;
  price_text: string | null;
  category_id: string | null;
  designer_id: string | null;
  designer_name: string | null;
  brand_name: string | null;
  brand_website_url: string | null;
  images: CopyImage[];
};

function relatedName(value: unknown): { name: string; website_url: string | null } | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || typeof (row as Record<string, unknown>).name !== "string") return null;
  const brand = row as Record<string, unknown>;
  return {
    name: brand.name as string,
    website_url: typeof brand.website_url === "string" ? brand.website_url : null,
  };
}

export async function copyProductsIntoProject(input: {
  targetProjectId: string;
  productIds: string[];
  source: { type: "library" } | { type: "project"; projectId: string };
}) {
  const supabase = getSupabaseAdmin();
  const ids = [...new Set(input.productIds)].filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return { added: 0, duplicates: 0 };

  let sourceProducts: CopyProduct[] = [];
  if (input.source.type === "library") {
    const { data, error } = await supabase
      .from("brand_catalogue_products")
      .select("id, name, slug, source_url, description, materials, dimensions, price_text, category_id, designer_name, brand_name, brand_website_url, images, primary_image_url, image_storage_path, image_public_url, image_status")
      .in("id", ids);
    if (error) throw new Error(error.message);
    sourceProducts = (data ?? []).map((row) => {
      const sourceImages = Array.isArray(row.images) ? row.images as string[] : [];
      const storedImage: CopyImage[] = row.image_status === "stored" && row.image_public_url
        ? [{
            original_url: sourceImages[0] ?? row.primary_image_url,
            storage_path: row.image_storage_path,
            public_url: row.image_public_url,
            is_primary: true,
            status: "stored",
            width: null,
            height: null,
          }, ...sourceImages.slice(1).map((url) => ({
            original_url: url,
            storage_path: null,
            public_url: null,
            is_primary: false,
            status: "pending" as const,
            width: null,
            height: null,
          }))]
        : sourceImages.map((url, index) => ({
            original_url: url,
            storage_path: null,
            public_url: null,
            is_primary: index === 0,
            status: "pending" as const,
            width: null,
            height: null,
          }));
      return {
        id: row.id as string,
        name: row.name as string,
        slug: row.slug as string,
        source_url: row.source_url as string | null,
        canonical_url: row.source_url as string | null,
        source_domain: (() => { try { return new URL(row.source_url as string).hostname; } catch { return null; } })(),
        description: row.description as string | null,
        materials: row.materials as string | null,
        dimensions: row.dimensions as string | null,
        price_text: row.price_text as string | null,
        category_id: row.category_id as string | null,
        designer_id: null,
        designer_name: row.designer_name as string | null,
        brand_name: row.brand_name as string | null,
        brand_website_url: row.brand_website_url as string | null,
        images: storedImage,
      };
    });
  } else {
    const { data: visibleRows, error: visibleError } = await supabase
      .from("project_products")
      .select("product_id")
      .eq("project_id", input.source.projectId)
      .in("product_id", ids);
    if (visibleError) throw new Error(visibleError.message);
    const visibleIds = (visibleRows ?? []).map((row) => row.product_id as string);
    if (visibleIds.length === 0) throw new Error("None of the selected products belong to the source project.");
    if (visibleIds.length !== ids.length) throw new Error("Some selected products are not in the source project's catalogue.");
    const { data, error } = await supabase
      .from("products")
      .select("id, name, slug, source_url, canonical_url, source_domain, description, materials, dimensions, price_text, category_id, designer_id, brand:brands(name, website_url), images:product_images(original_url, storage_path, public_url, is_primary, status, width, height)")
      .in("id", visibleIds);
    if (error) throw new Error(error.message);
    sourceProducts = (data ?? []).map((row) => {
      const brand = relatedName(row.brand);
      return {
        id: row.id as string,
        name: row.name as string,
        slug: row.slug as string,
        source_url: row.source_url as string | null,
        canonical_url: row.canonical_url as string | null,
        source_domain: row.source_domain as string | null,
        description: row.description as string | null,
        materials: row.materials as string | null,
        dimensions: row.dimensions as string | null,
        price_text: row.price_text as string | null,
        category_id: row.category_id as string | null,
        designer_id: row.designer_id as string | null,
        designer_name: null,
        brand_name: brand?.name ?? null,
        brand_website_url: brand?.website_url ?? null,
        images: Array.isArray(row.images) ? row.images as CopyImage[] : [],
      };
    });
  }

  if (sourceProducts.length === 0) return { added: 0, duplicates: ids.length };
  if (sourceProducts.length !== ids.length) throw new Error("Some selected products are no longer available.");

  const { data: targetRefs, error: refsError } = await supabase
    .from("project_products")
    .select("product_id")
    .eq("project_id", input.targetProjectId);
  if (refsError) throw new Error(refsError.message);
  const targetIds = (targetRefs ?? []).map((row) => row.product_id as string);
  const targetIdSet = new Set(targetIds);
  const targetUrls = new Set<string>();
  if (targetIds.length > 0) {
    const { data: existing, error: existingError } = await supabase
      .from("products")
      .select("source_url, canonical_url")
      .in("id", targetIds);
    if (existingError) throw new Error(existingError.message);
    for (const row of existing ?? []) {
      if (row.source_url) targetUrls.add(row.source_url as string);
      if (row.canonical_url) targetUrls.add(row.canonical_url as string);
    }
  }

  const toCopy = sourceProducts.filter((product) =>
    !targetIdSet.has(product.id) &&
    ![product.source_url, product.canonical_url].some((url) => url && targetUrls.has(url))
  );
  const duplicates = ids.length - toCopy.length;
  if (toCopy.length === 0) return { added: 0, duplicates };

  const brands = new Map<string, string | null>();
  for (const product of toCopy) {
    if (!product.brand_name) continue;
    if (!brands.has(product.brand_name)) {
      const resolved = await resolveBrandDetailed(
        input.targetProjectId,
        product.brand_name,
        product.brand_website_url,
      );
      if (!resolved) throw new Error(`Could not create brand "${product.brand_name}" in the target project.`);
      brands.set(product.brand_name, resolved.id);
    }
  }

  const rows = await Promise.all(toCopy.map(async (product) => ({
    project_id: input.targetProjectId,
    name: product.name,
    slug: `${slugify(product.slug || product.name)}-${nanoid(6)}`,
    brand_id: product.brand_name ? brands.get(product.brand_name) ?? null : null,
    designer_id: product.designer_id ?? await resolveDesigner(product.designer_name),
    category_id: product.category_id,
    description: product.description,
    materials: product.materials,
    dimensions: product.dimensions,
    price_text: product.price_text,
    source_url: product.source_url,
    canonical_url: product.canonical_url,
    source_domain: product.source_domain,
    status: "published",
    extraction_status: "complete",
  })));
  const { data: inserted, error: insertError } = await supabase.from("products").insert(rows).select("id");
  if (insertError || !inserted) throw new Error(insertError?.message ?? "Could not copy the products.");

  const insertedIds = inserted.map((row) => row.id as string);
  const { error: referenceError } = await supabase
    .from("project_products")
    .upsert(
      insertedIds.map((product_id) => ({ project_id: input.targetProjectId, product_id })),
      { onConflict: "project_id,product_id", ignoreDuplicates: true },
    );
  if (referenceError) {
    await supabase.from("products").delete().in("id", insertedIds);
    throw new Error(referenceError.message);
  }

  const imageRows = toCopy.flatMap((product, index) =>
    product.images.map((image) => ({
      product_id: insertedIds[index],
      original_url: image.original_url,
      storage_path: image.storage_path,
      public_url: image.public_url,
      is_primary: image.is_primary,
      status: image.status,
      width: image.width,
      height: image.height,
    }))
  );
  if (imageRows.length > 0) {
    const { error: imageError } = await supabase.from("product_images").insert(imageRows);
    if (imageError) {
      await supabase.from("products").delete().in("id", insertedIds);
      throw new Error(imageError.message);
    }
  }

  return { added: inserted.length, duplicates };
}
