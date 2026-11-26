import { NextRequest, NextResponse } from "next/server";
import { buildCatalogueReconciliationPreview, type ReconciliationProduct } from "@/lib/bulk/catalogueReconciliation";
import { categoryFromProductUrl } from "@/lib/productCategory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function migrationRequiredResponse(message: string) {
  if (/apply_brand_catalogue_reconciliation|function .* does not exist|could not find the function/i.test(message)) {
    return NextResponse.json({
      error: "Apply Supabase migration 0010_brand_catalogue_duplicate_archive.sql before applying catalogue corrections.",
    }, { status: 503 });
  }
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const action = body?.action;
  const projectId = body?.projectId;
  const brandId = body?.brandId;

  if (!isUuid(projectId) || !isUuid(brandId)) {
    return NextResponse.json({ error: "A valid projectId and brandId are required." }, { status: 400 });
  }
  if (action !== "preview" && action !== "apply" && action !== "restore") {
    return NextResponse.json({ error: "Choose preview, apply, or restore." }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data: brand, error: brandError } = await supabase
    .from("brands")
    .select("id, name")
    .eq("id", brandId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (brandError) return NextResponse.json({ error: brandError.message }, { status: 500 });
  if (!brand) return NextResponse.json({ error: "Brand does not belong to this project." }, { status: 404 });

  const { data: rows, error: productsError } = await supabase
    .from("brand_catalogue_products")
    .select("*")
    .eq("brand_id", brandId)
    .order("name");
  if (productsError) return NextResponse.json({ error: productsError.message }, { status: 500 });

  const products = (rows ?? []) as ReconciliationProduct[];
  if (action === "preview") {
    const preview = buildCatalogueReconciliationPreview(products, categoryFromProductUrl);
    return NextResponse.json({
      brandId,
      brandName: brand.name,
      ...preview,
      archivedDuplicates: products.filter((product) => product.duplicate_of_id),
    });
  }

  if (action === "restore") {
    const productIds: unknown[] = Array.isArray(body?.productIds) ? body.productIds : [];
    if (productIds.length === 0 || productIds.length > 500 || !productIds.every(isUuid)
      || new Set(productIds).size !== productIds.length) {
      return NextResponse.json({ error: "Select between 1 and 500 valid archived product IDs." }, { status: 400 });
    }

    const archivedIds = new Set(products
      .filter((product) => product.duplicate_of_id)
      .map((product) => product.id));
    if (productIds.some((id) => !archivedIds.has(id))) {
      return NextResponse.json({ error: "Some selected products are not archived duplicates in this brand." }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("apply_brand_catalogue_reconciliation", {
      p_project_id: projectId,
      p_category_changes: [],
      p_duplicate_links: [],
      p_restore_ids: productIds,
    });
    if (error) return migrationRequiredResponse(error.message);
    return NextResponse.json(data);
  }

  if (body?.confirmed !== true) {
    return NextResponse.json({ error: "Review the proposed changes and confirm before applying them." }, { status: 400 });
  }

  const preview = buildCatalogueReconciliationPreview(products, categoryFromProductUrl);
  const requestedCategoryChanges: unknown[] = Array.isArray(body?.categoryChanges) ? body.categoryChanges : [];
  const requestedDuplicateLinks: unknown[] = Array.isArray(body?.duplicateLinks) ? body.duplicateLinks : [];
  if (requestedCategoryChanges.length > 500 || requestedDuplicateLinks.length > 500) {
    return NextResponse.json({ error: "A reconciliation may include at most 500 changes." }, { status: 400 });
  }
  if (requestedCategoryChanges.length === 0 && requestedDuplicateLinks.length === 0) {
    return NextResponse.json({ error: "Select at least one correction to apply." }, { status: 400 });
  }

  const allowedCorrections = new Map(preview.categoryCorrections.map((correction) => [
    correction.id,
    correction.proposedCategory,
  ]));
  const categoryChanges: Array<{ id: string; category_name: string; category_id: string | null }> = [];
  const categoryChangeIds = new Set<string>();
  for (const change of requestedCategoryChanges) {
    if (!change || typeof change !== "object" || !("id" in change) || !("proposedCategory" in change)) {
      return NextResponse.json({ error: "Invalid category correction in the request." }, { status: 400 });
    }
    const id = change.id;
    const proposedCategory = change.proposedCategory;
    if (!isUuid(id) || typeof proposedCategory !== "string" || allowedCorrections.get(id) !== proposedCategory
      || categoryChangeIds.has(id)) {
      return NextResponse.json({ error: "A category correction is stale or was not in the preview." }, { status: 400 });
    }
    categoryChangeIds.add(id);
    categoryChanges.push({ id, category_name: proposedCategory, category_id: null });
  }

  const allowedDuplicateIds = new Set(preview.duplicateCandidates.flatMap((candidate) => candidate.productIds));
  const duplicateIds = new Set<string>();
  const canonicalIds = new Set<string>();
  const duplicateLinks: Array<{ duplicate_id: string; canonical_id: string }> = [];
  for (const link of requestedDuplicateLinks) {
    if (!link || typeof link !== "object" || !("duplicateId" in link) || !("canonicalId" in link)) {
      return NextResponse.json({ error: "Invalid duplicate selection in the request." }, { status: 400 });
    }
    const duplicateId = link.duplicateId;
    const canonicalId = link.canonicalId;
    const sameCandidate = preview.duplicateCandidates.some((candidate) =>
      candidate.productIds.includes(duplicateId as string) && candidate.productIds.includes(canonicalId as string)
    );
    if (!isUuid(duplicateId) || !isUuid(canonicalId) || duplicateId === canonicalId
      || !allowedDuplicateIds.has(duplicateId) || !sameCandidate || duplicateIds.has(duplicateId)) {
      return NextResponse.json({ error: "A duplicate selection is stale or was not in the preview." }, { status: 400 });
    }
    duplicateIds.add(duplicateId);
    canonicalIds.add(canonicalId);
    duplicateLinks.push({ duplicate_id: duplicateId, canonical_id: canonicalId });
  }
  if ([...duplicateIds].some((id) => canonicalIds.has(id))) {
    return NextResponse.json({ error: "A product cannot be both archived and selected as the kept record." }, { status: 400 });
  }

  if (categoryChanges.length > 0) {
    const categorySlugs = [...new Set(categoryChanges.map((change) => change.category_name))];
    const { data: categories, error: categoriesError } = await supabase
      .from("categories")
      .select("id, slug")
      .in("slug", categorySlugs);
    if (categoriesError) return NextResponse.json({ error: categoriesError.message }, { status: 500 });
    const categoryIds = new Map((categories ?? []).map((category) => [category.slug as string, category.id as string]));
    for (const change of categoryChanges) {
      change.category_id = categoryIds.get(change.category_name) ?? null;
    }
  }

  const { data, error } = await supabase.rpc("apply_brand_catalogue_reconciliation", {
    p_project_id: projectId,
    p_category_changes: categoryChanges,
    p_duplicate_links: duplicateLinks,
    p_restore_ids: [],
  });
  if (error) return migrationRequiredResponse(error.message);
  return NextResponse.json({
    ...(data && typeof data === "object" ? data : {}),
    categoryChanges,
    duplicateLinks,
  });
}
