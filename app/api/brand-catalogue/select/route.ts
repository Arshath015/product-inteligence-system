import { NextRequest, NextResponse } from "next/server";
import { selectCatalogueProducts } from "@/lib/bulk/brandCatalogueService";
import { missingProjectIdResponse } from "@/lib/http";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.projectId || typeof body.projectId !== "string") {
    return missingProjectIdResponse();
  }
  const ids: string[] = Array.isArray(body.productIds) ? body.productIds : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "No product IDs provided" }, { status: 400 });
  }

  const result = await selectCatalogueProducts(body.projectId, ids);
  return NextResponse.json(result);
}
