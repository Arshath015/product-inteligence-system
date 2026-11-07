import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { slugify } from "@/lib/slug";
import { logActivity } from "@/lib/products";

export async function GET(req: NextRequest) {
  const supabase = getSupabaseAdmin();
  const q = req.nextUrl.searchParams.get("q")?.trim();

  let query = supabase.from("brands_with_counts").select("*").eq("status", "active");
  if (q) query = query.ilike("name", `%${q}%`);
  query = query.order("name", { ascending: true });

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ brands: data });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const slug = slugify(body.name);
  const { data, error } = await supabase
    .from("brands")
    .insert({
      name: body.name,
      slug,
      website_url: body.websiteUrl ?? null,
      description: body.description ?? null,
      country: body.country ?? null,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logActivity("brand_created_manual", "brand", data.id as string);
  return NextResponse.json({ brand: data }, { status: 201 });
}
