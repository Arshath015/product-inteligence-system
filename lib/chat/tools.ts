import { tool } from "ai";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { listProducts } from "@/lib/products";
import { ingestProductUrl } from "@/lib/ingest";
import { saveInspirationUrl } from "@/lib/inspiration";
import { classifyUrl } from "@/lib/linkRouter";
import { tavilySearch } from "@/lib/tavily";
import { searchMemory } from "@/lib/chat/memory";
import type { Inspiration, Product } from "@/lib/types";

export interface ToolCtx {
  shownProducts: Product[];
  shownInspirations: Inspiration[];
  conversationId: string;
}

function primaryImageUrl(p: Product): string | null {
  const img = p.images?.find((i) => i.is_primary && i.status === "stored") ?? p.images?.[0];
  return img?.status === "stored" ? img.public_url ?? null : null;
}

function summarizeProduct(p: Product) {
  return {
    id: p.id,
    name: p.name,
    brand: p.brand?.name ?? null,
    category: p.category?.name ?? null,
    hasImage: Boolean(primaryImageUrl(p)),
    sourceUrl: p.source_url,
  };
}

function summarizeInspiration(i: Inspiration) {
  return {
    id: i.id,
    title: i.title,
    platform: i.platform,
    hasImage: i.image_status === "stored",
    sourceUrl: i.source_url,
  };
}

function pushShown(ctx: ToolCtx, products: Product[]) {
  for (const p of products) {
    if (!ctx.shownProducts.find((existing) => existing.id === p.id)) ctx.shownProducts.push(p);
  }
}

function pushShownInspiration(ctx: ToolCtx, items: Inspiration[]) {
  for (const i of items) {
    if (!ctx.shownInspirations.find((existing) => existing.id === i.id)) ctx.shownInspirations.push(i);
  }
}

export function buildChatTools(ctx: ToolCtx) {
  return {
    search_catalog: tool({
      description:
        "Search the existing product catalogue by name, description, category or brand. Always try this before researching the web.",
      inputSchema: z.object({
        query: z.string().describe("Free-text search, e.g. 'Italian lounge chair'"),
        categorySlug: z
          .string()
          .nullable()
          .describe(
            "One of: sofas, armchairs, lounge-chairs, dining-chairs, tables, coffee-tables, side-tables, beds, lighting, accessories, rugs, storage, outdoor, other"
          ),
        brandSlug: z.string().nullable().describe("Filter by brand slug if known"),
        limit: z.number().int().min(1).max(12).default(6),
      }),
      execute: async ({ query, categorySlug, brandSlug, limit }) => {
        const { products, total } = await listProducts({
          q: query,
          categorySlug: categorySlug ?? undefined,
          brandSlug: brandSlug ?? undefined,
          limit,
        });
        pushShown(ctx, products);
        return { total, results: products.map(summarizeProduct) };
      },
    }),

    save_link: tool({
      description:
        "Handles ANY URL the client pastes — a product page, a Pinterest pin/board, an Instagram post/reel, or a brand site. Automatically detects the link type and routes it correctly: product pages go to the catalogue, Pinterest/Instagram links go to the Inspiration library. Use this for every URL — don't try to guess the platform yourself.",
      inputSchema: z.object({ url: z.string().describe("The URL the client shared") }),
      execute: async ({ url }) => {
        const linkType = classifyUrl(url);

        if (linkType === "pinterest" || linkType === "instagram") {
          const result = await saveInspirationUrl(url, linkType);
          if (result.inspiration) pushShownInspiration(ctx, [result.inspiration]);
          return {
            linkType,
            status: result.status,
            message: result.message,
            inspiration: result.inspiration ? summarizeInspiration(result.inspiration) : null,
          };
        }

        const result = await ingestProductUrl(url);
        if (result.product) pushShown(ctx, [result.product]);
        return {
          linkType: "product",
          status: result.status,
          message: result.message,
          product: result.product ? summarizeProduct(result.product) : null,
        };
      },
    }),

    save_inspiration_explicit: tool({
      description:
        "Save a URL to the Inspiration library specifically (not the product catalogue), even if it's a manufacturer/brand link. Use only when the client explicitly asks to save something as inspiration rather than as a catalogue product.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        const result = await saveInspirationUrl(url);
        if (result.inspiration) pushShownInspiration(ctx, [result.inspiration]);
        return {
          status: result.status,
          message: result.message,
          inspiration: result.inspiration ? summarizeInspiration(result.inspiration) : null,
        };
      },
    }),

    web_research: tool({
      description:
        "Search the public web for brands or products that are not already in the catalogue. Use only when the catalogue search didn't return enough results, or the user asked about a brand/topic directly.",
      inputSchema: z.object({
        query: z.string(),
        maxResults: z.number().int().min(1).max(10).default(6),
      }),
      execute: async ({ query, maxResults }) => {
        const res = await tavilySearch(query, { maxResults });
        return {
          results: res.results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content.slice(0, 280),
          })),
        };
      },
    }),

    list_brands: tool({
      description: "List brands already in the catalogue, with how many products each has.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(25) }),
      execute: async ({ limit }) => {
        const supabase = getSupabaseAdmin();
        const { data } = await supabase
          .from("brands_with_counts")
          .select("name,slug,product_count")
          .order("name", { ascending: true })
          .limit(limit);
        return { brands: data ?? [] };
      },
    }),

    remember_preference: tool({
      description:
        "Persist a short fact about the client's taste or preferences (e.g. favorite brands, styles, budget range) so future conversations can use it. Keep keys short and stable, e.g. 'style_preference'.",
      inputSchema: z.object({ key: z.string(), value: z.string() }),
      execute: async ({ key, value }) => {
        const supabase = getSupabaseAdmin();
        await supabase
          .from("assistant_memory")
          .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
        return { ok: true };
      },
    }),

    recall_memory: tool({
      description:
        "Search earlier conversations and saved long-term facts for something relevant to what the client is asking now — e.g. a brand or preference they mentioned in a previous session. Only use when the current conversation's own context doesn't already answer it.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const result = await searchMemory(query, ctx.conversationId);
        return result;
      },
    }),
  };
}
