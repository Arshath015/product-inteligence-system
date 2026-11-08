import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { saveInspirationUrl } from "@/lib/inspiration";
import { missingProjectIdResponse } from "@/lib/http";
import { getVisibleInspirationIds } from "@/lib/inspirationVisibility";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const projectId = sp.get("projectId");
  if (!projectId) return missingProjectIdResponse();
  const q = sp.get("q")?.trim();
  const platform = sp.get("platform")?.trim();
  const excludePlatform = sp.get("excludePlatform")?.trim();
  const tag = sp.get("tag")?.trim();
  const limit = Math.min(Number(sp.get("limit") ?? 60), 120);

  const supabase = getSupabaseAdmin();
  const visibleIds = await getVisibleInspirationIds(projectId);
  if (visibleIds.length === 0) return NextResponse.json({ inspirations: [], total: 0 });

  let query = supabase
    .from("inspirations")
    .select("*", { count: "exact" })
    .in("id", visibleIds)
    .eq("status", "active");

  if (platform) query = query.eq("platform", platform);
  if (excludePlatform) query = query.neq("platform", excludePlatform);
  if (tag) query = query.contains("tags", [tag]);
  if (q) query = query.or(`title.ilike.%${q}%,description.ilike.%${q}%,caption.ilike.%${q}%`);

  query = query.order("created_at", { ascending: false }).limit(limit);

  const { data, count, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const inspirations = (data ?? []).map((i) => ({ ...i, is_owner: i.project_id === projectId }));
  return NextResponse.json({ inspirations, total: count ?? 0 });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.projectId) return missingProjectIdResponse();
  const url = body?.url;
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }
  try {
    new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  const result = await saveInspirationUrl(body.projectId, url);
  return NextResponse.json(result);
}
