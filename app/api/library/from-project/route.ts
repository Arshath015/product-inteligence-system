import { NextRequest, NextResponse } from "next/server";
import { addProjectProductsToLibrary } from "@/lib/projectLibrary";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (typeof body?.projectId !== "string") {
    return NextResponse.json({ error: "Select a project." }, { status: 400 });
  }

  const allProducts = body.allProducts === true;
  if (
    !allProducts &&
    (!Array.isArray(body.productIds) ||
      body.productIds.length === 0 ||
      body.productIds.length > 5000 ||
      !body.productIds.every((id: unknown) => typeof id === "string"))
  ) {
    return NextResponse.json({ error: "Select products to add to the Global Library." }, { status: 400 });
  }

  try {
    const result = await addProjectProductsToLibrary({
      projectId: body.projectId,
      productIds: allProducts ? undefined : body.productIds as string[],
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
