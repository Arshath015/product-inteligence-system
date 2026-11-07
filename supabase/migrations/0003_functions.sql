-- Fuzzy-match helper used for duplicate detection (relies on pg_trgm from 0001_init.sql).

create or replace function find_similar_products(
  p_name text,
  p_brand_id uuid default null,
  p_threshold float default 0.45
)
returns table (id uuid, name text, similarity float)
language sql stable as $$
  select id, name, similarity(name, p_name) as similarity
  from products
  where (p_brand_id is null or brand_id = p_brand_id)
    and similarity(name, p_name) > p_threshold
  order by similarity desc
  limit 5;
$$;

create or replace function find_similar_brands(
  p_name text,
  p_threshold float default 0.6
)
returns table (id uuid, name text, similarity float)
language sql stable as $$
  select id, name, similarity(name, p_name) as similarity
  from brands
  where similarity(name, p_name) > p_threshold
  order by similarity desc
  limit 5;
$$;

-- Brand directory with live product counts, used by the brand UI.
create or replace view brands_with_counts as
select b.*, count(p.id) filter (where p.status = 'published') as product_count
from brands b
left join products p on p.brand_id = b.id
group by b.id;

-- Category list with live product counts, used by the filter UI.
create or replace view categories_with_counts as
select c.*, count(p.id) filter (where p.status = 'published') as product_count
from categories c
left join products p on p.category_id = c.id
group by c.id;
