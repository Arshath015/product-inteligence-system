-- ALTOSSA — Multi-project workspace support.
-- Adds project-wise isolation for brands, products, conversations, memory,
-- inspirations and research, plus reference junction tables so products and
-- brands can be explicitly shared across projects without being duplicated
-- or modified. Purely additive + backfilled — all existing data is kept and
-- assigned to a new "Default Project". Run after 0001-0004, once, in the
-- Supabase SQL Editor.
--
-- Single-user app, no auth/session system — "project isolation" here means
-- every server-side query is scoped by project_id (enforced in application
-- code), backed by NOT NULL + foreign keys at the database level. Categories
-- and designers stay global/shared (neutral reference taxonomy, not client
-- data); only brands/products (via reference junctions) and conversations/
-- memory/inspirations/research (via a direct project_id column) are isolated.

-- ---------------------------------------------------------------------------
-- PROJECTS
-- ---------------------------------------------------------------------------
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client_name text,
  description text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_status_idx on projects (status, updated_at desc);

drop trigger if exists projects_set_updated_at on projects;
create trigger projects_set_updated_at before update on projects
  for each row execute function set_updated_at();

alter table projects enable row level security;

-- ---------------------------------------------------------------------------
-- Add project_id (nullable for now — backfilled below, then locked NOT NULL)
-- ---------------------------------------------------------------------------
alter table brands add column if not exists project_id uuid references projects(id) on delete restrict;
alter table products add column if not exists project_id uuid references projects(id) on delete restrict;
alter table conversations add column if not exists project_id uuid references projects(id) on delete restrict;
alter table assistant_memory add column if not exists project_id uuid references projects(id) on delete restrict;
alter table memory_items add column if not exists project_id uuid references projects(id) on delete restrict;
alter table inspirations add column if not exists project_id uuid references projects(id) on delete restrict;
alter table research_jobs add column if not exists project_id uuid references projects(id) on delete restrict;
alter table pending_discoveries add column if not exists project_id uuid references projects(id) on delete restrict;
alter table activity_log add column if not exists project_id uuid references projects(id) on delete set null;

-- ---------------------------------------------------------------------------
-- REFERENCE JUNCTIONS: which products/brands are VISIBLE in a project's
-- catalogue. A junction row where project_id = the record's own owning
-- project means "owned by this project"; any other junction row is an
-- explicit reference to another project's record (created via the reuse
-- mechanism), never a copy. Deleting a reference row never touches the
-- source record or any other project's junction row.
-- ---------------------------------------------------------------------------
create table if not exists project_products (
  project_id uuid not null references projects(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, product_id)
);
create index if not exists project_products_product_idx on project_products (product_id);

create table if not exists project_brands (
  project_id uuid not null references projects(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, brand_id)
);
create index if not exists project_brands_brand_idx on project_brands (brand_id);

alter table project_products enable row level security;
alter table project_brands enable row level security;

-- ---------------------------------------------------------------------------
-- BACKFILL: assign every existing record to a Default Project (reusing one
-- if this migration is re-run) and mark existing products/brands as owned
-- by it (self-referencing junction rows) so nothing disappears from its own
-- catalogue.
-- ---------------------------------------------------------------------------
do $$
declare
  default_project_id uuid;
begin
  select id into default_project_id from projects order by created_at asc limit 1;

  if default_project_id is null then
    insert into projects (name, description)
    values ('Default Project', 'Existing catalogue from before multi-project support.')
    returning id into default_project_id;
  end if;

  update brands set project_id = default_project_id where project_id is null;
  update products set project_id = default_project_id where project_id is null;
  update conversations set project_id = default_project_id where project_id is null;
  update assistant_memory set project_id = default_project_id where project_id is null;
  update memory_items set project_id = default_project_id where project_id is null;
  update inspirations set project_id = default_project_id where project_id is null;
  update research_jobs set project_id = default_project_id where project_id is null;
  update pending_discoveries set project_id = default_project_id where project_id is null;
  update activity_log set project_id = default_project_id where project_id is null;

  insert into project_products (project_id, product_id)
  select default_project_id, id from products
  on conflict do nothing;

  insert into project_brands (project_id, brand_id)
  select default_project_id, id from brands
  on conflict do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- Lock down NOT NULL now that every row has a project_id.
