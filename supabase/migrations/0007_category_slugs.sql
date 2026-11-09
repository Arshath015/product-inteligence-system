-- Adds three table-type categories that extraction can now distinguish
-- (see lib/extraction.ts CATEGORY_SLUGS / CATEGORY_KEYWORDS): desks,
-- dining-tables, and consoles. Previously these all fell into the generic
-- "tables" bucket (or, for desks specifically, were never distinguished
-- from tables at all). Sort order is interleaved with the existing rows so
-- the catalogue's category filter groups them near the other table types.
--
-- NOTE: these rows were already inserted by hand against the live Supabase
-- project when this fix shipped — this migration exists so the schema file
-- matches the live database for anyone re-provisioning from scratch.
insert into categories (name, slug, sort_order) values
  ('Desks', 'desks', 45),
  ('Dining Tables', 'dining-tables', 52),
  ('Consoles', 'consoles', 54)
on conflict (slug) do nothing;
