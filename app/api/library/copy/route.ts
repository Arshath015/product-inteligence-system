import { NextRequest, NextResponse } from "next/server";
import { copyProductsIntoProject } from "@/lib/productCopy";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (typeof body?.projectId !== "string" || !Array.isArray(body?.productIds) || body.productIds.length === 0) {
    return NextResponse.json({ error: "Select products and a target project." }, { status: 400 });
  }
  try {
    const result = await copyProductsIntoProject({
      targetProjectId: body.projectId,
      productIds: body.productIds,
      source: { type: "library" },
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
