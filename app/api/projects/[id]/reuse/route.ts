import { NextRequest, NextResponse } from "next/server";
import {
  reuseFromProject,
  removeBrandReference,
  removeProductReference,
  removeInspirationReference,
} from "@/lib/projects";

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
    allInspirations: Boolean(body.allInspirations),
    productIds: Array.isArray(body.productIds) ? body.productIds : undefined,
    brandIds: Array.isArray(body.brandIds) ? body.brandIds : undefined,
    inspirationIds: Array.isArray(body.inspirationIds) ? body.inspirationIds : undefined,
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
  } else if (body?.inspirationId) {
    await removeInspirationReference(id, body.inspirationId);
  } else {
    return NextResponse.json({ error: "productId, brandId, or inspirationId is required" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
