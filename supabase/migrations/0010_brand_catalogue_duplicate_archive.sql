alter table brand_catalogue_products
  add column if not exists duplicate_of_id uuid
  references brand_catalogue_products(id) on delete set null;

create index if not exists brand_catalogue_products_duplicate_of_idx
  on brand_catalogue_products (duplicate_of_id)
  where duplicate_of_id is not null;

create or replace function apply_brand_catalogue_reconciliation(
  p_project_id uuid,
  p_category_changes jsonb default '[]'::jsonb,
  p_duplicate_links jsonb default '[]'::jsonb,
  p_restore_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  expected_categories integer;
  expected_duplicates integer;
  expected_restores integer;
  updated_categories integer := 0;
  archived_duplicates integer := 0;
  restored_duplicates integer := 0;
begin
  if jsonb_typeof(p_category_changes) <> 'array'
    or jsonb_typeof(p_duplicate_links) <> 'array' then
    raise exception 'Reconciliation changes must be JSON arrays.';
  end if;

  expected_categories := jsonb_array_length(p_category_changes);
  expected_duplicates := jsonb_array_length(p_duplicate_links);
  expected_restores := coalesce(array_length(p_restore_ids, 1), 0);

  if exists (
    select 1
    from jsonb_to_recordset(p_duplicate_links) as link(duplicate_id uuid, canonical_id uuid)
    where link.duplicate_id = link.canonical_id
      or exists (
        select 1
        from jsonb_to_recordset(p_duplicate_links) as other_link(duplicate_id uuid, canonical_id uuid)
        where other_link.duplicate_id = link.canonical_id
      )
  ) then
    raise exception 'Duplicate links cannot create self-links or chains.';
  end if;

  update brand_catalogue_products as product
  set category_name = change.category_name,
      category_id = change.category_id
  from jsonb_to_recordset(p_category_changes) as change(
    id uuid,
    category_name text,
    category_id uuid
  )
  where product.id = change.id
    and exists (
      select 1 from brands
      where brands.id = product.brand_id and brands.project_id = p_project_id
    );
  get diagnostics updated_categories = row_count;
  if updated_categories <> expected_categories then
    raise exception 'One or more category corrections no longer match this project.';
  end if;

  update brand_catalogue_products as duplicate
  set duplicate_of_id = link.canonical_id
  from jsonb_to_recordset(p_duplicate_links) as link(duplicate_id uuid, canonical_id uuid)
  where duplicate.id = link.duplicate_id
    and duplicate.duplicate_of_id is null
    and duplicate.id <> link.canonical_id
    and exists (
      select 1
      from brands
      join brand_catalogue_products as canonical
        on canonical.id = link.canonical_id
       and canonical.brand_id = duplicate.brand_id
       and canonical.duplicate_of_id is null
       and not exists (
         select 1
         from brand_catalogue_products as child
         where child.duplicate_of_id = canonical.id
       )
      where brands.id = duplicate.brand_id
        and brands.project_id = p_project_id
    );
  get diagnostics archived_duplicates = row_count;
  if archived_duplicates <> expected_duplicates then
    raise exception 'One or more duplicate records no longer match this project.';
  end if;

  if expected_restores > 0 then
    update brand_catalogue_products as product
    set duplicate_of_id = null
    where product.id = any(p_restore_ids)
      and product.duplicate_of_id is not null
      and exists (
        select 1 from brands
        where brands.id = product.brand_id and brands.project_id = p_project_id
      );
    get diagnostics restored_duplicates = row_count;
    if restored_duplicates <> expected_restores then
      raise exception 'One or more archived records could not be restored.';
    end if;
  end if;

  return jsonb_build_object(
    'updatedCategories', updated_categories,
    'archivedDuplicates', archived_duplicates,
    'restoredDuplicates', restored_duplicates
  );
end;
$$;

revoke all on function apply_brand_catalogue_reconciliation(uuid, jsonb, jsonb, uuid[]) from public;
grant execute on function apply_brand_catalogue_reconciliation(uuid, jsonb, jsonb, uuid[]) to service_role;
