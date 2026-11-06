-- LatAm: articles finished in Instapaper count as reading.
--
-- The latam-instapaper-sync Edge Function reads the account through
-- Instapaper's full API and writes `article` entries with source
-- 'instapaper'. Only articles read to nine tenths count, and only those in
-- Spanish or about Argentina; the rest are remembered and ignored. Minutes
-- are estimated from length (200 words a minute, 120 for Spanish) and the
-- entry says so.
--
-- A project opts in on its setup page (instapaper_sync); the account itself
-- is the deployment's, in function secrets, never a row.

alter table public.lx_settings add column instapaper_sync boolean not null default false;
grant update (instapaper_sync) on public.lx_settings to authenticated;

alter table public.lx_activities drop constraint lx_activities_source;
alter table public.lx_activities add constraint lx_activities_source
  check (source in ('phone', 'web', 'duolingo', 'strava', 'instapaper'));

alter table public.lx_sync_runs drop constraint lx_sync_runs_source_check;
alter table public.lx_sync_runs add constraint lx_sync_runs_source_check
  check (source in ('duolingo', 'strava', 'instapaper'));

-- Every bookmark the sync has decided about, counted or not, so an article's
-- text is fetched once and an ignored one is not reconsidered nightly.
create table public.lx_instapaper_seen (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  bookmark_id  bigint not null,
  counted      boolean not null,
  reason       text not null default '',
  seen_at      timestamptz not null default now(),
  primary key (workspace_id, bookmark_id)
);

revoke all on public.lx_instapaper_seen from anon, authenticated;
grant select on public.lx_instapaper_seen to authenticated;
grant select, insert, update, delete on public.lx_instapaper_seen to service_role;
alter table public.lx_instapaper_seen enable row level security;
create policy lx_instapaper_seen_read on public.lx_instapaper_seen for select using (app.can_write(workspace_id));
