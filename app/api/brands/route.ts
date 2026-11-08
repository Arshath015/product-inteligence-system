import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { slugify } from "@/lib/slug";
import { logActivity } from "@/lib/products";
import { missingProjectIdResponse } from "@/lib/http";

export async function GET(req: NextRequest) {
  const supabase = getSupabaseAdmin();
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return missingProjectIdResponse();
  const q = req.nextUrl.searchParams.get("q")?.trim();

  let query = supabase.rpc("brands_with_counts_for_project", { p_project_id: projectId });
  if (q) query = query.ilike("name", `%${q}%`);
  query = query.order("name", { ascending: true });

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ brands: data });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.projectId) return missingProjectIdResponse();
  if (!body?.name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const projectId = body.projectId as string;

  const supabase = getSupabaseAdmin();
  const slug = slugify(body.name);
  const { data, error } = await supabase
    .from("brands")
    .insert({
      project_id: projectId,
      name: body.name,
      slug,
      website_url: body.websiteUrl ?? null,
      description: body.description ?? null,
      country: body.country ?? null,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase
    .from("project_brands")
    .upsert({ project_id: projectId, brand_id: data.id }, { onConflict: "project_id,brand_id", ignoreDuplicates: true });

  await logActivity("brand_created_manual", "brand", data.id as string, { project_id: projectId });
  return NextResponse.json({ brand: data }, { status: 201 });
}
