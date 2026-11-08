import { getSupabaseAdmin } from "@/lib/supabase/server";
import { extractProductFromUrl, IMAGE_BLACKLIST } from "@/lib/extraction";
import { findAndUploadImage } from "@/lib/images";
import { tavilySearch } from "@/lib/tavily";
import { logActivity } from "@/lib/products";
import { tokensFrom } from "@/lib/textTokens";
import { config } from "@/lib/config";

export interface RecoveryResult {
  productId: string;
  status: "recovered" | "already_stored" | "still_missing" | "not_found";
  source?: "original" | "alternate";
  message: string;
}

function namesLikelyMatch(a: string, b: string): boolean {
  const ta = new Set(tokensFrom(a));
  const tb = tokensFrom(b);
  if (ta.size === 0 || tb.length === 0) return false;
  const overlap = tb.filter((t) => ta.has(t)).length;
  return overlap / Math.min(ta.size, tb.length) >= 0.5;
}

/**
 * Re-attempts to find and store a product's primary image. Always updates
 * the existing product_images row in place — never inserts a second one,
 * so a product can be recovered any number of times without duplicating
 * rows or creating a duplicate product.
 *
 * Strategy:
 * 1. Re-extract from the product's own source_url with the current
 *    (improved) download/validation pipeline — covers cases where the
 *    image was simply too large or a transient fetch glitch before.
 * 2. If the source site itself blocks automated access (bot detection,
 *    persistent 403s), search for the same product on another legitimate
 *    page and only accept an image from a result whose extracted name
 *    clearly matches this product — never substitutes an unrelated photo.
 */
export async function recoverProductImage(productId: string, force = false): Promise<RecoveryResult> {
  const supabase = getSupabaseAdmin();

  const { data: product } = await supabase
    .from("products")
    .select("id, name, source_url, brand:brands(name)")
    .eq("id", productId)
    .maybeSingle();
  if (!product) return { productId, status: "not_found", message: "Product not found." };

  const { data: imageRow } = await supabase
    .from("product_images")
    .select("id, status, storage_path")
    .eq("product_id", productId)
    .eq("is_primary", true)
    .maybeSingle();

  if (imageRow?.status === "stored" && !force) {
    return { productId, status: "already_stored", message: "Image already stored." };
  }
  if (!product.source_url) {
    return { productId, status: "still_missing", message: "No source URL to recover from." };
  }

  const brandName = Array.isArray(product.brand) ? product.brand[0]?.name : (product.brand as { name: string } | null)?.name;

  async function tryUpload(candidateUrls: string[]) {
    if (candidateUrls.length === 0) return null;
    return findAndUploadImage(productId, candidateUrls, { validateWithVision: true });
  }

  const applyUpload = async (uploaded: NonNullable<Awaited<ReturnType<typeof tryUpload>>>) => {
    if (imageRow) {
      const previousPath = imageRow.storage_path as string | null;
      await supabase
        .from("product_images")
        .update({
          original_url: uploaded.originalUrl,
          storage_path: uploaded.storagePath,
          public_url: uploaded.publicUrl,
          width: uploaded.width,
          height: uploaded.height,
          status: "stored",
        })
        .eq("id", imageRow.id);
      // Only cleaned up once the new image is confirmed stored above —
      // never delete the old blob before the replacement is safely in place.
      if (previousPath && previousPath !== uploaded.storagePath) {
        await supabase.storage.from(config.storage.bucket).remove([previousPath]).catch(() => {});
      }
    } else {
      await supabase.from("product_images").insert({
        product_id: productId,
        original_url: uploaded.originalUrl,
        storage_path: uploaded.storagePath,
        public_url: uploaded.publicUrl,
        width: uploaded.width,
        height: uploaded.height,
        is_primary: true,
        status: "stored",
      });
    }
  };

  // 1. Re-try the product's own source page.
  try {
    const extracted = await extractProductFromUrl(product.source_url);
    const uploaded = await tryUpload(extracted.imageUrls);
    if (uploaded) {
      await applyUpload(uploaded);
      await logActivity("image_recovered", "product", productId, { source: "original" });
      return { productId, status: "recovered", source: "original", message: "Recovered from the original source." };
    }
  } catch {
    // original source unreachable/blocked — fall through to alternate search
  }

  // 2. Alternate legitimate source — only accept if the found page is
  // clearly about the same product.
  const query = [brandName, product.name, "product photo"].filter(Boolean).join(" ");
  try {
    const results = await tavilySearch(query, { maxResults: 5, includeImages: false });
    for (const result of results.results) {
      if (result.url === product.source_url) continue;
      try {
        const extracted = await extractProductFromUrl(result.url);
        if (!namesLikelyMatch(product.name, extracted.name)) continue;
        const uploaded = await tryUpload(extracted.imageUrls);
        if (uploaded) {
          await applyUpload(uploaded);
          await logActivity("image_recovered", "product", productId, { source: "alternate", url: result.url });
          return {
            productId,
            status: "recovered",
            source: "alternate",
            message: `Recovered from an alternate source (${new URL(result.url).hostname}).`,
          };
        }
      } catch {
        continue;
      }
    }
  } catch {
    // web search unavailable — nothing more we can legitimately try
  }

  if (imageRow) {
    await supabase.from("product_images").update({ status: "missing" }).eq("id", imageRow.id);
  } else {
    await supabase.from("product_images").insert({
      product_id: productId,
      is_primary: true,
      status: "missing",
    });
  }
  return {
    productId,
    status: "still_missing",
    message: "No legitimate product-specific image could be retrieved.",
  };
}

