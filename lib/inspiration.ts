import { getSupabaseAdmin } from "@/lib/supabase/server";
import { extractInspirationMeta } from "@/lib/inspirationExtraction";
import { findAndUploadImage } from "@/lib/images";
import { classifyUrl, type LinkType } from "@/lib/linkRouter";
import { logActivity } from "@/lib/products";
import type { Inspiration } from "@/lib/types";
import type { PageSignals } from "@/lib/pageSignals";

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

async function ensureInspirationVisible(projectId: string, inspirationId: string) {
  const supabase = getSupabaseAdmin();
  await supabase
    .from("project_inspirations")
    .upsert(
      { project_id: projectId, inspiration_id: inspirationId },
      { onConflict: "project_id,inspiration_id", ignoreDuplicates: true }
    );
}

/**
 * Saves a Pinterest/Instagram/other inspiration link. Deduped by canonical
 * URL. Never attempts to log in or bypass access controls — if the
 * platform blocks extraction, saves the bare URL with whatever metadata
 * (if any) was available instead of failing outright.
 */
export async function saveInspirationUrl(
  projectId: string,
  url: string,
  platformHint?: LinkType,
  preloadedSignals?: PageSignals | null,
  extraTags?: string[]
): Promise<SaveInspirationResult> {
  const supabase = getSupabaseAdmin();
  const platform = toInspirationPlatform(platformHint ?? classifyUrl(url));

  const meta = await extractInspirationMeta(url, preloadedSignals);

  const { data: visibleRows, error: visibleError } = await supabase
    .from("project_inspirations")
    .select("inspiration_id")
    .eq("project_id", projectId);

  // Falls back to the pre-junction-table owning-project check if the
  // project_inspirations migration hasn't been applied yet (missing-table
  // error) — duplicate detection for this project's own saves must never
  // depend on an optional migration having run.
  const existing = visibleError
    ? (
        await supabase
          .from("inspirations")
          .select("*")
          .eq("project_id", projectId)
          .eq("canonical_url", meta.canonicalUrl)
          .maybeSingle()
      ).data
    : (
        await supabase
          .from("inspirations")
          .select("*")
          .eq("canonical_url", meta.canonicalUrl)
          .in(
            "id",
            (visibleRows ?? []).map((r) => r.inspiration_id as string).length > 0
              ? (visibleRows ?? []).map((r) => r.inspiration_id as string)
              : ["00000000-0000-0000-0000-000000000000"]
          )
          .maybeSingle()
      ).data;

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
      project_id: projectId,
      platform,
      source_url: url,
      canonical_url: meta.canonicalUrl,
      title: meta.title,
      description: meta.description,
      caption: meta.caption,
      image_status: "pending",
      tags: extraTags ?? [],
    })
    .select("*")
    .single();

  if (error || !created) {
    // A unique-constraint hit here means the pre-check's visibility lookup
    // missed an already-owned row (e.g. the migration gap above) — recover
    // by fetching it instead of reporting a hard failure for what is, from
    // the client's perspective, just a duplicate submission.
    if (error?.code === "23505") {
      const { data: raceWinner } = await supabase
        .from("inspirations")
        .select("*")
        .eq("project_id", projectId)
        .eq("canonical_url", meta.canonicalUrl)
        .maybeSingle();
      if (raceWinner) {
        await ensureInspirationVisible(projectId, raceWinner.id as string);
        return {
          status: "duplicate",
          inspiration: raceWinner as Inspiration,
          message: `Already saved${raceWinner.title ? `: "${raceWinner.title}"` : "."}`,
        };
      }
    }
    return { status: "failed", inspiration: null, message: "Couldn't save that link." };
  }

  await ensureInspirationVisible(projectId, created.id as string);

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

  await logActivity("inspiration_saved", "inspiration", created.id, { project_id: projectId, platform, source_url: url });

  const { data: final } = await supabase.from("inspirations").select("*").eq("id", created.id).single();

  const label = PLATFORM_LABEL[platform] ?? "source";
  const message = meta.limited
    ? `Saved from ${label} — the page limited what could be extracted, so only the link${
        meta.title ? " and title" : ""
      } were kept.`
    : `Saved "${meta.title ?? "inspiration"}" from ${label}.`;

  return { status: "created", inspiration: final as Inspiration, message };
}