-- ---------------------------------------------------------------------------
alter table brands alter column project_id set not null;
alter table products alter column project_id set not null;
alter table conversations alter column project_id set not null;
alter table assistant_memory alter column project_id set not null;
alter table memory_items alter column project_id set not null;
alter table inspirations alter column project_id set not null;
alter table research_jobs alter column project_id set not null;
alter table pending_discoveries alter column project_id set not null;
-- activity_log.project_id stays nullable (on delete set null) — it's a log, not security-sensitive.

create index if not exists brands_project_idx on brands (project_id);
create index if not exists products_project_idx on products (project_id);
create index if not exists conversations_project_idx on conversations (project_id, status, updated_at desc);
create index if not exists assistant_memory_project_idx on assistant_memory (project_id);
create index if not exists memory_items_project_idx on memory_items (project_id);
create index if not exists inspirations_project_idx on inspirations (project_id, status);
create index if not exists research_jobs_project_idx on research_jobs (project_id);
create index if not exists pending_discoveries_project_idx on pending_discoveries (project_id);
create index if not exists activity_log_project_idx on activity_log (project_id);

-- ---------------------------------------------------------------------------
-- Re-scope uniqueness constraints that were global to be per-project — two
-- different projects must be able to independently own a brand/product with
-- the same slug/canonical URL without colliding.
-- ---------------------------------------------------------------------------
alter table brands drop constraint if exists brands_slug_key;
create unique index if not exists brands_project_slug_idx on brands (project_id, slug);

drop index if exists products_canonical_url_idx;
create unique index if not exists products_project_canonical_url_idx
  on products (project_id, canonical_url) where canonical_url is not null;

alter table assistant_memory drop constraint if exists assistant_memory_key_key;
create unique index if not exists assistant_memory_project_key_idx on assistant_memory (project_id, key);

drop index if exists inspirations_canonical_url_idx;
create unique index if not exists inspirations_project_canonical_url_idx
  on inspirations (project_id, canonical_url) where canonical_url is not null;

-- ---------------------------------------------------------------------------
-- Project-aware duplicate-detection + directory functions, replacing the
-- global versions from 0003/0004. Product/brand matching is scoped to
-- records VISIBLE to the project (owned or explicitly referenced), never
-- across projects implicitly — cross-project reuse only happens through the
-- explicit reuse mechanism, never by silently matching another project's
-- data during normal ingestion.
-- ---------------------------------------------------------------------------
drop function if exists find_similar_products(text, uuid, float);
create function find_similar_products(
  p_project_id uuid,
  p_name text,
  p_brand_id uuid default null,
  p_threshold float default 0.45
)
returns table (id uuid, name text, similarity float)
language sql stable as $$
  select p.id, p.name, similarity(p.name, p_name) as similarity
  from products p
  join project_products pp on pp.product_id = p.id and pp.project_id = p_project_id
  where (p_brand_id is null or p.brand_id = p_brand_id)
    and similarity(p.name, p_name) > p_threshold
  order by similarity desc
  limit 5;
$$;

drop function if exists find_similar_brands(text, float);
create function find_similar_brands(
  p_project_id uuid,
  p_name text,
  p_threshold float default 0.6
)
returns table (id uuid, name text, similarity float)
language sql stable as $$
  select b.id, b.name, similarity(b.name, p_name) as similarity
  from brands b
  join project_brands pb on pb.brand_id = b.id and pb.project_id = p_project_id
  where similarity(b.name, p_name) > p_threshold
  order by similarity desc
  limit 5;
$$;