export async function recoverAllMissingImages(projectId?: string): Promise<RecoveryResult[]> {
  const supabase = getSupabaseAdmin();
  const { data: rows } = await supabase
    .from("product_images")
    .select("product_id")
    .in("status", ["missing", "failed"])
    .eq("is_primary", true);
  let ids = Array.from(new Set((rows ?? []).map((r) => r.product_id as string)));

  if (projectId && ids.length > 0) {
    const { data: owned } = await supabase.from("products").select("id").eq("project_id", projectId).in("id", ids);
    const ownedIds = new Set((owned ?? []).map((p) => p.id as string));
    ids = ids.filter((id) => ownedIds.has(id));
  }
  const results: RecoveryResult[] = [];
  for (const id of ids) {
    results.push(await recoverProductImage(id));
  }
  return results;
}

export interface SuspectImage {
  productId: string;
  name: string;
  originalUrl: string;
  reason: string;
}

/**
 * Read-only scan of already-"stored" primary images for ones that were
 * almost certainly mis-selected under the old (pre-DOM-context) extraction
 * logic — their original_url contains a newsletter/popup/cookie/promo/ad
 * keyword. Flags only; never modifies anything. A flagged product is a
 * candidate for recoverSuspectImages, not an automatic rewrite.
 */
export async function auditProductImages(projectId?: string): Promise<SuspectImage[]> {
  const supabase = getSupabaseAdmin();
  const { data: rows } = await supabase
    .from("product_images")
    .select("product_id, original_url, product:products(id, name, project_id)")
    .eq("is_primary", true)
    .eq("status", "stored")
    .not("original_url", "is", null);

  const suspects: SuspectImage[] = [];
  for (const row of rows ?? []) {
    const originalUrl = row.original_url as string | null;
    if (!originalUrl) continue;
    const product = Array.isArray(row.product) ? row.product[0] : row.product;
    if (!product) continue;
    if (projectId && product.project_id !== projectId) continue;

    const lower = originalUrl.toLowerCase();
    const matched = IMAGE_BLACKLIST.find((k) => lower.includes(k));
    if (matched) {
      suspects.push({
        productId: product.id as string,
        name: product.name as string,
        originalUrl,
        reason: `original_url matches excluded pattern "${matched}"`,
      });
    }
  }
  return suspects;
}

/**
 * Re-runs recovery (forced, bypassing the "already stored" guard) for every
 * product flagged by auditProductImages — the only path that overwrites a
 * "stored" image, and only for images that matched an exclusion pattern.
 * Still never creates a second product_images row or a duplicate product;
 * if the improved pipeline can't find a better candidate than before, the
 * existing row is left as-is rather than replaced with something worse.
 */
export async function recoverSuspectImages(projectId?: string): Promise<RecoveryResult[]> {
  const suspects = await auditProductImages(projectId);
  const results: RecoveryResult[] = [];
  for (const s of suspects) {
    results.push(await recoverProductImage(s.productId, true));
  }
  return results;
}
