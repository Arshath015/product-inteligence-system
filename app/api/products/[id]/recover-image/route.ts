import { NextRequest, NextResponse } from "next/server";
import { recoverProductImage } from "@/lib/imageRecovery";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const result = await recoverProductImage(id);
  return NextResponse.json(result);
}
