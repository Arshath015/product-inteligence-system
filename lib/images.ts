import { nanoid } from "nanoid";
import sharp from "sharp";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { config } from "@/lib/config";
import { isLikelyProductPhoto } from "@/lib/visionValidate";

// Hard ceiling — refuses anything bigger even before fully trusting
// Content-Length (abuse/mistake protection, not a normal-photo limit).
const HARD_LIMIT_BYTES = 40 * 1024 * 1024;
// Above this, or above MAX_DIMENSION, we recompress so storage/catalogue
// loading stays fast — real manufacturer photography is often shot at
// medium-format resolution (6000px+, 20MB+ JPEGs) which is wasteful to
// serve as-is but is still the authentic product photo, just re-encoded.
const RECOMPRESS_ABOVE_BYTES = 3 * 1024 * 1024;
const MAX_DIMENSION = 2400;
const JPEG_QUALITY = 85;
// Below this on either edge, it's not a usable catalogue photo — almost
// always a lazy-load placeholder or icon (e.g. Salesforce Commerce Cloud's
// `?sw=20` thumbnail params), not the real product image.
const MIN_DIMENSION = 200;

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

interface Downloaded {
  bytes: Buffer;
  contentType: string;
  width: number | null;
  height: number | null;
}

/**
 * Downloads a candidate image and validates it's an actual decodable image
 * (not an HTML error/challenge page mislabeled or mismatched content-type,
 * not a truncated/corrupt file) by having sharp parse it — this is a real
 * format check, not just trusting the server's Content-Type header or the
 * URL's file extension. Oversized images are recompressed (same photo,
 * smaller file) rather than rejected outright.
 */
async function tryDownload(url: string): Promise<Downloaded | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const declaredType = res.headers.get("content-type") || "";
  const contentLength = Number(res.headers.get("content-length") || "0");
  if (contentLength > HARD_LIMIT_BYTES) return null;
  // A non-image content-type is a strong early signal (e.g. a bot-detection
  // HTML challenge page served where an image was expected), but we still
  // verify by decoding below rather than trusting an image/* header alone.
  if (declaredType && !declaredType.startsWith("image/") && !declaredType.includes("octet-stream")) {
    return null;
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
  if (buf.byteLength === 0 || buf.byteLength > HARD_LIMIT_BYTES) return null;

  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    // Doesn't decode as an image at all — e.g. an HTML error/challenge page.
    return null;
  }
  if (!meta.width || !meta.height) return null;
  if (meta.width < MIN_DIMENSION || meta.height < MIN_DIMENSION) return null;

  const needsRecompress =
    buf.byteLength > RECOMPRESS_ABOVE_BYTES || meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION;

  if (!needsRecompress) {
    return {
      bytes: buf,
      contentType: declaredType.startsWith("image/") ? declaredType : `image/${meta.format ?? "jpeg"}`,
      width: meta.width,
      height: meta.height,
    };
  }

  try {
    const resized = sharp(buf).rotate().resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    });
    const out = meta.hasAlpha
      ? await resized.png({ compressionLevel: 8 }).toBuffer({ resolveWithObject: true })
      : await resized.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    return {
      bytes: out.data,
      contentType: meta.hasAlpha ? "image/png" : "image/jpeg",
      width: out.info.width,
      height: out.info.height,
    };
  } catch {
    // Recompression failed for some reason — the original decoded fine, so
    // fall back to storing it as-is rather than losing a valid image.
    return {
      bytes: buf,
      contentType: declaredType.startsWith("image/") ? declaredType : `image/${meta.format ?? "jpeg"}`,
      width: meta.width,
      height: meta.height,
    };
  }
}

const MAX_VISION_CHECKS = 4;

export interface UploadedImage {
  storagePath: string;
  publicUrl: string;
  originalUrl: string;
  width: number | null;
  height: number | null;
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
    return {
      storagePath: path,
      publicUrl: pub.publicUrl,
      originalUrl: url,
      width: downloaded.width,
      height: downloaded.height,
    };
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
            width: uploaded.width,
            height: uploaded.height,
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
