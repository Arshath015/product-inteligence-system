# ALTOSSA — Luxury Design Intelligence

A living catalogue of luxury furniture/lighting/interior-design products, paired
with a conversational AI assistant that shares the same database. Paste a
product URL in chat and it's extracted, deduplicated, and added to the
catalogue automatically — images included.

## Stack

- **Frontend/Backend**: Next.js 16 (App Router) + TypeScript + Tailwind CSS v4
- **LLM**: GroqCloud (`llama-3.3-70b-versatile` for chat/extraction, `meta-llama/llama-4-scout-17b-16e-instruct` for vision), via the Vercel AI SDK, with a custom 12-key rotation/fallback manager
- **Web research/extraction**: Tavily (search + extract) with direct HTML/JSON-LD parsing as the first pass
- **Database**: Supabase Postgres
- **Storage**: Supabase Storage (persisted product images, not hotlinks)

## Architecture

- `lib/groq/` — key rotation manager (`keyManager.ts`) and a `withGroqRetry`
  wrapper (`client.ts`) that rotates to another key on rate-limit/quota/auth
  failures and retries, up to 4 keys per call.
- `lib/extraction.ts` — pulls OG tags / JSON-LD / page text from a URL
  (falling back to Tavily's extract API if the site blocks direct fetches),
  then asks the Groq text model to normalize it into a structured product
  record.
- `lib/images.ts` — downloads candidate image URLs server-side and persists
  the first one that succeeds to Supabase Storage. Never substitutes an
  unrelated image; records a "missing" status if every candidate fails.
- `lib/catalog.ts` — brand/designer/category resolution and duplicate
  detection (canonical URL first, then `pg_trgm` fuzzy name matching scoped
  to the same brand).
- `lib/ingest.ts` — the full "paste a URL" pipeline: extract → resolve →
  dedupe → create or enrich → store image. Idempotent, so retries (e.g. from
  a Groq key rotation mid-chat) are safe.
- `lib/chat/` — conversation memory (rolling summary once a conversation
  passes ~24 messages, so raw history sent to the model stays bounded) and
  the tool definitions (`search_catalog`, `ingest_url`, `web_research`,
  `list_brands`, `remember_preference`) used by `generateText`'s built-in
  multi-step tool loop in `app/api/chat/route.ts`.
- `app/api/*` — REST-ish routes for products/brands/categories CRUD, URL
  ingestion, chat, and image/vision analysis. All DB access goes through
  these server routes using the Supabase **service role** key — nothing
  talks to Supabase directly from the browser.
- `components/catalog/*` — the visual catalogue (grid, filters, detail
  modal, add dialog, brand directory).
- `components/chat/*` — the persistent chat panel, shared across routes via
  a context provider in `components/layout/AppShell.tsx` (mirrors a
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
| `GROQ_TEXT_MODEL` | Defaults to `llama-3.3-70b-versatile` |
| `GROQ_VISION_MODEL` | Defaults to `meta-llama/llama-4-scout-17b-16e-instruct` |

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. In **Project Settings → API**, copy the **Project URL**, the
   **anon public key**, and the **service_role key** into `.env.local`.
3. Open the **SQL Editor** and run, in order:
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_storage.sql`
   - `supabase/migrations/0003_functions.sql`
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
