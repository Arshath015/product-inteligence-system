import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getProductWithRelations, logActivity } from "@/lib/products";
import { resolveBrand, resolveDesigner, resolveCategory } from "@/lib/catalog";
import { storeBestProductImage } from "@/lib/images";
import { missingProjectIdResponse } from "@/lib/http";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return missingProjectIdResponse();

  const product = await getProductWithRelations(id, projectId);
  if (!product) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ product });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body?.projectId) return missingProjectIdResponse();
  const projectId = body.projectId as string;

  const supabase = getSupabaseAdmin();
  const { data: existing } = await supabase.from("products").select("project_id").eq("id", id).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.project_id !== projectId) {
    return NextResponse.json(
      { error: "This product is referenced from another project — it can only be edited from its owning project." },
      { status: 403 }
    );
  }

  const patch: Record<string, unknown> = {};
  for (const field of ["name", "description", "materials", "dimensions", "status"] as const) {
    if (body[field] !== undefined) patch[field] = body[field];
  }
  if (body.priceText !== undefined) patch.price_text = body.priceText;
  if (body.sourceUrl !== undefined) patch.source_url = body.sourceUrl;
  if (body.brandName !== undefined) patch.brand_id = await resolveBrand(projectId, body.brandName);
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

  await logActivity("product_updated", "product", id, { project_id: projectId, fields: Object.keys(patch) });

  const product = await getProductWithRelations(id);
  return NextResponse.json({ product });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return missingProjectIdResponse();

  const supabase = getSupabaseAdmin();
  const { data: product } = await supabase.from("products").select("project_id").eq("id", id).maybeSingle();
  if (!product) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (product.project_id !== projectId) {
    // Not owned here — this is just a reference. Remove the link only,
    // never the source product in its owning project.
    await supabase.from("project_products").delete().eq("project_id", projectId).eq("product_id", id);
    await logActivity("product_reference_removed", "product", id, { project_id: projectId });
    return NextResponse.json({ ok: true, removedReferenceOnly: true });
  }

  const { data: externalRefs } = await supabase
    .from("project_products")
    .select("project_id")
    .eq("product_id", id)
    .neq("project_id", projectId);
  if (externalRefs && externalRefs.length > 0) {
    return NextResponse.json(
      {
        error: `This product is referenced by ${externalRefs.length} other project(s) — remove those references first, or deleting it would break their catalogues.`,
      },
      { status: 409 }
    );
  }

  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logActivity("product_deleted", "product", id, { project_id: projectId });
  return NextResponse.json({ ok: true });
}
