-- ALTOSSA — Luxury Design Intelligence
-- Initial schema: brands, designers, categories, products, images,
-- chat (conversations/messages), assistant memory, research jobs,
-- pending discoveries, activity log.
--
-- Run this entire file once in the Supabase SQL Editor (SQL Editor -> New query -> paste -> Run).

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- BRANDS
-- ---------------------------------------------------------------------------
create table if not exists brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  website_url text,
  description text,
  country text,
  logo_url text,
  logo_storage_path text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists brands_name_trgm_idx on brands using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- DESIGNERS
-- ---------------------------------------------------------------------------
create table if not exists designers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  bio text,
  website_url text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- CATEGORIES (self-referencing so the taxonomy can grow without code changes)
-- ---------------------------------------------------------------------------
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  parent_id uuid references categories(id) on delete set null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

insert into categories (name, slug, sort_order) values
  ('Sofas', 'sofas', 10),
  ('Armchairs', 'armchairs', 20),
  ('Lounge Chairs', 'lounge-chairs', 30),
  ('Dining Chairs', 'dining-chairs', 40),
  ('Tables', 'tables', 50),
  ('Coffee Tables', 'coffee-tables', 60),
  ('Side Tables', 'side-tables', 70),
  ('Beds', 'beds', 80),
  ('Lighting', 'lighting', 90),
  ('Accessories', 'accessories', 100),
  ('Rugs', 'rugs', 110),
  ('Storage', 'storage', 120),
  ('Outdoor', 'outdoor', 130),
  ('Other', 'other', 999)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- PRODUCTS
-- ---------------------------------------------------------------------------
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  brand_id uuid references brands(id) on delete set null,
  designer_id uuid references designers(id) on delete set null,
  category_id uuid references categories(id) on delete set null,
  description text,
  materials text,
  dimensions text,
  price_text text,
  source_url text,
  canonical_url text,
  source_domain text,
  status text not null default 'published' check (status in ('published', 'draft', 'archived')),
  extraction_status text not null default 'complete' check (extraction_status in ('pending', 'complete', 'partial', 'failed')),
  search_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists products_canonical_url_idx on products (canonical_url) where canonical_url is not null;
create index if not exists products_brand_idx on products (brand_id);
create index if not exists products_category_idx on products (category_id);
create index if not exists products_name_trgm_idx on products using gin (name gin_trgm_ops);
create index if not exists products_search_text_trgm_idx on products using gin (search_text gin_trgm_ops);
create index if not exists products_status_idx on products (status);

-- ---------------------------------------------------------------------------
-- PRODUCT IMAGES (persisted copies in Supabase Storage + original source)
-- ---------------------------------------------------------------------------
create table if not exists product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  original_url text,
  storage_path text,
  public_url text,
  is_primary boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'stored', 'failed', 'missing')),
  width int,
  height int,
  created_at timestamptz not null default now()
);
create index if not exists product_images_product_idx on product_images (product_id);
create unique index if not exists product_images_primary_unique
  on product_images (product_id) where is_primary;

-- ---------------------------------------------------------------------------
-- CONVERSATIONS & MESSAGES
-- ---------------------------------------------------------------------------
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  title text,
  last_shown_product_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null default '',
  tool_calls jsonb,
  referenced_product_ids uuid[] default '{}',
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_idx on messages (conversation_id, created_at);

-- Rolling summary of older turns so we never send unbounded raw history to the LLM.
create table if not exists conversation_summaries (
  conversation_id uuid primary key references conversations(id) on delete cascade,
  summary text not null default '',
  summarized_through_message_id uuid,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- ASSISTANT MEMORY / CLIENT PREFERENCES (single-user for now)
-- ---------------------------------------------------------------------------
create table if not exists assistant_memory (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RESEARCH JOBS (brand/product web research triggered from chat)
-- ---------------------------------------------------------------------------
create table if not exists research_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('url_ingest', 'brand_research', 'topic_search')),
  input text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'complete', 'failed')),
  result jsonb,
  error text,
  conversation_id uuid references conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- ---------------------------------------------------------------------------
-- PENDING DISCOVERIES (candidate products/brands awaiting confirmation)
-- ---------------------------------------------------------------------------
create table if not exists pending_discoveries (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('product', 'brand')),
  source_url text,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  research_job_id uuid references research_jobs(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- ACTIVITY LOG
-- ---------------------------------------------------------------------------
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  entity_type text,
  entity_id uuid,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_log_created_idx on activity_log (created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists brands_set_updated_at on brands;
create trigger brands_set_updated_at before update on brands
  for each row execute function set_updated_at();

drop trigger if exists products_set_updated_at on products;
create trigger products_set_updated_at before update on products
  for each row execute function set_updated_at();

drop trigger if exists conversations_set_updated_at on conversations;
create trigger conversations_set_updated_at before update on conversations
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security — single-user app accessed only via the server
-- (service role key), so we lock all tables down from the public/anon role.
-- ---------------------------------------------------------------------------
alter table brands enable row level security;
alter table designers enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table product_images enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table conversation_summaries enable row level security;
alter table assistant_memory enable row level security;
alter table research_jobs enable row level security;
alter table pending_discoveries enable row level security;
alter table activity_log enable row level security;

-- Categories are safe to read publicly (used for filter UI if ever exposed client-side).
drop policy if exists categories_public_read on categories;
create policy categories_public_read on categories for select using (true);

-- No policies are created for the other tables, so only the service role
-- (which bypasses RLS) can read/write them. All app access goes through
-- Next.js server-side API routes using the service role key.
