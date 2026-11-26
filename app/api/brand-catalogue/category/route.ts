import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { slugify } from "@/lib/slug";
import { guessCategorySlug } from "@/lib/productCategory";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  const productIds = Array.isArray(body?.productIds)
    ? [...new Set(body.productIds.filter((id: unknown): id is string => typeof id === "string"))]
    : [];
  const categoryName = typeof body?.categoryName === "string" ? body.categoryName.trim() : "";

  if (!projectId) return NextResponse.json({ error: "Missing projectId." }, { status: 400 });
  if (productIds.length === 0 || productIds.length > 500) {
    return NextResponse.json({ error: "Select between 1 and 500 products." }, { status: 400 });
  }
  if (!categoryName || categoryName.length > 80) {
    return NextResponse.json({ error: "Enter a category name between 1 and 80 characters." }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data: brands, error: brandsError } = await supabase
    .from("brands")
    .select("id")
    .eq("project_id", projectId);
  if (brandsError) return NextResponse.json({ error: brandsError.message }, { status: 500 });
  const brandIds = (brands ?? []).map((brand) => brand.id as string);
  if (brandIds.length === 0) return NextResponse.json({ error: "No catalogue brands belong to this project." }, { status: 404 });

  const { data: products, error: productsError } = await supabase
    .from("brand_catalogue_products")
    .select("id")
    .in("id", productIds)
    .in("brand_id", brandIds);
  if (productsError) return NextResponse.json({ error: productsError.message }, { status: 500 });
  if ((products ?? []).length !== productIds.length) {
    return NextResponse.json({ error: "Some selected products do not belong to this project." }, { status: 404 });
  }

  const { data: categories, error: categoriesError } = await supabase
    .from("categories")
    .select("id, slug, name");
  if (categoriesError) return NextResponse.json({ error: categoriesError.message }, { status: 500 });
  const categorySlug = guessCategorySlug(categoryName) === "other"
    ? slugify(categoryName)
    : guessCategorySlug(categoryName);
  const matchedCategory = (categories ?? []).find((category) =>
    category.slug === categorySlug || (category.name as string).toLowerCase() === categoryName.toLowerCase()
  );
  const categoryId = (matchedCategory?.id as string | undefined) ?? null;

  const { data: updated, error: updateError } = await supabase
    .from("brand_catalogue_products")
    .update({ category_name: categoryName, category_id: categoryId })
    .in("id", productIds)
    .in("brand_id", brandIds)
    .select("id");
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({
    updated: updated?.length ?? 0,
    categoryName,
    categoryId,
  });
}
