import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getProductWithRelations, listProducts, logActivity } from "@/lib/products";
import { resolveBrand, resolveDesigner, resolveCategory, ensureProductVisible } from "@/lib/catalog";
import { storeBestProductImage } from "@/lib/images";
import { slugify } from "@/lib/slug";
import { missingProjectIdResponse } from "@/lib/http";
import { nanoid } from "nanoid";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const projectId = sp.get("projectId");
  if (!projectId) return missingProjectIdResponse();

  try {
    const { products, total } = await listProducts({
      projectId,
      q: sp.get("q") ?? undefined,
      categorySlug: sp.get("category") ?? undefined,
      brandSlug: sp.get("brand") ?? undefined,
      status: sp.get("status") ?? undefined,
      limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
      offset: sp.get("offset") ? Number(sp.get("offset")) : undefined,
      sort: (sp.get("sort") as "newest" | "name") ?? undefined,
    });
    return NextResponse.json({ products, total });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.projectId) return missingProjectIdResponse();
  if (!body?.name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const projectId = body.projectId as string;

  const supabase = getSupabaseAdmin();
  const [brandId, designerId, categoryId] = await Promise.all([
    resolveBrand(projectId, body.brandName ?? null, body.brandWebsiteUrl ?? null),
    resolveDesigner(body.designerName ?? null),
    resolveCategory(body.categorySlug ?? null),
  ]);

  const base = slugify(`${body.brandName ?? ""} ${body.name}`) || "product";
  const { data: existingSlug } = await supabase
    .from("products")
    .select("id")
    .eq("project_id", projectId)
    .eq("slug", base)
    .maybeSingle();
  const slug = existingSlug ? `${base}-${nanoid(6)}` : base;

  const { data: created, error } = await supabase
    .from("products")
    .insert({
      project_id: projectId,
      name: body.name,
      slug,
      brand_id: brandId,
      designer_id: designerId,
      category_id: categoryId,
      description: body.description ?? null,
      materials: body.materials ?? null,
      dimensions: body.dimensions ?? null,
      price_text: body.priceText ?? null,
      source_url: body.sourceUrl ?? null,
      canonical_url: body.sourceUrl ?? null,
      status: "published",
      extraction_status: "complete",
    })
    .select("id")
    .single();

  if (error || !created) {
    return NextResponse.json({ error: error?.message ?? "Failed to create product" }, { status: 500 });
  }

  await ensureProductVisible(projectId, created.id as string);

  if (body.imageUrl) {
    await storeBestProductImage(created.id, [body.imageUrl], true);
  }

  await logActivity("product_created_manual", "product", created.id, { project_id: projectId });

  const product = await getProductWithRelations(created.id);
  return NextResponse.json({ product }, { status: 201 });
}
