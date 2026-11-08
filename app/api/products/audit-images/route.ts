import { NextRequest, NextResponse } from "next/server";
import { auditProductImages, recoverSuspectImages } from "@/lib/imageRecovery";
import { missingProjectIdResponse } from "@/lib/http";

/** Read-only report of stored primary images that look mis-selected (e.g. a newsletter popup, not the product). */
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return missingProjectIdResponse();
  const suspects = await auditProductImages(projectId);
  return NextResponse.json({ suspects });
}

/** Re-runs recovery for every flagged product — the only path that overwrites an already-"stored" image. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const projectId = body?.projectId;
  if (!projectId) return missingProjectIdResponse();
  const results = await recoverSuspectImages(projectId);
  return NextResponse.json({ results });
}
