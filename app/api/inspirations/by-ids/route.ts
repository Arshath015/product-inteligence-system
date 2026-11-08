import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { missingProjectIdResponse } from "@/lib/http";

export async function GET(req: NextRequest) {
  const ids = req.nextUrl.searchParams.get("ids");
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return missingProjectIdResponse();
  if (!ids) return NextResponse.json({ inspirations: [] });
  const idList = ids.split(",").filter(Boolean);
  if (idList.length === 0) return NextResponse.json({ inspirations: [] });

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("inspirations")
    .select("*")
    .eq("project_id", projectId)
    .in("id", idList);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ordered = idList.map((id) => data?.find((i: { id: string }) => i.id === id)).filter(Boolean);
  return NextResponse.json({ inspirations: ordered });
}
