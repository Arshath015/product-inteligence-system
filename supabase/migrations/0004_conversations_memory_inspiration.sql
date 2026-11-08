-- ALTOSSA — Advanced chat, long-term memory, multi-source link intelligence.
-- Purely additive: extends existing tables, adds new ones. Run after 0001-0003.
-- Run this entire file once in the Supabase SQL Editor.

-- ---------------------------------------------------------------------------
-- CONVERSATIONS: multi-conversation support (active/archived, searchable)
-- ---------------------------------------------------------------------------
alter table conversations add column if not exists status text not null default 'active'
  check (status in ('active', 'archived'));
create index if not exists conversations_status_idx on conversations (status, updated_at desc);
create index if not exists conversations_title_trgm_idx on conversations using gin (title gin_trgm_ops);

-- Chat messages can now also reference saved inspiration items, not just products.
alter table messages add column if not exists referenced_inspiration_ids uuid[] not null default '{}';

-- Needed for fast cross-conversation summary search (added below).
create index if not exists conversation_summaries_trgm_idx on conversation_summaries using gin (summary gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- MEMORY ITEMS: free-form long-term facts extracted from conversations,
-- distinct from the existing singleton `assistant_memory` key/value table
-- (still used by the explicit remember_preference tool for durable
-- single-slot prefs like "style_preference"). memory_items instead holds a
-- growing list of discrete facts ("prefers walnut over oak", "budget ~5k€")
-- that can be searched and that record which conversation they came from.
-- ---------------------------------------------------------------------------
create table if not exists memory_items (
  id uuid primary key default gen_random_uuid(),
  category text not null default 'general'
    check (category in ('brand_preference', 'style', 'material', 'budget', 'designer_preference', 'general')),
  content text not null,
  confidence text not null default 'stated' check (confidence in ('stated', 'inferred')),
  source_conversation_id uuid references conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists memory_items_content_trgm_idx on memory_items using gin (content gin_trgm_ops);
create index if not exists memory_items_category_idx on memory_items (category);

drop trigger if exists memory_items_set_updated_at on memory_items;
create trigger memory_items_set_updated_at before update on memory_items
  for each row execute function set_updated_at();

alter table memory_items enable row level security;

-- ---------------------------------------------------------------------------
-- INSPIRATIONS: design references saved from Pinterest/Instagram/other
-- sources. Deliberately separate from `products` — an inspiration is not a
-- confirmed catalogue item.
-- ---------------------------------------------------------------------------
create table if not exists inspirations (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('pinterest', 'instagram', 'manufacturer', 'brand', 'other')),
  source_url text not null,
  canonical_url text,
  title text,
  description text,
  caption text,
  image_original_url text,
  image_storage_path text,
  image_public_url text,
  image_status text not null default 'pending' check (image_status in ('pending', 'stored', 'failed', 'missing')),
  tags text[] not null default '{}',
  related_brand_id uuid references brands(id) on delete set null,
  related_product_id uuid references products(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists inspirations_canonical_url_idx on inspirations (canonical_url) where canonical_url is not null;
create index if not exists inspirations_title_trgm_idx on inspirations using gin (title gin_trgm_ops);
create index if not exists inspirations_platform_idx on inspirations (platform, status);
create index if not exists inspirations_tags_idx on inspirations using gin (tags);

drop trigger if exists inspirations_set_updated_at on inspirations;
create trigger inspirations_set_updated_at before update on inspirations
  for each row execute function set_updated_at();

alter table inspirations enable row level security;

-- Images are stored in the existing `product-images` Storage bucket under an
-- `inspirations/` path prefix — the bucket's existing public-read policy
-- (from 0002_storage.sql) already covers it, no new bucket needed.

-- ---------------------------------------------------------------------------
-- FUZZY SEARCH FUNCTIONS for cross-conversation / long-term memory retrieval
-- ---------------------------------------------------------------------------
create or replace function search_conversation_summaries(
  p_query text,
  p_exclude_id uuid default null,
  p_threshold float default 0.12
)
returns table (conversation_id uuid, title text, summary text, similarity float)
language sql stable as $$
  select cs.conversation_id, c.title, cs.summary, similarity(cs.summary, p_query) as similarity
  from conversation_summaries cs
  join conversations c on c.id = cs.conversation_id
  where (p_exclude_id is null or cs.conversation_id <> p_exclude_id)
    and cs.summary <> ''
    and similarity(cs.summary, p_query) > p_threshold
  order by similarity desc
  limit 3;
$$;

create or replace function search_memory_items(
  p_query text,
  p_threshold float default 0.08
)
returns table (id uuid, category text, content text, similarity float)
language sql stable as $$
  select id, category, content, similarity(content, p_query) as similarity
  from memory_items
  where similarity(content, p_query) > p_threshold
  order by similarity desc
  limit 8;
$$;