drop function if exists search_conversation_summaries(text, uuid, float);
create function search_conversation_summaries(
  p_project_id uuid,
  p_query text,
  p_exclude_id uuid default null,
  p_threshold float default 0.12
)
returns table (conversation_id uuid, title text, summary text, similarity float)
language sql stable as $$
  select cs.conversation_id, c.title, cs.summary, similarity(cs.summary, p_query) as similarity
  from conversation_summaries cs
  join conversations c on c.id = cs.conversation_id
  where c.project_id = p_project_id
    and (p_exclude_id is null or cs.conversation_id <> p_exclude_id)
    and cs.summary <> ''
    and similarity(cs.summary, p_query) > p_threshold
  order by similarity desc
  limit 3;
$$;

drop function if exists search_memory_items(text, float);
create function search_memory_items(
  p_project_id uuid,
  p_query text,
  p_threshold float default 0.08
)
returns table (id uuid, category text, content text, similarity float)
language sql stable as $$
  select id, category, content, similarity(content, p_query) as similarity
  from memory_items
  where project_id = p_project_id
    and similarity(content, p_query) > p_threshold
  order by similarity desc
  limit 8;
$$;

-- Brand directory with live, project-scoped product counts. is_owner tells
-- the UI whether this brand was created in the current project or is a
-- reference to another project's brand.
drop view if exists brands_with_counts;
create function brands_with_counts_for_project(p_project_id uuid)
returns table (
  id uuid, name text, slug text, website_url text, description text, country text,
  logo_url text, status text, created_at timestamptz, updated_at timestamptz,
  product_count bigint, is_owner boolean
)
language sql stable as $$
  select b.id, b.name, b.slug, b.website_url, b.description, b.country,
    b.logo_url, b.status, b.created_at, b.updated_at,
    count(pp2.product_id) filter (where p.status = 'published') as product_count,
    (b.project_id = p_project_id) as is_owner
  from brands b
  join project_brands pb on pb.brand_id = b.id and pb.project_id = p_project_id
  left join products p on p.brand_id = b.id
  left join project_products pp2 on pp2.product_id = p.id and pp2.project_id = p_project_id
  where b.status = 'active'
  group by b.id;
$$;

-- Category list with live, project-scoped product counts.
drop view if exists categories_with_counts;
create function categories_with_counts_for_project(p_project_id uuid)
returns table (
  id uuid, name text, slug text, parent_id uuid, sort_order int, created_at timestamptz,
  product_count bigint
)
language sql stable as $$
  select c.id, c.name, c.slug, c.parent_id, c.sort_order, c.created_at,
    count(pp.product_id) filter (where p.status = 'published') as product_count
  from categories c
  left join products p on p.category_id = c.id
  left join project_products pp on pp.product_id = p.id and pp.project_id = p_project_id
  group by c.id
  order by c.sort_order;
$$;

-- Per-project stats for the project-selection workspace cards.
create or replace function project_stats(p_project_id uuid)
returns table (
  product_count bigint,
  brand_count bigint,
  inspiration_count bigint,
  conversation_count bigint,
  last_activity timestamptz
)
language sql stable as $$
  select
    (select count(*) from project_products pp join products p on p.id = pp.product_id
       where pp.project_id = p_project_id and p.status = 'published') as product_count,
    (select count(*) from project_brands pb join brands b on b.id = pb.brand_id
       where pb.project_id = p_project_id and b.status = 'active') as brand_count,
    (select count(*) from inspirations where project_id = p_project_id and status = 'active') as inspiration_count,
    (select count(*) from conversations where project_id = p_project_id and status = 'active') as conversation_count,
    (select max(x.ts) from (
       select updated_at as ts from conversations where project_id = p_project_id
       union all
       select updated_at as ts from products p join project_products pp on pp.product_id = p.id where pp.project_id = p_project_id
       union all
       select created_at as ts from inspirations where project_id = p_project_id
     ) x) as last_activity;
$$;
