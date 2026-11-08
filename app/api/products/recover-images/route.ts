import { NextResponse } from "next/server";
import { recoverAllMissingImages } from "@/lib/imageRecovery";

export async function POST() {
  const results = await recoverAllMissingImages();
  return NextResponse.json({ results });
}
