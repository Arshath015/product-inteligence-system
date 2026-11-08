import { NextRequest, NextResponse } from "next/server";
import { recoverProductImage } from "@/lib/imageRecovery";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { missingProjectIdResponse } from "@/lib/http";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const projectId = body?.projectId ?? req.nextUrl.searchParams.get("projectId");
  if (!projectId) return missingProjectIdResponse();

  const supabase = getSupabaseAdmin();
  const { data: product } = await supabase.from("products").select("project_id").eq("id", id).maybeSingle();
  if (!product) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (product.project_id !== projectId) {
    return NextResponse.json({ error: "This product belongs to another project." }, { status: 403 });
  }

  const result = await recoverProductImage(id);
  return NextResponse.json(result);
}
