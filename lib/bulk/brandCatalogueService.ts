/**
 * Brand catalogue library — extracts all products from a brand and saves them
 * to `brand_catalogue_products` (independent of any project). Streams progress
 * via an optional callback so the SSE route can push live updates.
 */
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchPageSignals, hasUsableSignal } from "@/lib/pageSignals";
import { extractProductFromUrl } from "@/lib/extraction";
import { crawlBrandCatalogue } from "@/lib/bulk/brandCrawl";
import { resolveBrandDetailed, resolveDesigner } from "@/lib/catalog";
import { slugify } from "@/lib/slug";
import { nanoid } from "nanoid";
import { randomUUID } from "node:crypto";
import { recordBrandImportDiagnostic } from "@/lib/bulk/brandImportDiagnostics";
import type { ExtractedProductData } from "@/lib/types";

export interface CatalogueProduct {
  id: string;
  brand_id: string;
  name: string;
  slug: string;
  source_url: string;
  description: string | null;
  images: string[];
  primary_image_url: string | null;
  category_id: string | null;
  category_name: string | null;
  extracted_at: string;
}

export type ExtractProgressEvent =
  | { type: "phase"; phase: "discovering" | "extracting" | "done"; message: string; runId?: string }
  | {
      type: "discovered";
      runId: string;
      total: number;
      brandId: string;
      brandName: string;
      alreadyExtracted: number;
      processed: number;
      added: number;
      duplicates: number;
      failed: number;
      hasMore: boolean;
    }
  | { type: "product"; product: CatalogueProduct; processed: number; total: number; added: number; duplicates: number; failed: number }
  | { type: "skip"; url: string; reason: string; processed: number; total: number; added: number; duplicates: number; failed: number }
  | {
      type: "done";
      runId: string;
      processed: number;
      total: number;
      added: number;
      duplicates: number;
      failed: number;
      brandId: string;
      hasMore: boolean;
      retrying: boolean;
      truncated: boolean;
    }
  | { type: "error"; message: string };

interface BrandImportRun {
  id: string;
  source_url: string;
  brand_id: string;
  brand_name: string;
  product_urls: string[];
  failed_urls: string[];
  failure_details: Record<string, string>;
  discovery_truncated: boolean;
  next_index: number;
  processed_count: number;
  added_count: number;
  duplicate_count: number;
  failed_count: number;
}

const MAX_PER_CALL = 20;

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  async function runner() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
}

async function uniqueCatalogueSlug(brandId: string, base: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const candidate = slugify(base) || "product";
  const { data } = await supabase
    .from("brand_catalogue_products")
    .select("id")
    .eq("brand_id", brandId)
    .eq("slug", candidate)
    .maybeSingle();
  if (!data) return candidate;
  return `${candidate}-${nanoid(6)}`;
}

/** Resolve or create the brand in the given project context. */
async function resolveBrandForCatalogue(
  projectId: string,
  name: string,
  websiteUrl: string
): Promise<{ id: string; name: string } | null> {
  const result = await resolveBrandDetailed(projectId, name, websiteUrl).catch(() => null);
  if (!result) return null;
  // Return the brand name: look it up since resolveBrandDetailed only gives id+created
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("brands").select("name").eq("id", result.id).maybeSingle();
  return { id: result.id, name: (data?.name as string | null) ?? name };
}

/**
 * Extracts all products from a brand website and saves them to the
 * `brand_catalogue_products` table. Streams progress via onEvent.
 * Never throws — errors are reported via the error event.
 */
