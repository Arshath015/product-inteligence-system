import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getProductWithRelations, logActivity } from "@/lib/products";
import { resolveBrand, resolveDesigner, resolveCategory } from "@/lib/catalog";
import { storeBestProductImage } from "@/lib/images";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const product = await getProductWithRelations(id);
  if (!product) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ product });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const patch: Record<string, unknown> = {};

  for (const field of ["name", "description", "materials", "dimensions", "status"] as const) {
    if (body[field] !== undefined) patch[field] = body[field];
  }
  if (body.priceText !== undefined) patch.price_text = body.priceText;
  if (body.sourceUrl !== undefined) patch.source_url = body.sourceUrl;
  if (body.brandName !== undefined) patch.brand_id = await resolveBrand(body.brandName);
  if (body.designerName !== undefined) patch.designer_id = await resolveDesigner(body.designerName);
  if (body.categorySlug !== undefined) patch.category_id = await resolveCategory(body.categorySlug);

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from("products").update(patch).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (body.imageUrl) {
    await supabase.from("product_images").update({ is_primary: false }).eq("product_id", id);
    await storeBestProductImage(id, [body.imageUrl], true);
  }

  await logActivity("product_updated", "product", id, { fields: Object.keys(patch) });

  const product = await getProductWithRelations(id);
  return NextResponse.json({ product });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logActivity("product_deleted", "product", id);
  return NextResponse.json({ ok: true });
}
