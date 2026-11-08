import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { listConversations } from "@/lib/chat/memory";
import { missingProjectIdResponse } from "@/lib/http";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const projectId = sp.get("projectId");
  if (!projectId) return missingProjectIdResponse();
  const conversations = await listConversations(projectId, {
    q: sp.get("q") ?? undefined,
    status: sp.get("status") ?? undefined,
  });
  return NextResponse.json({ conversations });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!body?.projectId) return missingProjectIdResponse();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("conversations")
    .insert({ project_id: body.projectId })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ conversation: data }, { status: 201 });
}
