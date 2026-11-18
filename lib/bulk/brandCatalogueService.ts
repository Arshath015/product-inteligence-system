/**
 * Brand catalogue library — extracts all products from a brand and saves them
 * to `brand_catalogue_products` (independent of any project). Streams progress
 * via an optional callback so the SSE route can push live updates.
 */
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchPageSignals, hasUsableSignal, BROWSER_HEADERS } from "@/lib/pageSignals";
import { extractProductFromUrl } from "@/lib/extraction";
import { crawlBrandCatalogue } from "@/lib/bulk/brandCrawl";
import { resolveBrandDetailed } from "@/lib/catalog";
import { slugify } from "@/lib/slug";
import { nanoid } from "nanoid";
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
  | { type: "phase"; phase: "discovering" | "pre_screening" | "extracting" | "done"; message: string }
  | { type: "discovered"; total: number; brandId: string; brandName: string }
  | { type: "product"; product: CatalogueProduct; extracted: number; total: number; failed: number }
  | { type: "skip"; url: string; extracted: number; total: number; failed: number }
  | { type: "done"; extracted: number; total: number; failed: number; brandId: string; hasMore: boolean }
  | { type: "error"; message: string };

// Titles that identify "not found" pages even when the server returns HTTP 200.
const SOFT_404_TITLE_RE =
  /\b(404|page\s+not\s+found|pagina\s+non\s+trovata|page\s+introuvable|seite\s+nicht\s+gefunden|p[aá]gina\s+no\s+encontrada|page\s+does\s+not\s+exist)\b/i;

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

