-- ALTOSSA — Brand catalogue library
-- Stores all products extracted from a brand's website, independent of any project.
-- Users browse this library and SELECT which products to add to a specific project.
-- Run after 0001-0007, once, in the Supabase SQL Editor.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- BRAND CATALOGUE PRODUCTS
-- A per-brand library of extracted products, not tied to any project.
-- source_url is globally unique so the same product page is never stored twice.
-- ---------------------------------------------------------------------------
create table if not exists brand_catalogue_products (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  name text not null,
  slug text not null,
  source_url text not null,
  description text,
  images jsonb not null default '[]'::jsonb,
  primary_image_url text,
  category_id uuid references categories(id) on delete set null,
  category_name text,
  extracted_at timestamptz not null default now()
);

create unique index if not exists brand_catalogue_products_source_url_idx
  on brand_catalogue_products (source_url);
create index if not exists brand_catalogue_products_brand_idx
  on brand_catalogue_products (brand_id);
