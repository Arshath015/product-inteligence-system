import { NextRequest, NextResponse } from "next/server";
import { getLibraryProducts } from "@/lib/library";

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams;
  try {
    const result = await getLibraryProducts({
      q: search.get("q") ?? undefined,
      brand: search.get("brand") ?? undefined,
      category: search.get("category") ?? undefined,
      limit: search.has("limit") ? Number(search.get("limit")) : undefined,
      offset: search.has("offset") ? Number(search.get("offset")) : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
