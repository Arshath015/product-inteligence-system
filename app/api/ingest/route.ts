import { NextRequest, NextResponse } from "next/server";
import { ingestProductUrl } from "@/lib/ingest";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const url = body?.url;
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }
  try {
    new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  const result = await ingestProductUrl(url);
  return NextResponse.json(result);
}
