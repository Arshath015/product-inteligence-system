import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { PRODUCT_SELECT_WITH_RELATIONS } from "@/lib/products";

export async function GET(req: NextRequest) {
  const ids = req.nextUrl.searchParams.get("ids");
  if (!ids) return NextResponse.json({ products: [] });
  const idList = ids.split(",").filter(Boolean);
  if (idList.length === 0) return NextResponse.json({ products: [] });

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_SELECT_WITH_RELATIONS)
    .in("id", idList);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ordered = idList.map((id) => data?.find((p: { id: string }) => p.id === id)).filter(Boolean);
  return NextResponse.json({ products: ordered });
}
