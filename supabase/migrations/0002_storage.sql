-- Creates the public storage bucket used for persisted product images.
-- Run after 0001_init.sql.

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- Public read of images in this bucket (so <img> tags work without signed URLs).
drop policy if exists "Public read product-images" on storage.objects;
create policy "Public read product-images"
  on storage.objects for select
  using (bucket_id = 'product-images');

-- Writes only via the service role (server-side), so no insert/update/delete
-- policy is added for anon/authenticated roles.
