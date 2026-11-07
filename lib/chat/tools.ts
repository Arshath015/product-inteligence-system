import { tool } from "ai";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { listProducts } from "@/lib/products";
import { ingestProductUrl } from "@/lib/ingest";
import { tavilySearch } from "@/lib/tavily";
import type { Product } from "@/lib/types";

export interface ToolCtx {
  shownProducts: Product[];
}

function primaryImageUrl(p: Product): string | null {
  const img = p.images?.find((i) => i.is_primary && i.status === "stored") ?? p.images?.[0];
  return img?.status === "stored" ? img.public_url ?? null : null;
}

function summarize(p: Product) {
  return {
    id: p.id,
    name: p.name,
    brand: p.brand?.name ?? null,
    category: p.category?.name ?? null,
    hasImage: Boolean(primaryImageUrl(p)),
    sourceUrl: p.source_url,
  };
}

function pushShown(ctx: ToolCtx, products: Product[]) {
  for (const p of products) {
    if (!ctx.shownProducts.find((existing) => existing.id === p.id)) {
      ctx.shownProducts.push(p);
    }
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
        return { total, results: products.map(summarize) };
      },
    }),

    ingest_url: tool({
      description:
        "Fetch a product page URL, extract its details and image, check for duplicates, and save it to the catalogue (or enrich the existing record if it's already there). Use this whenever the user pastes a product URL.",
      inputSchema: z.object({ url: z.string().describe("The product page URL") }),
      execute: async ({ url }) => {
        const result = await ingestProductUrl(url);
        if (result.product) pushShown(ctx, [result.product]);
        return {
          status: result.status,
          message: result.message,
          product: result.product ? summarize(result.product) : null,
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
  };
}
