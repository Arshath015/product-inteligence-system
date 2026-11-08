import { NextRequest, NextResponse } from "next/server";
import { recoverAllMissingImages } from "@/lib/imageRecovery";
import { missingProjectIdResponse } from "@/lib/http";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const projectId = body?.projectId;
  if (!projectId) return missingProjectIdResponse();

  const results = await recoverAllMissingImages(projectId);
  return NextResponse.json({ results });
}
