import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { logActivity } from "@/lib/products";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("inspirations").select("*").eq("id", id).maybeSingle();
  if (error || !data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ inspiration: data });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const patch: Record<string, unknown> = {};
  for (const field of ["title", "description", "caption", "status"] as const) {
    if (body[field] !== undefined) patch[field] = body[field];
  }
  if (body.tags !== undefined) patch.tags = body.tags;
  if (body.relatedBrandId !== undefined) patch.related_brand_id = body.relatedBrandId;
  if (body.relatedProductId !== undefined) patch.related_product_id = body.relatedProductId;

  const { data, error } = await supabase.from("inspirations").update(patch).eq("id", id).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logActivity("inspiration_updated", "inspiration", id);
  return NextResponse.json({ inspiration: data });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("inspirations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logActivity("inspiration_deleted", "inspiration", id);
  return NextResponse.json({ ok: true });
}
