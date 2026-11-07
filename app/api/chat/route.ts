import { NextRequest, NextResponse } from "next/server";
import { generateText, isStepCount } from "ai";
import { withGroqRetry } from "@/lib/groq/client";
import { buildChatTools, type ToolCtx } from "@/lib/chat/tools";
import {
  getLastShownProductIds,
  getOrCreateConversation,
  getPreferences,
  getRecentMessages,
  getSummary,
  maybeSummarizeConversation,
  saveMessage,
  updateLastShownProducts,
} from "@/lib/chat/memory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const SYSTEM_PROMPT = `You are ALTOSSA, a luxury interior-design research assistant with direct access to a product catalogue.

Style: short, confident, concise replies. No long explanations, no unnecessary confirmations, no filler. Talk like a knowledgeable design consultant, not a chatbot.

Behavior:
- If the user's message contains a URL, call ingest_url on it immediately — do not ask for permission first. Report the short result afterward.
- If asked to find/research products, call search_catalog first. Only call web_research if the catalogue doesn't have enough. Don't import every result you find — only ingest_url the specific products worth adding, and say so briefly.
- Only call ingest_url on an individual product detail page (one that names and shows a single specific item). NEVER call ingest_url on a category/collection/listing page, a brand homepage, or a search-results page (URLs like "/sofas", "/categories/...", "/design/living", "/products.html" are listings, not a product) — a listing page has no single reliable name+image pairing and will pollute the catalogue. If web_research only turns up listing pages, either run a more specific web_research query (brand + the specific model name you saw) to find the actual product page, or just describe the findings in text without ingesting anything.
- If given a brand's website, use web_research to understand the brand and find a few notable individual products; ingest_url only specific product pages among them, not the entire catalogue.
- After research/ingestion, briefly name what you did (e.g. which products you added vs. which you only found) — never just say "Done."
- When the user refers to earlier products ("the second one", "more like that"), use the "Previously shown products" list below to resolve the reference — don't ask them to repeat themselves.
- Use remember_preference when the client states a durable preference (favorite brand, style, budget).
- Never invent product data — only state what tools returned.`;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const message = body?.message;
  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const conversation = await getOrCreateConversation(body?.conversationId);
  if (!conversation) {
    return NextResponse.json({ error: "Could not open conversation" }, { status: 500 });
  }

  const [recent, summary, prefs, lastShownIds] = await Promise.all([
    getRecentMessages(conversation.id as string),
    getSummary(conversation.id as string),
    getPreferences(),
    getLastShownProductIds(conversation.id as string),
  ]);

  let lastShownLine = "";
  if (lastShownIds.length > 0) {
    const supabase = getSupabaseAdmin();
    const { data: shown } = await supabase
      .from("products")
      .select("id,name,brand:brands(name)")
      .in("id", lastShownIds);
    if (shown && shown.length > 0) {
      const ordered = lastShownIds
        .map((id) => shown.find((s) => s.id === id))
        .filter(Boolean) as typeof shown;
      lastShownLine = `\n\nPreviously shown products, in order:\n${ordered
        .map((p, i) => {
          const row = p as unknown as { id: string; name: string; brand: { name: string }[] | { name: string } | null };
          const brandName = Array.isArray(row.brand) ? row.brand[0]?.name : row.brand?.name;
          return `${i + 1}. ${row.name}${brandName ? ` by ${brandName}` : ""} (id: ${row.id})`;
        })
        .join("\n")}`;
    }
  }

  const prefsLine =
    Object.keys(prefs).length > 0
      ? `\n\nKnown client preferences:\n${Object.entries(prefs)
          .map(([k, v]) => `- ${k}: ${v}`)
          .join("\n")}`
      : "";

  const summaryLine = summary ? `\n\nConversation summary so far:\n${summary}` : "";

  const system = `${SYSTEM_PROMPT}${summaryLine}${prefsLine}${lastShownLine}`;

  const history = recent.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  await saveMessage(conversation.id as string, "user", message);

  const ctx: ToolCtx = { shownProducts: [] };

  let text = "Sorry, something went wrong on my end.";
  try {
    const result = await withGroqRetry((model) =>
      generateText({
        model,
        system,
        messages: [...history, { role: "user", content: message }],
        tools: buildChatTools(ctx),
        stopWhen: isStepCount(9),
      })
    );
    text = result.text?.trim() || "";
    if (!text) {
      text = ctx.shownProducts.length
        ? `Found: ${ctx.shownProducts.map((p) => p.name).join(", ")}.`
        : "No results for that.";
    }
  } catch (err) {
    text = `I hit an error: ${(err as Error).message.slice(0, 200)}`;
  }

  const productIds = ctx.shownProducts.map((p) => p.id);
  await saveMessage(conversation.id as string, "assistant", text, productIds);
  if (productIds.length > 0) {
    await updateLastShownProducts(conversation.id as string, productIds);
  }
  await maybeSummarizeConversation(conversation.id as string).catch(() => {});

  return NextResponse.json({
    conversationId: conversation.id,
    reply: text,
    products: ctx.shownProducts.slice(0, 8),
  });
}
