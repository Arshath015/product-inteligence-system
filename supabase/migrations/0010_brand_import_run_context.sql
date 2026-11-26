-- Persist project Brand Import batches alongside the existing resumable
-- Library import ledger so discovery, retries, and outcome counts survive
-- interrupted requests and page navigation.
alter table library_import_runs
  add column if not exists project_id uuid references projects(id) on delete set null;

alter table library_import_runs
  add column if not exists brand_id uuid references brands(id) on delete set null;

alter table library_import_runs
  add column if not exists failure_details jsonb not null default '{}'::jsonb;

create index if not exists library_import_runs_project_updated_idx
  on library_import_runs (project_id, updated_at desc);
