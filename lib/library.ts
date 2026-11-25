import { nanoid } from "nanoid";
import { extractProductFromUrl } from "@/lib/extraction";
import { crawlBrandCatalogue } from "@/lib/bulk/brandCrawl";
import { isProductPageUrl } from "@/lib/bulk/discoverLinks";
import { classifyFromPath, classifyFromSignals } from "@/lib/bulk/classify";
import { fetchPageSignals, hasUsableSignal } from "@/lib/pageSignals";
import { findAndUploadImage } from "@/lib/images";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { slugify } from "@/lib/slug";
import type { ExtractedProductData } from "@/lib/types";

const DISCOVERY_PAGE_SIZE = 1000;
const IMPORT_BATCH_SIZE = 12;

export interface LibraryRun {
  id: string;
  source_url: string;
  brand_name: string | null;
  product_urls: string[];
  failed_urls: string[];
  discovery_truncated: boolean;
  next_index: number;
  processed_count: number;
  added_count: number;
  duplicate_count: number;
  failed_count: number;
  status: "ready" | "complete" | "failed";
}

export interface LibraryBatchResult {
  run: LibraryRun;
  added: number;
  duplicates: number;
  failed: number;
  imageFailures: number;
  hasMore: boolean;
}

export async function getLibraryRun(runId: string): Promise<LibraryRun> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("library_import_runs").select("*").eq("id", runId).maybeSingle();
  if (error || !data) throw new Error(error?.message ?? "Library import run not found.");
  return asRun(data as Record<string, unknown>);
}

function guessBrandName(title: string | null, url: string): string {
  const firstTitle = title?.split(/[|\-–—]/)[0]?.trim();
  if (firstTitle && firstTitle.length > 1 && firstTitle.length < 60) return firstTitle;
  try {
    return new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  } catch {
    return "Unknown brand";
  }
}

function asRun(row: Record<string, unknown>): LibraryRun {
  return {
    id: row.id as string,
    source_url: row.source_url as string,
    brand_name: (row.brand_name as string | null) ?? null,
    product_urls: Array.isArray(row.product_urls) ? row.product_urls as string[] : [],
    failed_urls: Array.isArray(row.failed_urls) ? row.failed_urls as string[] : [],
    discovery_truncated: Boolean(row.discovery_truncated),
    next_index: Number(row.next_index ?? 0),
    processed_count: Number(row.processed_count ?? 0),
    added_count: Number(row.added_count ?? 0),
    duplicate_count: Number(row.duplicate_count ?? 0),
    failed_count: Number(row.failed_count ?? 0),
    status: row.status as LibraryRun["status"],
  };
}

