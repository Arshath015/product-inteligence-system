import { NextRequest, NextResponse } from "next/server";
import { extractBrandCatalogue } from "@/lib/bulk/brandCatalogueService";
import type { ExtractProgressEvent } from "@/lib/bulk/brandCatalogueService";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "Missing projectId" }, { status: 400 });

  const supabase = getSupabaseAdmin();

  // All brands owned by this project that have catalogue products
  const { data: brands } = await supabase
    .from("brands")
    .select("id, name")
    .eq("project_id", projectId);

  if (!brands || brands.length === 0) return NextResponse.json({ brands: [] });

  const brandIds = brands.map((b) => b.id as string);

  const { data: products } = await supabase
    .from("brand_catalogue_products")
    .select("*")
    .in("brand_id", brandIds)
    .order("name");

  // Group by brand
  const byBrand: Record<string, { id: string; name: string; products: unknown[] }> = {};
  for (const b of brands) {
    byBrand[b.id as string] = { id: b.id as string, name: b.name as string, products: [] };
  }
  for (const p of products ?? []) {
    byBrand[p.brand_id as string]?.products.push(p);
  }

  const result = Object.values(byBrand).filter((b) => b.products.length > 0);
  return NextResponse.json({ brands: result });
}

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
