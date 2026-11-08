import { nanoid } from "nanoid";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { config } from "@/lib/config";
import { isLikelyProductPhoto } from "@/lib/visionValidate";

const MAX_BYTES = 8 * 1024 * 1024;
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
};

function extFromContentType(ct: string): string {
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("avif")) return "avif";
  return "jpg";
}

async function tryDownload(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
    return { bytes: buf, contentType };
  } catch {
    return null;
  }
}

const MAX_VISION_CHECKS = 4;

export interface UploadedImage {
  storagePath: string;
  publicUrl: string;
  originalUrl: string;
}

/**
 * Tries each candidate image URL in order (best source first), downloads
 * the bytes server-side, and uploads the first one that succeeds to
 * Supabase Storage under `${pathPrefix}/<random>.<ext>`. Never substitutes
 * an unrelated image — returns null if every candidate fails (or fails a
 * vision sanity-check, when requested) so the caller can record a "missing"
 * status instead of silently picking something unrelated.
 */
export async function findAndUploadImage(
  pathPrefix: string,
  candidateUrls: string[],
  opts: { validateWithVision?: boolean } = {}
): Promise<UploadedImage | null> {
  const supabase = getSupabaseAdmin();
  let visionChecks = 0;

  for (const url of candidateUrls) {
    const downloaded = await tryDownload(url);
    if (!downloaded) continue;

    if (opts.validateWithVision && visionChecks < MAX_VISION_CHECKS) {
      visionChecks++;
      const ok = await isLikelyProductPhoto(downloaded.bytes, downloaded.contentType);
      if (!ok) continue;
    }

    const ext = extFromContentType(downloaded.contentType);
    const path = `${pathPrefix}/${nanoid()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(config.storage.bucket)
      .upload(path, downloaded.bytes, {
        contentType: downloaded.contentType,
        upsert: false,
      });
    if (uploadError) continue;

    const { data: pub } = supabase.storage.from(config.storage.bucket).getPublicUrl(path);
    return { storagePath: path, publicUrl: pub.publicUrl, originalUrl: url };
  }

  return null;
}

/**
 * Tries each candidate image URL in order and persists the first one that
 * succeeds as a `product_images` row. Records a "missing" row if every
 * candidate fails.
 */
export async function storeBestProductImage(
  productId: string,
  candidateUrls: string[],
  isPrimary: boolean,
  opts: { validateWithVision?: boolean } = {}
) {
  const supabase = getSupabaseAdmin();
  const uploaded = await findAndUploadImage(productId, candidateUrls, opts);

  const { data: row } = await supabase
    .from("product_images")
    .insert(
      uploaded
        ? {
            product_id: productId,
            original_url: uploaded.originalUrl,
            storage_path: uploaded.storagePath,
            public_url: uploaded.publicUrl,
            is_primary: isPrimary,
            status: "stored",
          }
        : {
            product_id: productId,
            original_url: candidateUrls[0] ?? null,
            is_primary: isPrimary,
            status: "missing",
          }
    )
    .select()
    .single();

  return row;
}
