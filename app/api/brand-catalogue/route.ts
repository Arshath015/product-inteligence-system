import { NextRequest, NextResponse } from "next/server";
import { extractBrandCatalogue } from "@/lib/bulk/brandCatalogueService";
import type { ExtractProgressEvent } from "@/lib/bulk/brandCatalogueService";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const brandUrl = body?.brandUrl as string | undefined;
  const projectId = body?.projectId as string | undefined;
  if (!brandUrl) {
    return NextResponse.json({ error: "Missing brandUrl" }, { status: 400 });
  }
  if (!projectId) {
    return NextResponse.json({ error: "Missing projectId" }, { status: 400 });
  }
  try { new URL(brandUrl); } catch {
    return NextResponse.json({ error: "Invalid brandUrl" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const send = (event: ExtractProgressEvent) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    writer.write(encoder.encode(line)).catch(() => {});
  };

  // Run extraction asynchronously — stream results back via SSE
  extractBrandCatalogue(projectId, brandUrl, send).finally(() => {
    writer.close().catch(() => {});
  });

  return new NextResponse(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
