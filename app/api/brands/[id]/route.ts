import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { PRODUCT_SELECT_WITH_RELATIONS, logActivity } from "@/lib/products";
import { missingProjectIdResponse } from "@/lib/http";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return missingProjectIdResponse();

  const supabase = getSupabaseAdmin();
  const { data: brand, error } = await supabase.from("brands").select("*").eq("id", id).maybeSingle();
  if (error || !brand) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: visibleRows } = await supabase
    .from("project_products")
    .select("product_id")
    .eq("project_id", projectId);
  const visibleIds = (visibleRows ?? []).map((r) => r.product_id as string);

  const { data: products } = await supabase
    .from("products")
    .select(PRODUCT_SELECT_WITH_RELATIONS)
    .eq("brand_id", id)
    .eq("status", "published")
    .in("id", visibleIds.length > 0 ? visibleIds : ["00000000-0000-0000-0000-000000000000"])
    .order("created_at", { ascending: false });

  return NextResponse.json({ brand, products: products ?? [] });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body?.projectId) return missingProjectIdResponse();
  const projectId = body.projectId as string;

  const supabase = getSupabaseAdmin();
  const { data: existing } = await supabase.from("brands").select("project_id").eq("id", id).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.project_id !== projectId) {
    return NextResponse.json(
      { error: "This brand is referenced from another project — it can only be edited from its owning project." },
      { status: 403 }
    );
  }

  const patch: Record<string, unknown> = {};
  for (const field of ["name", "description", "country", "status"] as const) {
    if (body[field] !== undefined) patch[field] = body[field];
  }
  if (body.websiteUrl !== undefined) patch.website_url = body.websiteUrl;

  const { data, error } = await supabase.from("brands").update(patch).eq("id", id).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logActivity("brand_updated", "brand", id, { project_id: projectId });
  return NextResponse.json({ brand: data });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return missingProjectIdResponse();

  const supabase = getSupabaseAdmin();
  const { data: brand } = await supabase.from("brands").select("project_id").eq("id", id).maybeSingle();
  if (!brand) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (brand.project_id !== projectId) {
    await supabase.from("project_brands").delete().eq("project_id", projectId).eq("brand_id", id);
    await logActivity("brand_reference_removed", "brand", id, { project_id: projectId });
    return NextResponse.json({ ok: true, removedReferenceOnly: true });
  }

  const { data: externalRefs } = await supabase
    .from("project_brands")
    .select("project_id")
    .eq("brand_id", id)
    .neq("project_id", projectId);
  if (externalRefs && externalRefs.length > 0) {
    return NextResponse.json(
      {
        error: `This brand is referenced by ${externalRefs.length} other project(s) — remove those references first.`,
      },
      { status: 409 }
    );
  }

  const { error } = await supabase.from("brands").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logActivity("brand_deleted", "brand", id, { project_id: projectId });
  return NextResponse.json({ ok: true });
}
