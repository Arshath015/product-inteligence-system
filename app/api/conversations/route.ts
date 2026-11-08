import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { listConversations } from "@/lib/chat/memory";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const conversations = await listConversations({
    q: sp.get("q") ?? undefined,
    status: sp.get("status") ?? undefined,
  });
  return NextResponse.json({ conversations });
}

export async function POST() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("conversations").insert({}).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ conversation: data }, { status: 201 });
}
