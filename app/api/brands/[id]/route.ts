import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { PRODUCT_SELECT_WITH_RELATIONS, logActivity } from "@/lib/products";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = getSupabaseAdmin();
  const { data: brand, error } = await supabase.from("brands").select("*").eq("id", id).maybeSingle();
  if (error || !brand) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: products } = await supabase
    .from("products")
    .select(PRODUCT_SELECT_WITH_RELATIONS)
    .eq("brand_id", id)
    .eq("status", "published")
    .order("created_at", { ascending: false });

  return NextResponse.json({ brand, products: products ?? [] });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const patch: Record<string, unknown> = {};
  for (const field of ["name", "description", "country", "status"] as const) {
    if (body[field] !== undefined) patch[field] = body[field];
  }
  if (body.websiteUrl !== undefined) patch.website_url = body.websiteUrl;

  const { data, error } = await supabase.from("brands").update(patch).eq("id", id).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logActivity("brand_updated", "brand", id);
  return NextResponse.json({ brand: data });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("brands").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logActivity("brand_deleted", "brand", id);
  return NextResponse.json({ ok: true });
}
