import { generateObject, generateText } from "ai";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { withGroqRetry } from "@/lib/groq/client";
import type { ChatMessage } from "@/lib/types";

const RAW_HISTORY_LIMIT = 10;
const SUMMARIZE_AFTER_MESSAGES = 24;

/**
 * Returns the conversation for this project — creating a new one if no id
 * was given, or if the given id doesn't belong to this project (this is
 * the isolation boundary: a conversationId leaking from another project
 * can never be resumed here, it just silently starts a fresh one).
 */
export async function getOrCreateConversation(projectId: string, conversationId?: string | null) {
  const supabase = getSupabaseAdmin();

  if (conversationId) {
    const { data } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", conversationId)
      .eq("project_id", projectId)
      .maybeSingle();
    if (data) return data;
  }

  const { data: created } = await supabase
    .from("conversations")
    .insert({ project_id: projectId })
    .select("*")
    .single();
  return created;
}

export async function listConversations(projectId: string, opts: { q?: string; status?: string } = {}) {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("conversations")
    .select("*")
    .eq("project_id", projectId)
    .eq("status", opts.status ?? "active");
  if (opts.q) query = query.ilike("title", `%${opts.q}%`);
  query = query.order("updated_at", { ascending: false }).limit(100);
  const { data } = await query;
  return data ?? [];
}

/** Short, deterministic title from the client's first message — no LLM call needed. */
export function generateTitleFromMessage(message: string): string {
  const clean = message.trim().replace(/\s+/g, " ");
  if (/^https?:\/\//i.test(clean)) {
    try {
      const host = new URL(clean.split(/\s+/)[0]).hostname.replace(/^www\./, "");
      return `${host} link`;
    } catch {
      return "Shared link";
    }
  }
  if (clean.length <= 48) return clean;
  return `${clean.slice(0, 45).trimEnd()}…`;
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

export async function getRecentMemoryItems(
  projectId: string,
  limit = 8
): Promise<{ category: string; content: string }[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("memory_items")
    .select("category,content")
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function getPreferences(projectId: string): Promise<Record<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("assistant_memory").select("key,value").eq("project_id", projectId);
  const map: Record<string, string> = {};
  for (const row of data ?? []) map[row.key as string] = row.value as string;
  return map;
}

export async function saveMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  referencedProductIds: string[] = [],
  referencedInspirationIds: string[] = []
) {
  const supabase = getSupabaseAdmin();
  await supabase.from("messages").insert({
    conversation_id: conversationId,
    role,
    content,
    referenced_product_ids: referencedProductIds,
    referenced_inspiration_ids: referencedInspirationIds,
  });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (role === "user") {
    const { data: convo } = await supabase
      .from("conversations")
      .select("title")
      .eq("id", conversationId)
      .maybeSingle();
    if (convo && !convo.title) patch.title = generateTitleFromMessage(content);
  }
  await supabase.from("conversations").update(patch).eq("id", conversationId);
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

const MEMORY_CATEGORIES = ["brand_preference", "style", "material", "budget", "designer_preference", "general"] as const;

const memoryExtractionSchema = z.object({
  facts: z
    .array(
      z.object({
        category: z.enum(MEMORY_CATEGORIES),
        content: z.string().describe("One short, self-contained fact, e.g. 'Prefers walnut over oak finishes'"),
      })
    )
    .describe("Durable client preferences explicitly stated in the transcript. Empty array if none."),
});

/**
 * Extracts durable client-preference facts from a transcript chunk into
 * `memory_items`, scoped to the project the conversation belongs to. Only
 * called once per chunk (from `maybeSummarizeConversation` below), so it
 * never re-processes the same messages twice.
 */
async function extractMemoriesFromTranscript(projectId: string, conversationId: string, transcript: string) {
  const { object } = await withGroqRetry((model) =>
    generateObject({
      model,
      schema: memoryExtractionSchema,
      prompt: `Extract durable client preferences from this transcript of a luxury furniture/design conversation — things like favorite brands, styles, materials, budget range, or designers the CLIENT explicitly stated. Do not infer or guess anything not clearly said. If nothing durable was stated, return an empty array.\n\nTranscript:\n${transcript}`,
    })
  );
  if (object.facts.length === 0) return;

  const supabase = getSupabaseAdmin();
  await supabase.from("memory_items").insert(
    object.facts.map((f) => ({
      project_id: projectId,
      category: f.category,
      content: f.content,
      confidence: "inferred" as const,
      source_conversation_id: conversationId,
    }))
  );
}

/**
 * Keeps the context window bounded: once a conversation accumulates enough
 * turns, roll everything older than the last few messages into a short
 * summary instead of sending it all raw to the model forever. Tracks
 * `summarized_through_message_id` so each run only processes messages it
 * hasn't seen yet — both for the summary itself and for memory extraction.
 */
export async function maybeSummarizeConversation(projectId: string, conversationId: string) {
  const supabase = getSupabaseAdmin();
  const { count } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId);

  if (!count || count < SUMMARIZE_AFTER_MESSAGES) return;

  const { data: summaryRow } = await supabase
    .from("conversation_summaries")
    .select("summary, summarized_through_message_id")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  let query = supabase
    .from("messages")
    .select("id,role,content,created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (summaryRow?.summarized_through_message_id) {
    const { data: marker } = await supabase
      .from("messages")
      .select("created_at")
      .eq("id", summaryRow.summarized_through_message_id)
      .maybeSingle();
    if (marker) query = query.gt("created_at", marker.created_at);
  }

  const { data: unsummarized } = await query;
  if (!unsummarized) return;

  const toSummarize = unsummarized.slice(0, Math.max(0, unsummarized.length - RAW_HISTORY_LIMIT));
  if (toSummarize.length === 0) return;

  const existingSummary = summaryRow?.summary ?? "";
  const transcript = toSummarize.map((m) => `${m.role}: ${m.content}`).join("\n");

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
      summarized_through_message_id: toSummarize[toSummarize.length - 1].id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "conversation_id" }
  );

  await extractMemoriesFromTranscript(projectId, conversationId, transcript).catch(() => {});
}

export interface MemorySearchResult {
  conversations: { conversationId: string; title: string | null; summary: string; similarity: number }[];
  facts: { category: string; content: string; similarity: number }[];
}

/**
 * Cross-conversation retrieval, invoked by the `recall_memory` chat tool —
 * scoped to the active project and deliberately NOT always-on, so neither
 * another project's data nor unrelated past conversations within this
 * project bleed into the current one unless the model decides it's
 * actually relevant.
 */
export async function searchMemory(
  projectId: string,
  query: string,
  excludeConversationId?: string | null
): Promise<MemorySearchResult> {
  const supabase = getSupabaseAdmin();
  const [{ data: conversations }, { data: facts }] = await Promise.all([
    supabase.rpc("search_conversation_summaries", {
      p_project_id: projectId,
      p_query: query,
      p_exclude_id: excludeConversationId ?? null,
    }),
    supabase.rpc("search_memory_items", { p_project_id: projectId, p_query: query }),
  ]);

  type SummaryRow = { conversation_id: string; title: string | null; summary: string; similarity: number };
  type FactRow = { category: string; content: string; similarity: number };

  return {
    conversations: ((conversations ?? []) as SummaryRow[]).map((c) => ({
      conversationId: c.conversation_id,
      title: c.title,
      summary: c.summary,
      similarity: c.similarity,
    })),
    facts: ((facts ?? []) as FactRow[]).map((f) => ({
      category: f.category,
      content: f.content,
      similarity: f.similarity,
    })),
  };
}
