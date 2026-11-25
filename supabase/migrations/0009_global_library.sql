-- Global product library fields. Legacy project-specific catalogue records
-- keep their brand_id; new library entries use brand_name without a project.
alter table brand_catalogue_products alter column brand_id drop not null;
alter table brand_catalogue_products add column if not exists brand_name text;
alter table brand_catalogue_products add column if not exists brand_website_url text;
alter table brand_catalogue_products add column if not exists designer_name text;
alter table brand_catalogue_products add column if not exists materials text;
alter table brand_catalogue_products add column if not exists dimensions text;
alter table brand_catalogue_products add column if not exists price_text text;
alter table brand_catalogue_products add column if not exists image_storage_path text;
alter table brand_catalogue_products add column if not exists image_public_url text;
alter table brand_catalogue_products add column if not exists image_status text not null default 'pending'
  check (image_status in ('pending', 'stored', 'failed', 'missing'));

update brand_catalogue_products products
set brand_name = brands.name,
    brand_website_url = brands.website_url
from brands
where products.brand_id = brands.id
  and products.brand_name is null;

create index if not exists brand_catalogue_products_brand_name_idx
  on brand_catalogue_products (lower(brand_name));
create index if not exists brand_catalogue_products_category_idx
  on brand_catalogue_products (category_id);

create table if not exists library_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_url text not null,
  brand_name text,
  product_urls jsonb not null default '[]'::jsonb,
  failed_urls jsonb not null default '[]'::jsonb,
  discovery_truncated boolean not null default false,
  next_index integer not null default 0,
  processed_count integer not null default 0,
  added_count integer not null default 0,
  duplicate_count integer not null default 0,
  failed_count integer not null default 0,
  status text not null default 'ready' check (status in ('ready', 'complete', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists library_import_runs_updated_idx on library_import_runs (updated_at desc);
alter table library_import_runs enable row level security;
