import { tool } from "ai";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { listProducts } from "@/lib/products";
import { ingestProductUrl } from "@/lib/ingest";
import { saveInspirationUrl } from "@/lib/inspiration";
import { classifyUrl } from "@/lib/linkRouter";
import { tavilySearch } from "@/lib/tavily";
import { searchMemory } from "@/lib/chat/memory";
import { processBulkUrls } from "@/lib/bulk/pipeline";
import type { Inspiration, Product } from "@/lib/types";

export interface ToolCtx {
  projectId: string;
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
        "Search the ACTIVE PROJECT's product catalogue by name, description, category or brand. Always try this before researching the web.",
      inputSchema: z.object({
        query: z.string().describe("Free-text search, e.g. 'Italian lounge chair'"),
        categorySlug: z
          .string()
          .nullable()
          .describe(
            "One of: sofas, armchairs, lounge-chairs, dining-chairs, desks, tables, dining-tables, consoles, coffee-tables, side-tables, beds, lighting, accessories, rugs, storage, outdoor, other"
          ),
        brandSlug: z.string().nullable().describe("Filter by brand slug if known"),
        limit: z.number().int().min(1).max(12).default(6),
      }),
      execute: async ({ query, categorySlug, brandSlug, limit }) => {
        const { products, total } = await listProducts({
          projectId: ctx.projectId,
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
        "Handles ANY URL the client pastes — a product page, a Pinterest pin/board, an Instagram post/reel, or a brand site. Automatically detects the link type and routes it correctly: product pages go to the active project's catalogue, Pinterest/Instagram links go to its Inspiration library. Use this for every URL — don't try to guess the platform yourself.",
      inputSchema: z.object({ url: z.string().describe("The URL the client shared") }),
      execute: async ({ url }) => {
        const linkType = classifyUrl(url);

        if (linkType === "pinterest" || linkType === "instagram") {
          const result = await saveInspirationUrl(ctx.projectId, url, linkType);
          if (result.inspiration) pushShownInspiration(ctx, [result.inspiration]);
          return {
            linkType,
            status: result.status,
            message: result.message,
            inspiration: result.inspiration ? summarizeInspiration(result.inspiration) : null,
          };
        }

        const result = await ingestProductUrl(ctx.projectId, url);
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
        "Save a URL to the active project's Inspiration library specifically (not the product catalogue), even if it's a manufacturer/brand link. Use only when the client explicitly asks to save something as inspiration rather than as a catalogue product.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        const result = await saveInspirationUrl(ctx.projectId, url);
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
        "Search the public web for brands or products that are not already in the active project's catalogue. Use only when the catalogue search didn't return enough results, or the user asked about a brand/topic directly.",
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
      description: "List brands already in the active project's catalogue, with how many products each has.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(25) }),
      execute: async ({ limit }) => {
        const supabase = getSupabaseAdmin();
        const { data } = await supabase
          .rpc("brands_with_counts_for_project", { p_project_id: ctx.projectId })
          .order("name", { ascending: true })
          .limit(limit);
        return { brands: (data ?? []).map((b: { name: string; slug: string; product_count: number }) => b) };
      },
    }),

    remember_preference: tool({
      description:
        "Persist a short fact about the client's taste or preferences (e.g. favorite brands, styles, budget range) for this project so future conversations in it can use it. Keep keys short and stable, e.g. 'style_preference'.",
      inputSchema: z.object({ key: z.string(), value: z.string() }),
      execute: async ({ key, value }) => {
        const supabase = getSupabaseAdmin();
        await supabase
          .from("assistant_memory")
          .upsert(
            { project_id: ctx.projectId, key, value, updated_at: new Date().toISOString() },
            { onConflict: "project_id,key" }
          );
        return { ok: true };
      },
    }),

    recall_memory: tool({
      description:
        "Search this project's earlier conversations and saved long-term facts for something relevant to what the client is asking now — e.g. a brand or preference they mentioned in a previous session. Only use when the current conversation's own context doesn't already answer it. Never surfaces another project's data.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const result = await searchMemory(ctx.projectId, query, ctx.conversationId);
        return result;
      },
    }),

    add_brand_catalogue: tool({
      description:
        "Import ALL products from a brand's website into the active project catalogue. Use when the user asks to 'add all products from [brand]', 'import [brand] catalogue', or 'get everything from [brand].com'. Crawls the brand site across all collection and category pages, discovers individual product URLs, and imports them in bulk. Handles Italian, French, German and Spanish URL structures. Reports exactly how many were discovered, added, duplicate, and failed.",
      inputSchema: z.object({
        brandUrl: z
          .string()
          .describe("The brand's homepage or main website URL, e.g. https://pianca.com"),
        brandName: z
          .string()
          .describe("The brand's display name, e.g. Pianca"),
      }),
      execute: async ({ brandUrl, brandName }) => {
        // Auto-continue until all products are ingested or we hit the safety cap.
        // Each run processes up to 50 products; runs repeat within the same request
        // as long as the pipeline reports pendingProducts > 0.
        // Safety cap: at most 5 runs (250 products max per chat message; a brand with
        // 300+ products is unusual and the user can re-submit to continue further).
        const MAX_AUTO_RUNS = 5;
        let totalAdded = 0;
        let totalDupes = 0;
        let totalFailed = 0;
        const allNewProducts: Product[] = [];
        let pendingProducts = 1; // start > 0 to enter the loop
        let runCount = 0;

        while (pendingProducts > 0 && runCount < MAX_AUTO_RUNS) {
          runCount++;
          const summary = await processBulkUrls(ctx.projectId, [brandUrl]).catch((err) => ({
            total: 1,
            results: [],
            counts: {
              productsAdded: 0,
              discoveredProductsAdded: 0,
              brandsCreated: 0,
              brandsMatched: 0,
              manufacturersSaved: 0,
              inspirationSaved: 0,
              duplicates: 0,
              failed: 1,
            },
            error: (err as Error).message,
          }));

          const batchAdded = summary.counts.productsAdded + summary.counts.discoveredProductsAdded;
          totalAdded += batchAdded;
          totalDupes += summary.counts.duplicates;
          totalFailed += summary.counts.failed;

          for (const r of summary.results) {
            if (r.product) allNewProducts.push(r.product);
            for (const d of r.discovered ?? []) {
              if (d.product) allNewProducts.push(d.product);
            }
          }

          // Check if the pipeline says there are still products remaining
          const brandResult = summary.results.find((r) => r.kind === "brand");
          pendingProducts = brandResult?.pendingProducts ?? 0;

          // If this run added nothing new (all dupes/failures), stop to avoid an
          // infinite loop on a brand whose remaining URLs all permanently fail.
          if (batchAdded === 0 && summary.counts.duplicates === 0) break;
        }

        pushShown(ctx, allNewProducts);

        return {
          brand: brandName,
          discovered: totalAdded + totalDupes,
          added: totalAdded,
          duplicates: totalDupes,
          failed: totalFailed,
          runs: runCount,
          note:
            totalAdded === 0 && totalFailed > 0
              ? `Could not extract products from ${brandName}. The site may render its catalogue dynamically (JS-only). Try pasting individual product page URLs directly.`
              : totalAdded === 0 && totalDupes > 0
                ? `All discovered ${brandName} products are already in your catalogue.`
                : pendingProducts > 0
                  ? `Imported ${totalAdded} products so far. ${pendingProducts} more remain — re-submit to continue.`
                  : undefined,
        };
      },
    }),
  };
}
