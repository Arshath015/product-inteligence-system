import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * IDs of inspirations visible to a project (owned or referenced via
 * project_inspirations). Falls back to owned-only (`inspirations.project_id`)
 * if the project_inspirations migration hasn't been applied yet — reading
 * a project's own saved inspirations must never hard-depend on an optional
 * migration having run.
 */
export async function getVisibleInspirationIds(projectId: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("project_inspirations").select("inspiration_id").eq("project_id", projectId);
  if (error) {
    const { data: owned } = await supabase.from("inspirations").select("id").eq("project_id", projectId);
    return (owned ?? []).map((r) => r.id as string);
  }
  return (data ?? []).map((r) => r.inspiration_id as string);
}
