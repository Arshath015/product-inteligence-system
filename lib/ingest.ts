import { nanoid } from "nanoid";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { extractProductFromUrl } from "@/lib/extraction";
import { resolveBrand, resolveDesigner, resolveCategory, findDuplicateProduct, ensureProductVisible } from "@/lib/catalog";
import { storeBestProductImage } from "@/lib/images";
import { slugify } from "@/lib/slug";
import { getProductWithRelations, logActivity } from "@/lib/products";
import type { Product } from "@/lib/types";
import type { PageSignals } from "@/lib/pageSignals";

export interface IngestResult {
  status: "created" | "duplicate_updated" | "duplicate_unchanged" | "failed";
  product: Product | null;
  message: string;
}

// A generic name with no extractable image is a strong signal the URL was a
// category/listing page, not a specific product — refuse rather than publish junk.
const GENERIC_NAMES = new Set([
  "sofa", "sofas", "chair", "chairs", "armchair", "armchairs", "lounge chair",
  "dining chair", "table", "tables", "coffee table", "side table", "bed", "beds",
  "light", "lighting", "lamp", "rug", "rugs", "accessory", "accessories",
  "collection", "products", "design", "living", "indoor", "outdoor", "catalogue", "catalog",
]);

async function uniqueSlug(projectId: string, base: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const candidate = slugify(base) || "product";
  const { data } = await supabase
    .from("products")
    .select("id")
    .eq("project_id", projectId)
    .eq("slug", candidate)
    .maybeSingle();
  if (!data) return candidate;
  return `${candidate}-${nanoid(6)}`;
}

/**
 * Full "paste a URL" pipeline: extract -> resolve brand/designer/category ->
 * dedupe -> create or enrich -> persist images. Scoped to a single project:
 * duplicate detection only looks at products VISIBLE to this project, new
 * products/brands are owned by this project, and if the URL matches a
 * product this project only has a REFERENCE to (owned by another project),
 * its fields are never modified — referencing is read-only by design.
 * Idempotent per project, which matters because a failed Groq key can cause
 * the whole chat turn to retry.
 */
export async function ingestProductUrl(
  projectId: string,
  url: string,
  preloadedSignals?: PageSignals | null
): Promise<IngestResult> {
  const supabase = getSupabaseAdmin();

  let extracted;
  try {
    extracted = await extractProductFromUrl(url, preloadedSignals);
  } catch (err) {
    return {
      status: "failed",
      product: null,
      message: `Couldn't read that page (${(err as Error).message}).`,
    };
  }

  // Redundant with the checks inside extractProductFromUrl, but cheap
  // insurance against ever writing a nameless "UNKNOWN BRAND" record —
  // essential product identification failing must never look like success.
  if (!extracted.name.trim()) {
    return {
      status: "failed",
      product: null,
      message: "Couldn't identify a specific product from that page.",
    };
  }

  if (GENERIC_NAMES.has(extracted.name.trim().toLowerCase()) && extracted.imageUrls.length === 0) {
    return {
      status: "failed",
      product: null,
      message: "That looks like a category or listing page, not a specific product — try a direct product page URL.",
    };
  }

  const [brandId, designerId, categoryId] = await Promise.all([
    resolveBrand(projectId, extracted.brandName),
    resolveDesigner(extracted.designerName),
    resolveCategory(extracted.categoryHint),
  ]);

  const duplicate = await findDuplicateProduct({
    projectId,
    canonicalUrl: extracted.canonicalUrl,
    name: extracted.name,
    brandId,
  });

  if (duplicate) {
    const { data: existing } = await supabase
      .from("products")
      .select("*")
      .eq("id", duplicate.productId)
      .single();

    const owned = existing.project_id === projectId;
    const patch: Record<string, unknown> = {};

    if (owned) {
      if (!existing.description && extracted.description) patch.description = extracted.description;
      if (!existing.materials && extracted.materials) patch.materials = extracted.materials;
      if (!existing.dimensions && extracted.dimensions) patch.dimensions = extracted.dimensions;
      if (!existing.price_text && extracted.priceText) patch.price_text = extracted.priceText;
      if (!existing.designer_id && designerId) patch.designer_id = designerId;
      if (!existing.category_id && categoryId) patch.category_id = categoryId;
      if (!existing.canonical_url && extracted.canonicalUrl) patch.canonical_url = extracted.canonicalUrl;

      if (Object.keys(patch).length > 0) {
        await supabase.from("products").update(patch).eq("id", existing.id);
      }

      const { data: hasPrimaryImage } = await supabase
        .from("product_images")
        .select("id")
        .eq("product_id", existing.id)
        .eq("is_primary", true)
        .eq("status", "stored")
        .maybeSingle();

      if (!hasPrimaryImage && extracted.imageUrls.length > 0) {
        await storeBestProductImage(existing.id, extracted.imageUrls, true, {
          validateWithVision: extracted.imagesLowConfidence,
        });
      }
    }

    await logActivity("duplicate_detected", "product", existing.id, {
      project_id: projectId,
      source_url: url,
      reason: duplicate.reason,
      owned,
    });

    const updated = await getProductWithRelations(existing.id);
    return {
      status: owned && Object.keys(patch).length > 0 ? "duplicate_updated" : "duplicate_unchanged",
      product: updated,
      message: owned
        ? Object.keys(patch).length > 0
          ? `Already in the catalogue — filled in missing details for "${existing.name}".`
          : `Already in the catalogue: "${existing.name}".`
        : `Already in the catalogue (referenced from another project): "${existing.name}".`,
    };
  }

  const slug = await uniqueSlug(projectId, `${extracted.brandName ?? ""} ${extracted.name}`);
  const { data: created, error } = await supabase
    .from("products")
    .insert({
      project_id: projectId,
      name: extracted.name,
      slug,
      brand_id: brandId,
      designer_id: designerId,
      category_id: categoryId,
      description: extracted.description,
      materials: extracted.materials,
      dimensions: extracted.dimensions,
      price_text: extracted.priceText,
      source_url: url,
      canonical_url: extracted.canonicalUrl,
      source_domain: extracted.sourceDomain,
      extraction_status: "complete",
    })
    .select("id")
    .single();

  if (error || !created) {
    return { status: "failed", product: null, message: "Couldn't save that product." };
  }

  await ensureProductVisible(projectId, created.id as string);

  if (extracted.imageUrls.length > 0) {
    await storeBestProductImage(created.id, extracted.imageUrls, true, {
      validateWithVision: extracted.imagesLowConfidence,
    });
  }

  await logActivity("product_created", "product", created.id, { project_id: projectId, source_url: url });

  const product = await getProductWithRelations(created.id);
  return {
    status: "created",
    product,
    message: `Added "${extracted.name}"${extracted.brandName ? ` by ${extracted.brandName}` : ""} to the catalogue.`,
  };
}
