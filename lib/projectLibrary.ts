import { nanoid } from "nanoid";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { slugify } from "@/lib/slug";

const PROJECT_PRODUCT_PAGE_SIZE = 1000;
const PRODUCT_BATCH_SIZE = 100;

type ProjectImage = {
  original_url: string | null;
  storage_path: string | null;
  public_url: string | null;
  is_primary: boolean;
  status: string;
};

function relatedRecord(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

async function getVisibleProductIds(projectId: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const ids: string[] = [];

  for (let offset = 0; ; offset += PROJECT_PRODUCT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("project_products")
      .select("product_id")
      .eq("project_id", projectId)
      .order("product_id", { ascending: true })
      .range(offset, offset + PROJECT_PRODUCT_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);

    const page = (data ?? []).map((row) => row.product_id as string);
    ids.push(...page);
    if (page.length < PROJECT_PRODUCT_PAGE_SIZE) break;
  }

  return [...new Set(ids)];
}

export async function addProjectProductsToLibrary(input: {
  projectId: string;
  productIds?: string[];
}) {
  const supabase = getSupabaseAdmin();
  const requestedIds = input.productIds
    ? [...new Set(input.productIds)]
    : await getVisibleProductIds(input.projectId);
  const result = {
    requested: requestedIds.length,
    added: 0,
    duplicates: 0,
    failed: 0,
    errors: [] as string[],
  };
  if (requestedIds.length === 0) return result;

  if (input.productIds) {
    const visibleIds = new Set<string>();
    for (let offset = 0; offset < requestedIds.length; offset += PRODUCT_BATCH_SIZE) {
      const batch = requestedIds.slice(offset, offset + PRODUCT_BATCH_SIZE);
      const { data, error } = await supabase
        .from("project_products")
        .select("product_id")
        .eq("project_id", input.projectId)
        .in("product_id", batch);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) visibleIds.add(row.product_id as string);
    }
    if (visibleIds.size !== requestedIds.length) {
      throw new Error("Some selected products are not in this project's catalogue.");
    }
  }

  const seenSourceUrls = new Set<string>();
  for (let offset = 0; offset < requestedIds.length; offset += PRODUCT_BATCH_SIZE) {
    const ids = requestedIds.slice(offset, offset + PRODUCT_BATCH_SIZE);
    const { data: products, error: productsError } = await supabase
      .from("products")
      .select("id, name, slug, brand_id, designer_id, category_id, description, materials, dimensions, price_text, source_url, canonical_url, brand:brands(name, website_url), designer:designers(name), category:categories(name), images:product_images(original_url, storage_path, public_url, is_primary, status)")
      .in("id", ids);
    if (productsError) {
      result.failed += ids.length;
      result.errors.push(productsError.message);
      continue;
    }

    const foundIds = new Set((products ?? []).map((product) => product.id as string));
    const missingCount = ids.filter((id) => !foundIds.has(id)).length;
    if (missingCount > 0) {
      result.failed += missingCount;
      if (result.errors.length < 3) result.errors.push(`${missingCount} selected product(s) are no longer available.`);
    }

    const rows = [];
    for (const product of products ?? []) {
      const sourceUrl = (product.source_url as string | null) || (product.canonical_url as string | null);
      if (!sourceUrl) {
        result.failed++;
        if (result.errors.length < 3) result.errors.push(`"${product.name}" has no source URL.`);
        continue;
      }
      if (seenSourceUrls.has(sourceUrl)) {
        result.duplicates++;
        continue;
      }
      seenSourceUrls.add(sourceUrl);

      const brand = relatedRecord(product.brand);
      const designer = relatedRecord(product.designer);
      const category = relatedRecord(product.category);
      const images = Array.isArray(product.images) ? product.images as ProjectImage[] : [];
      const orderedImages = [
        ...images.filter((image) => image.is_primary),
        ...images.filter((image) => !image.is_primary),
      ];
      const imageUrls = [...new Set(
        orderedImages.flatMap((image) => [image.original_url, image.public_url])
          .filter((url): url is string => Boolean(url))
      )];
      const storedImage = orderedImages.find((image) => image.status === "stored" && image.public_url);
      const brandName = typeof brand?.name === "string" ? brand.name : null;
      const productName = product.name as string;
      const baseSlug = slugify(`${brandName ?? ""} ${productName}`) || "product";

      rows.push({
        brand_id: null,
        brand_name: brandName,
        brand_website_url: typeof brand?.website_url === "string" ? brand.website_url : null,
        designer_name: typeof designer?.name === "string" ? designer.name : null,
        name: productName,
        slug: `${baseSlug}-${nanoid(6)}`,
        source_url: sourceUrl,
        description: product.description as string | null,
        materials: product.materials as string | null,
        dimensions: product.dimensions as string | null,
        price_text: product.price_text as string | null,
        images: imageUrls,
        primary_image_url: imageUrls[0] ?? null,
        category_id: product.category_id as string | null,
        category_name: typeof category?.name === "string" ? category.name : null,
        image_storage_path: storedImage?.storage_path ?? null,
        image_public_url: storedImage?.public_url ?? null,
        image_status: storedImage?.public_url ? "stored" : imageUrls.length > 0 ? "pending" : "missing",
      });
    }

    for (let rowOffset = 0; rowOffset < rows.length; rowOffset += PRODUCT_BATCH_SIZE) {
      const batch = rows.slice(rowOffset, rowOffset + PRODUCT_BATCH_SIZE);
      const { data: inserted, error: insertError } = await supabase
        .from("brand_catalogue_products")
        .upsert(batch, { onConflict: "source_url", ignoreDuplicates: true })
        .select("id");
      if (insertError) {
        result.failed += batch.length;
        if (result.errors.length < 3) result.errors.push(insertError.message);
        continue;
      }

      const insertedCount = inserted?.length ?? 0;
      result.added += insertedCount;
      result.duplicates += batch.length - insertedCount;
    }
  }

  return result;
}
