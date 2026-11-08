import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { logActivity } from "@/lib/products";
import { missingProjectIdResponse } from "@/lib/http";
import { getVisibleInspirationIds } from "@/lib/inspirationVisibility";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return missingProjectIdResponse();

  const supabase = getSupabaseAdmin();
  const visibleIds = await getVisibleInspirationIds(projectId);
  if (!visibleIds.includes(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await supabase.from("inspirations").select("*").eq("id", id).maybeSingle();
  if (error || !data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ inspiration: { ...data, is_owner: data.project_id === projectId } });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body?.projectId) return missingProjectIdResponse();
  const projectId = body.projectId as string;

  const supabase = getSupabaseAdmin();
  const { data: existing } = await supabase.from("inspirations").select("project_id").eq("id", id).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.project_id !== projectId) {
    return NextResponse.json(
      { error: "This inspiration is referenced from another project — it can only be edited from its owning project." },
      { status: 403 }
    );
  }

  const patch: Record<string, unknown> = {};
  for (const field of ["title", "description", "caption", "status"] as const) {
    if (body[field] !== undefined) patch[field] = body[field];
  }
  if (body.tags !== undefined) patch.tags = body.tags;
  if (body.relatedBrandId !== undefined) patch.related_brand_id = body.relatedBrandId;
  if (body.relatedProductId !== undefined) patch.related_product_id = body.relatedProductId;

  const { data, error } = await supabase.from("inspirations").update(patch).eq("id", id).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logActivity("inspiration_updated", "inspiration", id, { project_id: projectId });
  return NextResponse.json({ inspiration: data });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return missingProjectIdResponse();

  const supabase = getSupabaseAdmin();
  const { data: inspiration } = await supabase.from("inspirations").select("project_id").eq("id", id).maybeSingle();
  if (!inspiration) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (inspiration.project_id !== projectId) {
    await supabase.from("project_inspirations").delete().eq("project_id", projectId).eq("inspiration_id", id);
    await logActivity("inspiration_reference_removed", "inspiration", id, { project_id: projectId });
    return NextResponse.json({ ok: true, removedReferenceOnly: true });
  }

  const { data: externalRefs } = await supabase
    .from("project_inspirations")
    .select("project_id")
    .eq("inspiration_id", id)
    .neq("project_id", projectId);
  if (externalRefs && externalRefs.length > 0) {
    return NextResponse.json(
      {
        error: `This inspiration is referenced by ${externalRefs.length} other project(s) — remove those references first.`,
      },
      { status: 409 }
    );
  }

  const { error } = await supabase.from("inspirations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logActivity("inspiration_deleted", "inspiration", id, { project_id: projectId });
  return NextResponse.json({ ok: true });
}
