import { generateText } from "ai";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { withGroqRetry } from "@/lib/groq/client";
import type { ChatMessage } from "@/lib/types";

const RAW_HISTORY_LIMIT = 10;
const SUMMARIZE_AFTER_MESSAGES = 24;

export async function getOrCreateConversation(conversationId?: string | null) {
  const supabase = getSupabaseAdmin();

  if (conversationId) {
    const { data } = await supabase.from("conversations").select("*").eq("id", conversationId).maybeSingle();
    if (data) return data;
  }

  const { data: created } = await supabase.from("conversations").insert({}).select("*").single();
  return created;
}

export async function getRecentMessages(conversationId: string, limit = RAW_HISTORY_LIMIT): Promise<ChatMessage[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data as ChatMessage[]) ?? []).reverse();
}

export async function getSummary(conversationId: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("conversation_summaries")
    .select("summary")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return data?.summary ?? "";
}

export async function getPreferences(): Promise<Record<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("assistant_memory").select("key,value");
  const map: Record<string, string> = {};
  for (const row of data ?? []) map[row.key as string] = row.value as string;
  return map;
}

export async function saveMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  referencedProductIds: string[] = []
) {
  const supabase = getSupabaseAdmin();
  await supabase.from("messages").insert({
    conversation_id: conversationId,
    role,
    content,
    referenced_product_ids: referencedProductIds,
  });
  await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
}

export async function updateLastShownProducts(conversationId: string, productIds: string[]) {
  if (productIds.length === 0) return;
  const supabase = getSupabaseAdmin();
  await supabase.from("conversations").update({ last_shown_product_ids: productIds }).eq("id", conversationId);
}

export async function getLastShownProductIds(conversationId: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("conversations")
    .select("last_shown_product_ids")
    .eq("id", conversationId)
    .maybeSingle();
  return (data?.last_shown_product_ids as string[]) ?? [];
}

/**
 * Keeps the context window bounded: once a conversation accumulates enough
 * turns, roll everything older than the last few messages into a short
 * summary instead of sending it all raw to the model forever.
 */
export async function maybeSummarizeConversation(conversationId: string) {
  const supabase = getSupabaseAdmin();
  const { count } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId);

  if (!count || count < SUMMARIZE_AFTER_MESSAGES) return;

  const { data: older } = await supabase
    .from("messages")
    .select("role,content,created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(count - RAW_HISTORY_LIMIT);

  if (!older || older.length === 0) return;

  const existingSummary = await getSummary(conversationId);
  const transcript = older.map((m) => `${m.role}: ${m.content}`).join("\n");

  const { text } = await withGroqRetry((model) =>
    generateText({
      model,
      prompt: `Update this running summary of a client's conversation with a luxury furniture research assistant. Keep it under 150 words, focused on: products/brands discussed, client preferences, and open threads.\n\nExisting summary:\n${existingSummary || "(none yet)"}\n\nNew messages to fold in:\n${transcript}\n\nReturn only the updated summary text.`,
    })
  );

  await supabase.from("conversation_summaries").upsert(
    {
      conversation_id: conversationId,
      summary: text.trim(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "conversation_id" }
  );
}
