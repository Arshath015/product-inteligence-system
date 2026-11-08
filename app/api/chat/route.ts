import { NextRequest } from "next/server";
import { streamText, isStepCount, type LanguageModel } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { config } from "@/lib/config";
import { getGroqKeyManager, classifyGroqError } from "@/lib/groq/keyManager";
import { buildChatTools, type ToolCtx } from "@/lib/chat/tools";
import {
  getLastShownProductIds,
  getOrCreateConversation,
  getPreferences,
  getRecentMemoryItems,
  getRecentMessages,
  getSummary,
  maybeSummarizeConversation,
  saveMessage,
  updateLastShownProducts,
} from "@/lib/chat/memory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const SYSTEM_PROMPT = `You are ALTOSSA, a luxury interior-design research assistant with direct access to a product catalogue and an Inspiration library.

Style: short, confident, concise replies. No long explanations, no unnecessary confirmations, no filler. Talk like a knowledgeable design consultant, not a chatbot.

Behavior:
- If the user's message contains a URL, call save_link on it immediately — do not ask for permission first, and don't try to guess the platform yourself (save_link detects it). Report the short result afterward.
- save_link routes automatically: product pages go to the catalogue, Pinterest/Instagram links go to the Inspiration library. If extraction was limited (e.g. a platform blocked access), say so briefly — never pretend it fully worked.
- If asked to find/research products, call search_catalog first. Only call web_research if the catalogue doesn't have enough. Don't import every result you find — only save_link the specific products worth adding, and say so briefly.
- Only save a product URL that is an individual product detail page (names and shows a single specific item). NEVER save a category/collection page, a brand homepage, or a search-results page as a product — it has no reliable single name+image pairing. If web_research only turns up listing pages, run a more specific query (brand + model name) or just describe the findings in text without saving anything.
- After research/ingestion, briefly name what you did (e.g. which products/inspiration you added vs. which you only found) — never just say "Done."
- When the user refers to earlier products ("the second one", "more like that"), use the "Previously shown products" list below to resolve the reference — don't ask them to repeat themselves.
- Use remember_preference when the client states a durable preference (favorite brand, style, budget). Use recall_memory when the client references something from an earlier session that isn't already in your context below — don't ask them to repeat information you can look up.
- Never invent product data — only state what tools returned.`;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const message = body?.message;
  if (!message || typeof message !== "string") {
    return new Response(JSON.stringify({ error: "message is required" }), { status: 400 });
  }

  const conversation = await getOrCreateConversation(body?.conversationId);
  if (!conversation) {
    return new Response(JSON.stringify({ error: "Could not open conversation" }), { status: 500 });
  }

  const [recent, summary, prefs, memoryItems, lastShownIds] = await Promise.all([
    getRecentMessages(conversation.id as string),
    getSummary(conversation.id as string),
    getPreferences(),
    getRecentMemoryItems(),
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

  const memoryLine =
    memoryItems.length > 0
      ? `\n\nOther things learned about the client:\n${memoryItems.map((m) => `- ${m.content}`).join("\n")}`
      : "";

  const summaryLine = summary ? `\n\nConversation summary so far:\n${summary}` : "";

  const system = `${SYSTEM_PROMPT}${summaryLine}${prefsLine}${memoryLine}${lastShownLine}`;
  const history = recent.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  await saveMessage(conversation.id as string, "user", message);

  const ctx: ToolCtx = { shownProducts: [], shownInspirations: [], conversationId: conversation.id as string };
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("meta", { conversationId: conversation.id });

      let fullText = "";
      try {
        fullText = await streamWithRetry(system, [...history, { role: "user", content: message }], ctx, (delta) => {
          fullText += delta;
          send("delta", { text: delta });
        });
      } catch (err) {
        fullText = `I hit an error: ${(err as Error).message.slice(0, 200)}`;
        send("delta", { text: fullText });
      }

      fullText = fullText.trim();
      if (!fullText) {
        fullText = ctx.shownProducts.length || ctx.shownInspirations.length
          ? `Found: ${[...ctx.shownProducts.map((p) => p.name), ...ctx.shownInspirations.map((i) => i.title ?? "inspiration")].join(", ")}.`
          : "No results for that.";
        send("delta", { text: fullText });
      }

      const productIds = ctx.shownProducts.map((p) => p.id);
      const inspirationIds = ctx.shownInspirations.map((i) => i.id);
      await saveMessage(conversation.id as string, "assistant", fullText, productIds, inspirationIds);
      if (productIds.length > 0) {
        await updateLastShownProducts(conversation.id as string, productIds);
      }
      await maybeSummarizeConversation(conversation.id as string).catch(() => {});

      send("done", {
        conversationId: conversation.id,
        reply: fullText,
        products: ctx.shownProducts.slice(0, 8),
        inspirations: ctx.shownInspirations.slice(0, 8),
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/**
 * Starts a streaming generation, rotating Groq keys if the connection
 * itself fails (bad/rate-limited key) before any text has reached the
 * client. Once streaming begins, a mid-stream failure just ends the
 * response rather than retrying — nothing has been sent back to retry
 * cleanly, matching how ChatGPT/Claude surface a provider hiccup.
 */
async function streamWithRetry(
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  ctx: ToolCtx,
  onDelta: (text: string) => void
): Promise<string> {
  const manager = getGroqKeyManager();
  const attempts = Math.max(1, Math.min(4, manager.size()));
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    const { key, index } = manager.acquire();
    const provider = createGroq({ apiKey: key });
    const model: LanguageModel = provider(config.groq.textModel);

    const result = streamText({
      model,
      system,
      messages,
      tools: buildChatTools(ctx),
      stopWhen: isStepCount(9),
    });

    const iterator = result.textStream[Symbol.asyncIterator]();
    let first: IteratorResult<string>;
    try {
      first = await iterator.next();
    } catch (err) {
      lastErr = err;
      const kind = classifyGroqError(err);
      manager.reportFailure(index, kind);
      if (kind === "other") throw err;
      continue;
    }

    manager.reportSuccess(index);
    let text = "";
    if (!first.done) {
      text += first.value;
      onDelta(first.value);
    }
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        text += next.value;
        onDelta(next.value);
      }
    } catch {
      // Mid-stream failure after a successful start — stop here rather
      // than retrying into a second, overlapping generation.
    }
    return text;
  }

  throw lastErr;
}
