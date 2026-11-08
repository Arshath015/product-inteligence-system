-- Extends the project-reuse mechanism (see 0005_projects.sql) to inspirations:
-- a project_inspirations junction table mirrors project_products/project_brands,
-- letting a project reference another project's saved inspiration without
-- copying it or touching the source. Backfills a self-referencing row for
-- every existing inspiration so current data stays visible to its own project.

create table if not exists project_inspirations (
  project_id uuid not null references projects(id) on delete cascade,
  inspiration_id uuid not null references inspirations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, inspiration_id)
);
alter table project_inspirations enable row level security;
create index if not exists project_inspirations_inspiration_id_idx on project_inspirations(inspiration_id);
create index if not exists project_inspirations_project_id_idx on project_inspirations(project_id);

insert into project_inspirations (project_id, inspiration_id)
select project_id, id from inspirations
on conflict do nothing;

-- Re-point inspiration_count/last_activity at the junction so a referenced
-- (not just owned) inspiration counts toward the project it's visible in.
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
    (select count(*) from project_inspirations pi join inspirations i on i.id = pi.inspiration_id
       where pi.project_id = p_project_id and i.status = 'active') as inspiration_count,
    (select count(*) from conversations where project_id = p_project_id and status = 'active') as conversation_count,
    (select max(x.ts) from (
       select updated_at as ts from conversations where project_id = p_project_id
       union all
       select updated_at as ts from products p join project_products pp on pp.product_id = p.id where pp.project_id = p_project_id
       union all
       select i.created_at as ts from inspirations i join project_inspirations pi on pi.inspiration_id = i.id where pi.project_id = p_project_id
     ) x) as last_activity;
$$;