export async function extractBrandCatalogue(
  projectId: string,
  brandUrl: string,
  onEvent: (event: ExtractProgressEvent) => void,
  options?: {
    runId?: string;
    retryFailed?: boolean;
  }
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const resuming = Boolean(options?.runId);
  let runId = options?.runId ?? randomUUID();

  try {
    let run: BrandImportRun;

    if (resuming) {
      await recordBrandImportDiagnostic(runId, {
        stage: "run_resumed",
        outcome: options?.retryFailed ? "retrying_failures" : "continuing",
        url: brandUrl,
      });
      const { data, error } = await supabase
        .from("library_import_runs")
        .select("*")
        .eq("id", runId)
        .eq("project_id", projectId)
        .maybeSingle();
      if (error || !data) throw new Error(error?.message ?? "Brand import run not found for this project.");
      run = data as BrandImportRun;
      onEvent({
        type: "discovered",
        runId,
        total: run.product_urls.length,
        brandId: run.brand_id,
        brandName: run.brand_name,
        alreadyExtracted: 0,
        processed: run.processed_count,
        added: run.added_count,
        duplicates: run.duplicate_count,
        failed: run.failed_count,
        hasMore: run.next_index < run.product_urls.length,
      });
    } else {
      onEvent({ type: "phase", phase: "discovering", message: "Fetching brand homepage…", runId });

      let homepageFailure: string | null = null;
      const homepageSignals = await fetchPageSignals(brandUrl).catch((error: unknown) => {
        homepageFailure = error instanceof Error ? error.message : String(error);
        return null;
      });
      const usableHomepage = homepageSignals && hasUsableSignal(homepageSignals) ? homepageSignals : null;
      const brandNameGuess = (() => {
        const first = usableHomepage?.title?.split(/[|\-–—]/)[0]?.trim();
        if (first && first.length > 1 && first.length < 60) return first;
        try { return new URL(brandUrl).hostname.replace(/^www\./, "").split(".")[0]; } catch { return "Brand"; }
      })();
      await recordBrandImportDiagnostic(runId, {
        stage: "homepage_fetch",
        outcome: usableHomepage ? "readable" : "unavailable",
        url: brandUrl,
        reason: usableHomepage ? undefined : homepageFailure ?? "Homepage did not return usable page signals.",
      });

      onEvent({ type: "phase", phase: "discovering", message: `Scanning ${brandNameGuess} catalogue…` });
      const resolved = await resolveBrandForCatalogue(projectId, brandNameGuess, brandUrl);
      if (!resolved) throw new Error("Could not identify a brand from that URL.");

      const crawl = await crawlBrandCatalogue(
        brandUrl,
        usableHomepage,
        (msg) => onEvent({ type: "phase", phase: "discovering", message: msg }),
        {
          maxProducts: 5000,
          maxCollections: 60,
          onDiagnostic: (diagnostic) => {
            void recordBrandImportDiagnostic(runId, diagnostic);
          },
        },
      );
      if (crawl.productUrls.length === 0) {
        throw new Error("No individual product pages were discovered. Try a category URL or retry after the site catalogue becomes available.");
      }

      const { data, error } = await supabase
        .from("library_import_runs")
        .insert({
          id: runId,
          source_url: brandUrl,
          brand_name: resolved.name,
          brand_id: resolved.id,
          project_id: projectId,
          product_urls: crawl.productUrls,
          discovery_truncated: crawl.stats.truncated,
          status: "ready",
        })
        .select("*")
        .single();
      if (error || !data) throw new Error(error?.message ?? "Could not create the brand import run.");
      run = data as BrandImportRun;
      runId = run.id;
      await recordBrandImportDiagnostic(runId, {
        stage: "run_created",
        outcome: "ready",
        url: brandUrl,
        counts: {
          discovered: run.product_urls.length,
          truncated: run.discovery_truncated,
        },
      });

      onEvent({
        type: "discovered",
        runId,
        total: run.product_urls.length,
        brandId: resolved.id,
        brandName: resolved.name,
        alreadyExtracted: 0,
        processed: run.processed_count,
        added: run.added_count,
        duplicates: run.duplicate_count,
        failed: run.failed_count,
        hasMore: run.next_index < run.product_urls.length,
      });
    }

    const retrying = options?.retryFailed === true;
    let failedUrls = new Set(Array.isArray(run.failed_urls) ? run.failed_urls : []);
    const failureDetails = { ...(run.failure_details ?? {}) };
    const retryQueue = [...failedUrls];
    const batch = retrying
      ? retryQueue.slice(0, MAX_PER_CALL)
      : run.product_urls.slice(run.next_index, run.next_index + MAX_PER_CALL);
    onEvent({
      type: "phase",
      phase: "extracting",
      message: retrying ? `Retrying ${batch.length} failed page(s)…` : `Extracting ${batch.length} product page(s)…`,
    });
    await recordBrandImportDiagnostic(runId, {
      stage: "extraction_batch_started",
      outcome: retrying ? "retry" : "processing",
      counts: { batch: batch.length, total: run.product_urls.length, retrying },
    });

    const { data: categories, error: categoriesError } = await supabase.from("categories").select("id, slug, name");
    if (categoriesError) throw new Error(categoriesError.message);
    const categoryBySlug = new Map((categories ?? []).map((row) => [row.slug as string, row.id as string]));
    const categoryByName = new Map((categories ?? []).map((row) => [(row.name as string).toLowerCase(), row.id as string]));

    const { data: existingBatch, error: existingBatchError } = batch.length > 0
      ? await supabase
          .from("brand_catalogue_products")
          .select("source_url, id, name, slug, description, images, primary_image_url, category_id, category_name, extracted_at, brand_id")
          .in("source_url", batch)
      : { data: [], error: null };
    if (existingBatchError) throw new Error(existingBatchError.message);
    const existingByUrl = new Map((existingBatch ?? []).map((row) => [row.source_url as string, row]));

    let addedDelta = 0;
    let duplicatesDelta = 0;
    let processedInBatch = 0;
    let progressProcessed = run.processed_count;
    const markProcessed = () => {
      processedInBatch++;
      progressProcessed = retrying ? run.processed_count : run.processed_count + processedInBatch;
    };

    await runPool(batch, 5, async (url) => {
      try {
        const existing = existingByUrl.get(url);
        if (existing) {
          duplicatesDelta++;
          failedUrls.delete(url);
          delete failureDetails[url];
          markProcessed();
          void recordBrandImportDiagnostic(runId, {
            stage: "product_extraction",
            outcome: "duplicate",
            url,
            reason: "Source URL already exists in the global brand catalogue.",
          });
          if (existing.brand_id === run.brand_id) {
            onEvent({
              type: "product",
              product: existing as unknown as CatalogueProduct,
              processed: progressProcessed,
              total: run.product_urls.length,
              added: run.added_count + addedDelta,
              duplicates: run.duplicate_count + duplicatesDelta,
              failed: failedUrls.size,
            });
          }
        } else {
          const extracted: ExtractedProductData = await Promise.race([
            extractProductFromUrl(url),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Product extraction timed out after 18 seconds.")), 18000)
            ),
          ]);
          if (!extracted.name.trim()) throw new Error("Page did not contain a product name.");

          const hint = extracted.categoryHint?.toLowerCase() ?? "";
          const categoryId = categoryBySlug.get(hint) ?? categoryByName.get(hint) ?? null;
          const images = extracted.imageUrls ?? [];
          const row = {
            brand_id: run.brand_id,
            brand_name: run.brand_name,
            brand_website_url: run.source_url,
            designer_name: extracted.designerName,
            name: extracted.name,
            slug: await uniqueCatalogueSlug(run.brand_id, extracted.name),
            source_url: url,
            description: extracted.description ?? null,
            materials: extracted.materials ?? null,
            dimensions: extracted.dimensions ?? null,
            price_text: extracted.priceText ?? null,
            images,
            primary_image_url: images[0] ?? null,
            category_id: categoryId,
            category_name: extracted.categoryHint ?? null,
            image_status: images.length > 0 ? "pending" : "missing",
          };
          const { data: saved, error } = await supabase
            .from("brand_catalogue_products")
            .upsert(row, { onConflict: "source_url", ignoreDuplicates: true })
            .select()
            .maybeSingle();
          if (error) throw new Error(error.message);
          if (!saved) {
            duplicatesDelta++;
            void recordBrandImportDiagnostic(runId, {
              stage: "product_save",
              outcome: "duplicate",
              url,
              reason: "A catalogue record with this source URL already exists.",
            });
          } else {
            addedDelta++;
            void recordBrandImportDiagnostic(runId, {
              stage: "product_save",
              outcome: "added",
              url,
              counts: { images: images.length },
            });
          }
          failedUrls.delete(url);
          delete failureDetails[url];
          markProcessed();
          if (saved) {
            onEvent({
              type: "product",
              product: saved as unknown as CatalogueProduct,
              processed: progressProcessed,
              total: run.product_urls.length,
              added: run.added_count + addedDelta,
              duplicates: run.duplicate_count + duplicatesDelta,
              failed: failedUrls.size,
            });
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failedUrls.add(url);
        failureDetails[url] = reason;
        markProcessed();
        void recordBrandImportDiagnostic(runId, {
          stage: "product_extraction",
          outcome: "failed",
          url,
          reason,
        });
        onEvent({
          type: "skip",
          url,
          reason,
          processed: progressProcessed,
          total: run.product_urls.length,
          added: run.added_count + addedDelta,
          duplicates: run.duplicate_count + duplicatesDelta,
          failed: failedUrls.size,
        });
      }
    });

    if (retrying) {
      const currentBatch = new Set(batch);
      failedUrls = new Set([
        ...retryQueue.filter((url) => !currentBatch.has(url) && failedUrls.has(url)),
        ...retryQueue.filter((url) => currentBatch.has(url) && failedUrls.has(url)),
      ]);
    }

    const nextIndex = retrying ? run.next_index : run.next_index + batch.length;
    const hasMore = nextIndex < run.product_urls.length;
    const { data: updated, error: updateError } = await supabase
      .from("library_import_runs")
      .update({
        next_index: nextIndex,
        failed_urls: [...failedUrls],
        failure_details: failureDetails,
        processed_count: retrying ? run.processed_count : run.processed_count + batch.length,
        added_count: run.added_count + addedDelta,
        duplicate_count: run.duplicate_count + duplicatesDelta,
        failed_count: failedUrls.size,
        status: nextIndex >= run.product_urls.length ? "complete" : "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .eq("project_id", projectId)
      .select("*")
      .single();
    if (updateError || !updated) throw new Error(updateError?.message ?? "Could not save brand import progress.");

    const savedRun = updated as BrandImportRun;
    await recordBrandImportDiagnostic(runId, {
      stage: "extraction_batch_finished",
      outcome: hasMore ? "continuation_available" : "complete",
      counts: {
        processed: savedRun.processed_count,
        total: savedRun.product_urls.length,
        added: savedRun.added_count,
        duplicates: savedRun.duplicate_count,
        failed: savedRun.failed_count,
        hasMore,
        retrying,
      },
    });
    const { data: currentBrand, error: brandError } = await supabase
      .from("brands")
      .select("id")
      .eq("id", savedRun.brand_id)
      .eq("project_id", projectId)
      .maybeSingle();
    if (brandError) throw new Error(brandError.message);
    if (!currentBrand) throw new Error("The brand linked to this import run no longer exists.");
    onEvent({
      type: "done",
      runId: savedRun.id,
      processed: savedRun.processed_count,
      total: savedRun.product_urls.length,
      added: savedRun.added_count,
      duplicates: savedRun.duplicate_count,
      failed: savedRun.failed_count,
      brandId: savedRun.brand_id,
      hasMore,
      retrying,
      truncated: savedRun.discovery_truncated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordBrandImportDiagnostic(runId, {
      stage: "run_error",
      outcome: "failed",
      url: brandUrl,
      reason: message,
    });
    onEvent({ type: "error", message });
  }
}

/**
 * Copies selected brand catalogue products into a project's products table.
 */
export async function selectCatalogueProducts(
  projectId: string,
  brandCatalogueProductIds: string[]
): Promise<{ added: number; duplicates: number }> {
  const supabase = getSupabaseAdmin();

  const { data: items } = await supabase
    .from("brand_catalogue_products")
    .select("*")
    .in("id", brandCatalogueProductIds);

  if (!items || items.length === 0) return { added: 0, duplicates: 0 };

  const sourceUrls = items.map((p) => p.source_url as string).filter(Boolean);
  const { data: existing } = await supabase
    .from("products")
    .select("source_url")
    .eq("project_id", projectId)
    .in("source_url", sourceUrls);
  const existingSet = new Set((existing ?? []).map((p) => p.source_url as string));

  const toInsert = items.filter((p) => !existingSet.has(p.source_url as string));
  const duplicates = items.length - toInsert.length;

  if (toInsert.length === 0) return { added: 0, duplicates };

  const rows = await Promise.all(toInsert.map(async (p) => ({
    project_id: projectId,
    brand_id: p.brand_id as string,
    name: p.name as string,
    slug: `${slugify(p.name as string)}-${nanoid(6)}`,
    source_url: p.source_url as string,
    description: p.description as string | null,
    materials: p.materials as string | null,
    dimensions: p.dimensions as string | null,
    price_text: p.price_text as string | null,
    category_id: p.category_id as string | null,
    designer_id: await resolveDesigner(p.designer_name as string | null),
    status: "published",
    extraction_status: "complete",
  })));

  const { data: inserted, error } = await supabase
    .from("products")
    .insert(rows)
    .select("id, source_url");

  if (error || !inserted) return { added: 0, duplicates };

  const { error: referenceError } = await supabase
    .from("project_products")
    .upsert(
      inserted.map((product) => ({ project_id: projectId, product_id: product.id as string })),
      { onConflict: "project_id,product_id", ignoreDuplicates: true },
    );
  if (referenceError) {
    await supabase.from("products").delete().in("id", inserted.map((product) => product.id as string));
    throw new Error(referenceError.message);
  }

  // Insert images for each newly added product
  const imageInserts: {
    product_id: string;
    original_url: string;
    is_primary: boolean;
    status: string;
    storage_path?: string | null;
    public_url?: string | null;
  }[] = [];
  for (const product of inserted) {
    const src = items.find((p) => p.source_url === product.source_url);
    const imgs: string[] = Array.isArray(src?.images) ? src.images as string[] : [];
    for (let i = 0; i < imgs.length; i++) {
      imageInserts.push({
        product_id: product.id as string,
        original_url: imgs[i],
        is_primary: i === 0,
        ...(i === 0 && src?.image_status === "stored" && src.image_public_url
          ? {
              storage_path: src.image_storage_path as string | null,
              public_url: src.image_public_url as string | null,
              status: "stored",
            }
          : { status: "pending" }),
      });
    }
  }

  if (imageInserts.length > 0) {
    const { error: imageError } = await supabase.from("product_images").insert(imageInserts);
    if (imageError) {
      await supabase.from("products").delete().in("id", inserted.map((product) => product.id as string));
      throw new Error(imageError.message);
    }
  }

  return { added: inserted.length, duplicates };
}

/** Fetches all brand catalogue products for a given brand. */
export async function getBrandCatalogue(brandId: string): Promise<CatalogueProduct[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("brand_catalogue_products")
    .select("*")
    .eq("brand_id", brandId)
    .order("name");
  return (data ?? []) as unknown as CatalogueProduct[];
}