export async function startLibraryImport(sourceUrl: string): Promise<LibraryRun> {
  const trimmedUrl = sourceUrl.trim();
  const normalizedInput = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;
  const parsed = new URL(normalizedInput);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Enter a public http or https website URL.");
  }
  parsed.hash = "";
  const url = parsed.toString();
  const homepage = await fetchPageSignals(url).catch(() => null);
  const isIndividualProduct =
    isProductPageUrl(url) ||
    classifyFromPath(url) === "product" ||
    (homepage ? classifyFromSignals(url, homepage) === "product" : false);
  const brandName = isIndividualProduct
    ? parsed.hostname.replace(/^www\./, "").split(".")[0]
    : guessBrandName(homepage?.title ?? null, homepage?.finalUrl ?? url);

  let productUrls: string[];
  let discoveryTruncated = false;
  if (isIndividualProduct) {
    productUrls = [homepage?.canonicalUrl ?? url];
  } else {
    const crawl = await crawlBrandCatalogue(
      url,
      homepage && hasUsableSignal(homepage) ? homepage : null,
      undefined,
      { maxProducts: DISCOVERY_PAGE_SIZE, maxCollections: 60 },
    );
    productUrls = crawl.productUrls;
    discoveryTruncated = crawl.stats.truncated;
  }

  if (productUrls.length === 0) {
    throw new Error("No individual product pages were discovered. Try a product URL or retry after the site catalogue becomes available.");
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("library_import_runs")
    .insert({
      source_url: url,
      brand_name: brandName,
      product_urls: productUrls,
      discovery_truncated: discoveryTruncated,
      status: "ready",
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not start the Library import.");
  return asRun(data as Record<string, unknown>);
}

async function categoryIdForHint(hint: string | null): Promise<string | null> {
  if (!hint) return null;
  const supabase = getSupabaseAdmin();
  const slug = slugify(hint);
  const { data } = await supabase.from("categories").select("id").eq("slug", slug).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

async function saveLibraryProduct(
  url: string,
  fallbackBrand: string | null,
): Promise<"added" | "duplicate" | "failed" | "image_failed"> {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("brand_catalogue_products")
    .select("id")
    .eq("source_url", url)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existing) return "duplicate";

  const extracted: ExtractedProductData = await extractProductFromUrl(url);
  if (!extracted.name.trim()) throw new Error("Page did not contain a product name.");

  const brandName = extracted.brandName?.trim() || fallbackBrand || guessBrandName(null, url);
  const categoryId = await categoryIdForHint(extracted.categoryHint);
  const baseSlug = slugify(`${brandName} ${extracted.name}`) || "product";
  const slug = `${baseSlug}-${nanoid(6)}`;
  const sourceUrl = extracted.canonicalUrl ?? url;
  const row = {
    brand_id: null,
    brand_name: brandName,
    brand_website_url: (() => {
      try { return new URL(url).origin; } catch { return null; }
    })(),
    designer_name: extracted.designerName,
    name: extracted.name,
    slug,
    source_url: sourceUrl,
    description: extracted.description,
    materials: extracted.materials,
    dimensions: extracted.dimensions,
    price_text: extracted.priceText,
    images: extracted.imageUrls,
    primary_image_url: extracted.imageUrls[0] ?? null,
    category_id: categoryId,
    category_name: extracted.categoryHint,
    image_status: extracted.imageUrls.length > 0 ? "pending" : "missing",
  };
  const { data: saved, error: saveError } = await supabase
    .from("brand_catalogue_products")
    .upsert(row, { onConflict: "source_url", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();
  if (saveError) throw new Error(saveError.message);
  if (!saved) return "duplicate";

  if (extracted.imageUrls.length === 0) return "added";
  const markImageFailed = async () => {
    const { error } = await supabase
      .from("brand_catalogue_products")
      .update({ image_status: "failed" })
      .eq("id", saved.id);
    if (error) throw new Error(error.message);
  };
  let image: Awaited<ReturnType<typeof findAndUploadImage>>;
  try {
    image = await findAndUploadImage(
      `library/${saved.id}`,
      extracted.imageUrls,
      { validateWithVision: extracted.imagesLowConfidence },
    );
  } catch {
    await markImageFailed();
    return "image_failed";
  }
  if (!image) {
    await markImageFailed();
    return "image_failed";
  }
  const { error: imageError } = await supabase
    .from("brand_catalogue_products")
    .update({
      image_storage_path: image.storagePath,
      image_public_url: image.publicUrl,
      image_status: "stored",
    })
    .eq("id", saved.id);
  if (imageError) throw new Error(imageError.message);
  return "added";
}

export async function continueLibraryDiscovery(runId: string): Promise<LibraryRun> {
  const supabase = getSupabaseAdmin();
  const run = await getLibraryRun(runId);
  if (!run.discovery_truncated) return run;

  const pageSize = Math.min(DISCOVERY_PAGE_SIZE, 5000 - run.product_urls.length);
  if (pageSize <= 0) throw new Error("The discovery limit has been reached. Start another targeted import to continue.");

  const homepage = await fetchPageSignals(run.source_url).catch(() => null);
  const crawl = await crawlBrandCatalogue(
    run.source_url,
    homepage && hasUsableSignal(homepage) ? homepage : null,
    undefined,
    {
      maxProducts: run.product_urls.length + pageSize,
      maxCollections: Math.min(500, 60 + Math.floor(run.product_urls.length / DISCOVERY_PAGE_SIZE) * 60),
    },
  );
  const seen = new Set(run.product_urls);
  const nextUrls = crawl.productUrls.filter((url) => !seen.has(url));
  if (nextUrls.length === 0 && crawl.stats.truncated) {
    throw new Error("The site returned the same catalogue pages. Try a more specific category URL or retry later.");
  }

  const { data: updated, error: updateError } = await supabase
    .from("library_import_runs")
    .update({
      product_urls: [...run.product_urls, ...nextUrls],
      discovery_truncated: crawl.stats.truncated,
      status: "ready",
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .select("*")
    .single();
  if (updateError || !updated) throw new Error(updateError?.message ?? "Could not continue catalogue discovery.");
  return asRun(updated as Record<string, unknown>);
}

export async function processLibraryBatch(
  runId: string,
  options: { retryFailed?: boolean } = {},
): Promise<LibraryBatchResult> {
  const supabase = getSupabaseAdmin();
  const run = await getLibraryRun(runId);
  const retrying = options.retryFailed === true;
  const batch = retrying
    ? run.failed_urls.slice(0, IMPORT_BATCH_SIZE)
    : run.product_urls.slice(run.next_index, run.next_index + IMPORT_BATCH_SIZE);
  if (batch.length === 0) return { run, added: 0, duplicates: 0, failed: 0, imageFailures: 0, hasMore: false };

  const failedUrls = new Set(retrying ? run.failed_urls.filter((url) => !batch.includes(url)) : run.failed_urls);
  let added = 0;
  let duplicates = 0;
  let failed = 0;
  let imageFailures = 0;
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= batch.length) return;
      const url = batch[index];
      try {
        const result = await saveLibraryProduct(url, run.brand_name);
        if (result === "added") added++;
        if (result === "duplicate") duplicates++;
        if (result === "image_failed") {
          added++;
          imageFailures++;
        }
        failedUrls.delete(url);
      } catch {
        failed++;
        failedUrls.add(url);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, batch.length) }, worker));

  const nextIndex = retrying ? run.next_index : run.next_index + batch.length;
  const status = nextIndex >= run.product_urls.length ? "complete" : "ready";
  const { data: updated, error: updateError } = await supabase
    .from("library_import_runs")
    .update({
      next_index: nextIndex,
      failed_urls: [...failedUrls],
      processed_count: retrying ? run.processed_count : run.processed_count + batch.length,
      added_count: run.added_count + added,
      duplicate_count: run.duplicate_count + duplicates,
      failed_count: failedUrls.size,
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .select("*")
    .single();
  if (updateError || !updated) throw new Error(updateError?.message ?? "Could not update Library import progress.");
  const updatedRun = asRun(updated as Record<string, unknown>);
  return {
    run: updatedRun,
    added,
    duplicates,
    failed,
    imageFailures,
    hasMore: updatedRun.next_index < updatedRun.product_urls.length,
  };
}

export async function getLibraryProducts(opts: {
  q?: string;
  brand?: string;
  category?: string;
  limit?: number;
  offset?: number;
}) {
  const supabase = getSupabaseAdmin();
  const requestedLimit = Number.isFinite(opts.limit) ? Math.trunc(opts.limit as number) : 60;
  const requestedOffset = Number.isFinite(opts.offset) ? Math.trunc(opts.offset as number) : 0;
  const limit = Math.min(100, Math.max(1, requestedLimit));
  const offset = Math.max(0, requestedOffset);
  let query = supabase
    .from("brand_catalogue_products")
    .select("*, category:categories(name, slug)", { count: "exact" })
    .order("brand_name")
    .order("name")
    .range(offset, offset + limit - 1);
  if (opts.brand) query = query.eq("brand_name", opts.brand);
  if (opts.category) query = query.eq("category_name", opts.category);
  const search = opts.q?.trim().replace(/[(),.%\\"']/g, " ").slice(0, 100);
  if (search) query = query.or(`name.ilike.%${search}%,brand_name.ilike.%${search}%,category_name.ilike.%${search}%`);

  const [{ data: products, error: productsError, count }, { data: brandRows, error: brandsError }, { data: categories, error: categoriesError }] =
    await Promise.all([
      query,
      supabase.from("brand_catalogue_products").select("brand_name").not("brand_name", "is", null).order("brand_name").limit(5000),
      supabase.from("categories").select("name, slug").order("sort_order"),
    ]);
  if (productsError) throw new Error(productsError.message);
  if (brandsError) throw new Error(brandsError.message);
  if (categoriesError) throw new Error(categoriesError.message);

  const brands = [...new Set((brandRows ?? []).map((row) => row.brand_name as string).filter(Boolean))];
  return { products: products ?? [], total: count ?? 0, brands, categories: categories ?? [] };
}
