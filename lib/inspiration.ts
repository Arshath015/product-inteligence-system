import { getSupabaseAdmin } from "@/lib/supabase/server";
import { extractInspirationMeta } from "@/lib/inspirationExtraction";
import { findAndUploadImage } from "@/lib/images";
import { classifyUrl, type LinkType } from "@/lib/linkRouter";
import { logActivity } from "@/lib/products";
import type { Inspiration } from "@/lib/types";

export interface SaveInspirationResult {
  status: "created" | "duplicate" | "failed";
  inspiration: Inspiration | null;
  message: string;
}

const PLATFORM_LABEL: Record<Inspiration["platform"], string> = {
  pinterest: "Pinterest",
  instagram: "Instagram",
  manufacturer: "the source",
  brand: "the source",
  other: "the source",
};

/** `inspirations.platform` doesn't have a "product" option — anything that classifyUrl
 * calls a plain product link is, in inspiration-library terms, a manufacturer/brand link. */
function toInspirationPlatform(linkType: LinkType): Inspiration["platform"] {
  return linkType === "product" ? "manufacturer" : linkType;
}

/**
 * Saves a Pinterest/Instagram/other inspiration link. Deduped by canonical
 * URL. Never attempts to log in or bypass access controls — if the
 * platform blocks extraction, saves the bare URL with whatever metadata
 * (if any) was available instead of failing outright.
 */
export async function saveInspirationUrl(url: string, platformHint?: LinkType): Promise<SaveInspirationResult> {
  const supabase = getSupabaseAdmin();
  const platform = toInspirationPlatform(platformHint ?? classifyUrl(url));

  const meta = await extractInspirationMeta(url);

  const { data: existing } = await supabase
    .from("inspirations")
    .select("*")
    .eq("canonical_url", meta.canonicalUrl)
    .maybeSingle();

  if (existing) {
    return {
      status: "duplicate",
      inspiration: existing as Inspiration,
      message: `Already saved${existing.title ? `: "${existing.title}"` : "."}`,
    };
  }

  const { data: created, error } = await supabase
    .from("inspirations")
    .insert({
      platform,
      source_url: url,
      canonical_url: meta.canonicalUrl,
      title: meta.title,
      description: meta.description,
      caption: meta.caption,
      image_status: "pending",
    })
    .select("*")
    .single();

  if (error || !created) {
    return { status: "failed", inspiration: null, message: "Couldn't save that link." };
  }

  if (meta.imageUrls.length > 0) {
    const uploaded = await findAndUploadImage(`inspirations/${created.id}`, meta.imageUrls);
    await supabase
      .from("inspirations")
      .update(
        uploaded
          ? {
              image_original_url: uploaded.originalUrl,
              image_storage_path: uploaded.storagePath,
              image_public_url: uploaded.publicUrl,
              image_status: "stored",
            }
          : { image_status: "missing", image_original_url: meta.imageUrls[0] ?? null }
      )
      .eq("id", created.id);
  } else {
    await supabase.from("inspirations").update({ image_status: "missing" }).eq("id", created.id);
  }

  await logActivity("inspiration_saved", "inspiration", created.id, { platform, source_url: url });

  const { data: final } = await supabase.from("inspirations").select("*").eq("id", created.id).single();

  const label = PLATFORM_LABEL[platform] ?? "source";
  const message = meta.limited
    ? `Saved from ${label} — the page limited what could be extracted, so only the link${
        meta.title ? " and title" : ""
      } were kept.`
    : `Saved "${meta.title ?? "inspiration"}" from ${label}.`;

  return { status: "created", inspiration: final as Inspiration, message };
}
