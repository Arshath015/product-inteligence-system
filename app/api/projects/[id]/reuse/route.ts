import { NextRequest, NextResponse } from "next/server";
import { reuseFromProject, removeBrandReference, removeProductReference } from "@/lib/projects";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body?.sourceProjectId) {
    return NextResponse.json({ error: "sourceProjectId is required" }, { status: 400 });
  }

  const result = await reuseFromProject(id, {
    sourceProjectId: body.sourceProjectId,
    allProducts: Boolean(body.allProducts),
    allBrands: Boolean(body.allBrands),
    productIds: Array.isArray(body.productIds) ? body.productIds : undefined,
    brandIds: Array.isArray(body.brandIds) ? body.brandIds : undefined,
  });

  return NextResponse.json(result);
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (body?.productId) {
    await removeProductReference(id, body.productId);
  } else if (body?.brandId) {
    await removeBrandReference(id, body.brandId);
  } else {
    return NextResponse.json({ error: "productId or brandId is required" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
