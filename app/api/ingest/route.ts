import { NextRequest, NextResponse } from "next/server";
import { ingestProductUrl } from "@/lib/ingest";
import { missingProjectIdResponse } from "@/lib/http";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.projectId || typeof body.projectId !== "string") {
    return missingProjectIdResponse();
  }
  const url = body?.url;
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }
  try {
    new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  const result = await ingestProductUrl(body.projectId, url);
  return NextResponse.json(result);
}
