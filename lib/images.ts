import { nanoid } from "nanoid";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { config } from "@/lib/config";

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

/**
 * Tries each candidate image URL in order (best source first), downloads
 * the bytes server-side, and persists the first one that succeeds in
 * Supabase Storage. Never substitutes an unrelated image — if every
 * candidate fails, it records a "missing" row instead.
 */
export async function storeBestProductImage(
  productId: string,
  candidateUrls: string[],
  isPrimary: boolean
) {
  const supabase = getSupabaseAdmin();

  for (const url of candidateUrls) {
    const downloaded = await tryDownload(url);
    if (!downloaded) continue;

    const ext = extFromContentType(downloaded.contentType);
    const path = `${productId}/${nanoid()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(config.storage.bucket)
      .upload(path, downloaded.bytes, {
        contentType: downloaded.contentType,
        upsert: false,
      });
    if (uploadError) continue;

    const { data: pub } = supabase.storage.from(config.storage.bucket).getPublicUrl(path);

    const { data: row, error } = await supabase
      .from("product_images")
      .insert({
        product_id: productId,
        original_url: url,
        storage_path: path,
        public_url: pub.publicUrl,
        is_primary: isPrimary,
        status: "stored",
      })
      .select()
      .single();

    if (!error) return row;
  }

  const { data: row } = await supabase
    .from("product_images")
    .insert({
      product_id: productId,
      original_url: candidateUrls[0] ?? null,
      is_primary: isPrimary,
      status: "missing",
    })
    .select()
    .single();

  return row;
}
