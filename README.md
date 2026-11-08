# ALTOSSA — Luxury Design Intelligence

A living catalogue of luxury furniture/lighting/interior-design products, paired
with a conversational AI assistant that shares the same database. Paste a
product URL in chat and it's extracted, deduplicated, and added to the
catalogue automatically — images included.

## Stack

- **Frontend/Backend**: Next.js 16 (App Router) + TypeScript + Tailwind CSS v4
- **LLM**: GroqCloud (`openai/gpt-oss-120b` for chat/extraction, `qwen/qwen3.8-27b` for vision), via the Vercel AI SDK, with a custom 12-key rotation/fallback manager. Model IDs are env-configurable (`GROQ_TEXT_MODEL`/`GROQ_VISION_MODEL`) — verify against `GET https://api.groq.com/openai/v1/models` with your key if Groq's catalogue changes, since available models can differ by account.
- **Web research/extraction**: Tavily (search + extract) with direct HTML/JSON-LD parsing as the first pass
- **Database**: Supabase Postgres
- **Storage**: Supabase Storage (persisted product images, not hotlinks)

## Architecture

- `lib/groq/` — key rotation manager (`keyManager.ts`) and a `withGroqRetry`
  wrapper (`client.ts`) that rotates to another key on rate-limit/quota/auth
  failures and retries, up to 4 keys per call.
- `lib/extraction.ts` — pulls OG tags / JSON-LD / page text from a URL,
  then asks the Groq text model to normalize it into a structured product
  record. Escalates to Tavily's extraction service (which does its own JS
  rendering) whenever a direct fetch fails outright *or* succeeds but
  yields no real content — a bot-detection page or an unhydrated SPA shell
  can both return HTTP 200 with nothing useful in it. If neither method
  turns up anything substantial, or the model can't identify an actual
  product name from what was found, extraction throws rather than
  returning placeholder/empty fields — `lib/ingest.ts` treats that as a
  failed import and never writes a nameless/brandless catalogue record.
- `lib/images.ts` — downloads candidate image URLs server-side and persists
  the first one that succeeds to Supabase Storage. Never substitutes an
  unrelated image; records a "missing" status if every candidate fails.
  Validates every download by actually decoding it with `sharp` (catches
  HTML error/bot-challenge pages mislabeled as images, truncated files),
  rejects anything under 200px on either edge (lazy-load placeholder
  thumbnails pass a naive content-type check but aren't usable photos), and
  recompresses oversized originals (manufacturer photography is sometimes
  6000px+/20MB+) down to a reasonable size — same photo, smaller file.
- `lib/imageRecovery.ts` — re-attempts a missing product image: first
  retries the product's own source page with the current pipeline, then
  (only if that's blocked, e.g. by bot detection) searches for the same
  product on another page and verifies the extracted name actually matches
  before accepting an image from it. Always updates the existing
  `product_images` row in place, never inserts a duplicate. Exposed via
  `POST /api/products/[id]/recover-image` (one product) and
  `POST /api/products/recover-images` (sweeps everything currently
  missing/failed).
- `lib/catalog.ts` — brand/designer/category resolution and duplicate
  detection (canonical URL first, then `pg_trgm` fuzzy name matching scoped
  to the same brand).
- `lib/ingest.ts` — the full "paste a URL" pipeline: extract → resolve →
  dedupe → create or enrich → store image. Idempotent, so retries (e.g. from
  a Groq key rotation mid-chat) are safe.
- `lib/chat/memory.ts` — multi-conversation support (list/create/rename/
  archive/delete, auto-titled from the first message), rolling per-conversation
  summaries (tracked via `summarized_through_message_id` so each summarization
  pass only processes genuinely new messages), long-term memory extraction
  (durable client-preference facts pulled out of each summarized chunk into
  `memory_items`), and `searchMemory()` for cross-conversation retrieval
  (`pg_trgm` similarity over past summaries + memory facts).
- `lib/chat/tools.ts` — tool definitions used by the chat loop:
  `search_catalog`, `save_link` (auto-routes any URL to the product catalogue
  or the Inspiration library by platform), `save_inspiration_explicit`,
  `web_research`, `list_brands`, `remember_preference`, `recall_memory`.
- `lib/linkRouter.ts` — deterministic (non-LLM) URL classification into
  product/Pinterest/Instagram. Chosen over asking the model to guess, and
  over adopting LangChain/LangGraph for the overall workflow — the existing
  AI SDK tool-calling loop already implements the same
  understand→retrieve-context→retrieve-memory→search→research→save→respond
  pipeline the brief describes, so a second orchestration framework would
  only duplicate the Groq key-rotation wrapper and tool definitions.
- `lib/inspiration.ts` / `lib/inspirationExtraction.ts` — Pinterest/Instagram
  save pipeline: reads only publicly server-rendered Open Graph metadata
  (never logs in or bypasses access controls), falls back to Tavily, and
  ultimately to just the bare URL if a platform blocks extraction. Deduped
  by canonical URL, same as products.
- `app/api/chat/route.ts` — streams responses over SSE (`text/event-stream`,
  hand-rolled `meta`/`delta`/`done` frames, parsed client-side since
  `EventSource` doesn't support POST). Groq key rotation guards the
  *connection*: if starting the stream fails (bad/rate-limited key), it
  retries with another key before any text reaches the client; a failure
  after streaming has started just ends the response, rather than retrying
  into a second overlapping generation.
- `app/api/*` — REST-ish routes for products/brands/categories/conversations/
  inspirations CRUD, URL ingestion, chat, and image/vision analysis. All DB
  access goes through these server routes using the Supabase **service
  role** key — nothing talks to Supabase directly from the browser.
- `components/catalog/*` — the visual catalogue (grid, filters, detail
  modal, add dialog, brand directory).
- `components/inspiration/*` — the Inspiration library (separate from the
  product catalogue — a saved Pinterest/Instagram reference is never
  auto-promoted to a catalogue product).
- `components/chat/*` — the persistent, resizable/collapsible chat panel
  (drag handle + collapse toggle in `components/layout/AppShell.tsx`, width
  and collapsed state in `localStorage`), with a conversation-history
  overlay (`ConversationList.tsx`) for New Chat / search / rename / archive
  / delete. Shared across routes via a context provider (mirrors a
  Claude-Projects-style chat + artifact split: chat on the left, catalogue
  on the right).

## Environment variables

Copy `.env.example` to `.env.local` and fill in real values. **Never commit
`.env.local` or the original `.env.txt`.**

| Variable | Purpose |
|---|---|
| `GROQ_API_KEY_1` … `GROQ_API_KEY_12` | Groq keys for rotation/fallback (at least 1 required) |
| `TAVILY_API_KEY` | Web search/extraction |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-only, full access) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Present for completeness; not currently used client-side |
| `GROQ_TEXT_MODEL` | Defaults to `openai/gpt-oss-120b` |
| `GROQ_VISION_MODEL` | Defaults to `qwen/qwen3.8-27b` |

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. In **Project Settings → API**, copy the **Project URL**, the
   **anon public key**, and the **service_role key** into `.env.local`.
3. Open the **SQL Editor** and run, in order:
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_storage.sql`
   - `supabase/migrations/0003_functions.sql`
   - `supabase/migrations/0004_conversations_memory_inspiration.sql`
4. That's it — no manual table/bucket creation needed in the dashboard UI.

## Local development

```bash
npm install
npm run dev
```

## Deployment

Designed for Vercel. Set the same environment variables in the Vercel
project settings (Production + Preview). Build command and framework
preset are auto-detected.