/** Lightweight liveness check: fetches the first 2 KB to detect hard and soft 404s. */
async function isAlive(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const reader = res.body?.getReader();
    if (!reader) { await res.body?.cancel(); return true; }
    let chunk = "";
    try {
      while (chunk.length < 2048) {
        const { done, value } = await reader.read();
        if (done) break;
        chunk += new TextDecoder().decode(value);
        if (chunk.includes("</title>")) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    const title = chunk.match(/<title>([^<]+)/i)?.[1]?.trim() ?? "";
    return !SOFT_404_TITLE_RE.test(title);
  } catch {
    return true;
  }
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
  onEvent: (event: ExtractProgressEvent) => void
): Promise<void> {
  const supabase = getSupabaseAdmin();

  try {
    onEvent({ type: "phase", phase: "discovering", message: "Fetching brand homepage…" });

    let homepageSignals = null;
    try {
      const fetched = await fetchPageSignals(brandUrl);
      if (hasUsableSignal(fetched)) homepageSignals = fetched;
    } catch {
      // proceed without homepage signals
    }

    const brandNameGuess = (() => {
      if (homepageSignals?.title) {
        const first = homepageSignals.title.split(/[|\-–—]/)[0]?.trim();
        if (first && first.length > 1 && first.length < 60) return first;
      }
      try { return new URL(brandUrl).hostname.replace(/^www\./, "").split(".")[0]; } catch { return "Brand"; }
    })();

    onEvent({ type: "phase", phase: "discovering", message: `Scanning ${brandNameGuess} catalogue…` });

    const resolved = await resolveBrandForCatalogue(projectId, brandNameGuess, brandUrl);
    if (!resolved) {
      onEvent({ type: "error", message: "Could not identify a brand from that URL." });
      return;
    }

    const crawl = await crawlBrandCatalogue(
      brandUrl,
      homepageSignals,
      (msg) => onEvent({ type: "phase", phase: "discovering", message: msg }),
      { maxProducts: 300, maxCollections: 40 }
    );

    const rawUrls = crawl.productUrls;
    if (rawUrls.length === 0) {
      onEvent({ type: "error", message: "No product URLs found on this brand's website." });
      return;
    }

    onEvent({ type: "discovered", total: rawUrls.length, brandId: resolved.id, brandName: resolved.name });

    // Filter out URLs already extracted
    const { data: existing } = await supabase
      .from("brand_catalogue_products")
      .select("source_url, id, name, slug, description, images, primary_image_url, category_id, category_name, extracted_at, brand_id")
      .eq("brand_id", resolved.id)
      .in("source_url", rawUrls);
    const alreadyDoneSet = new Set((existing ?? []).map((r) => r.source_url as string));

    // Stream already-known products back immediately
    let streamedCount = 0;
    for (const p of existing ?? []) {
      onEvent({
        type: "product",
        product: p as unknown as CatalogueProduct,
        extracted: ++streamedCount,
        total: rawUrls.length,
        failed: 0,
      });
    }

    const toExtract = rawUrls.filter((u) => !alreadyDoneSet.has(u));

    if (toExtract.length === 0) {
      onEvent({ type: "done", extracted: streamedCount, total: rawUrls.length, failed: 0, brandId: resolved.id, hasMore: false });
      return;
    }

    // Cap per-call work so we fit within Vercel's 300s timeout.
    // Auto-resume (client-side) handles remaining URLs in subsequent calls.
    const MAX_PER_CALL = 20;
    // On resume batches (some products already extracted) skip pre-screening —
    // we've already identified dead URLs; extraction timeout handles any stragglers.
    const isResumeBatch = streamedCount > 0;
    let thisBatch: string[];
    let deadCount: number;

    if (isResumeBatch) {
      thisBatch = toExtract.slice(0, MAX_PER_CALL);
      deadCount = 0;
      onEvent({ type: "phase", phase: "extracting", message: `Extracting next ${thisBatch.length} products…` });
    } else {
      const candidates = toExtract.slice(0, MAX_PER_CALL * 2); // screen 2× buffer (40) to find 20 live
      onEvent({ type: "phase", phase: "pre_screening", message: `Pre-screening ${candidates.length} URLs…` });
      const alive: string[] = [];
      await runPool(candidates, 5, async (url) => {
        if (alive.length < MAX_PER_CALL && await isAlive(url)) alive.push(url);
      });
      thisBatch = alive.slice(0, MAX_PER_CALL);
      deadCount = candidates.length - alive.length;
      onEvent({ type: "phase", phase: "extracting", message: `Extracting ${thisBatch.length} products…` });
    }

    let extracted = streamedCount;
    let failed = deadCount;
    const total = rawUrls.length;

    // Look up all categories once for fast resolution
    const { data: cats } = await supabase.from("categories").select("id, slug, name");
    const catBySlug = new Map((cats ?? []).map((c) => [c.slug as string, c.id as string]));
    const catByName = new Map((cats ?? []).map((c) => [(c.name as string).toLowerCase(), c.id as string]));

    await runPool(thisBatch, 5, async (url) => {
      try {
        const data: ExtractedProductData = await Promise.race([
          extractProductFromUrl(url),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("extraction timeout")), 18000)
          ),
        ]);
        if (!data.name.trim()) {
          failed++;
          onEvent({ type: "skip", url, extracted: ++extracted, total, failed });
          return;
        }

        // Resolve category
        let categoryId: string | null = null;
        if (data.categoryHint) {
          const hintLower = data.categoryHint.toLowerCase();
          categoryId = catBySlug.get(hintLower) ?? catByName.get(hintLower) ?? null;
        }

        const slug = await uniqueCatalogueSlug(resolved.id, data.name);
        const images = data.imageUrls ?? [];

        const row = {
          brand_id: resolved.id,
          name: data.name,
          slug,
          source_url: url,
          description: data.description ?? null,
          images,
          primary_image_url: images[0] ?? null,
          category_id: categoryId,
          category_name: data.categoryHint ?? null,
        };

        const { data: saved, error } = await supabase
          .from("brand_catalogue_products")
          .upsert(row, { onConflict: "source_url", ignoreDuplicates: false })
          .select()
          .single();

        if (error || !saved) {
          failed++;
          onEvent({ type: "skip", url, extracted: ++extracted, total, failed });
          return;
        }

        onEvent({
          type: "product",
          product: saved as unknown as CatalogueProduct,
          extracted: ++extracted,
          total,
          failed,
        });
      } catch {
        failed++;
        onEvent({ type: "skip", url, extracted: ++extracted, total, failed });
      }
    });

    // hasMore = true when more unprocessed URLs remain beyond this batch
    const hasMore = toExtract.length > MAX_PER_CALL;
    onEvent({ type: "done", extracted, total, failed, brandId: resolved.id, hasMore });
  } catch (err) {
    onEvent({ type: "error", message: (err as Error).message });
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

  const rows = toInsert.map((p) => ({
    project_id: projectId,
    brand_id: p.brand_id as string,
    name: p.name as string,
    slug: `${slugify(p.name as string)}-${nanoid(6)}`,
    source_url: p.source_url as string,
    description: p.description as string | null,
    category_id: p.category_id as string | null,
    status: "published",
    extraction_status: "complete",
  }));

  const { data: inserted, error } = await supabase
    .from("products")
    .insert(rows)
    .select("id, source_url");

  if (error || !inserted) return { added: 0, duplicates };

  // Insert images for each newly added product
  const imageInserts: { product_id: string; original_url: string; is_primary: boolean; status: string }[] = [];
  for (const product of inserted) {
    const src = items.find((p) => p.source_url === product.source_url);
    const imgs: string[] = Array.isArray(src?.images) ? (src.images as string[]) : [];
    for (let i = 0; i < imgs.length; i++) {
      imageInserts.push({
        product_id: product.id as string,
        original_url: imgs[i],
        is_primary: i === 0,
        status: "pending",
      });
    }
  }

  if (imageInserts.length > 0) {
    await supabase.from("product_images").insert(imageInserts);
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
