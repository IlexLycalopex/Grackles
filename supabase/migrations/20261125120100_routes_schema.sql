-- Routes: the long route planner, phase 1.
--
-- A route is an uploaded GPX reduced to one resampled series; a plan is a way
-- of cutting that route into days. One route, many plans: a five-day and a
-- seven-day plan can share an upload.
--
-- Three decisions, before the tables:
--
-- 1. Breaks are distances, not coordinates. A plan survives a replaced GPX of
--    similar length; breaks too near or past the new finish are dropped by the
--    app, which says so. breaks_m is the end of every stage but the last, in
--    metres along the track, ascending and at least 1 km apart.
--
-- 2. The profile is stored, not the file. `profile` holds the resampled series
--    as {"step": 25, "d": [...], "e": [...], "lat": [...], "lon": [...]},
--    already smoothed. That is everything the planner draws and every figure it
--    shows, about 450 KB for 285 km. The original GPX never leaves the browser,
--    which keeps phase 1 out of object storage altogether.
--
-- 3. Scoped to the workspace like every other app here, not to a user: the
--    workspace decides who may read and write, through app.can_read() and
--    app.can_write(), so a shared planning project works the day it is shared.

-- ── Rules the constraints call ──────────────────────────────────────
-- Ascending, positive, and never closer than 1 km. The finish is not known
-- here, so "1 km before the finish" is the app's to keep; the trigger below
-- checks it against the route.
create function app.rt_breaks_ok(b integer[]) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce((
    select bool_and(x >= 1000 and (prev is null or x - prev >= 1000))
    from (select x, lag(x) over (order by i) as prev from unnest(b) with ordinality as t(x, i)) s
  ), true)
$$;

-- ── Routes ──────────────────────────────────────────────────────────
create table public.rt_routes (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  created_by       uuid references auth.users(id) on delete set null default auth.uid(),
  name             text not null,
  source_filename  text not null default '',
  total_distance_m integer not null,
  total_ascent_m   integer,
  total_descent_m  integer,
  max_elevation_m  integer,
  has_elevation    boolean not null,
  profile          jsonb not null,
  created_at       timestamptz not null default now(),

  constraint rt_routes_name     check (char_length(btrim(name)) between 1 and 200),
  constraint rt_routes_filename check (char_length(source_filename) <= 300),
  constraint rt_routes_distance check (total_distance_m > 0 and total_distance_m <= 5000000),
  constraint rt_routes_profile  check (jsonb_typeof(profile) = 'object' and pg_column_size(profile) < 8000000),
  -- What the composite key on rt_plans points at, so a plan can never sit in
  -- one workspace on a route that belongs to another.
  unique (id, workspace_id)
);

create index rt_routes_workspace_idx on public.rt_routes (workspace_id);

-- ── Plans ───────────────────────────────────────────────────────────
create table public.rt_plans (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  route_id         uuid not null,
  created_by       uuid references auth.users(id) on delete set null default auth.uid(),
  name             text not null,
  pace_s_per_km    integer not null default 420,
  climb_allowance  boolean not null default true,
  breaks_m         integer[] not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,

  foreign key (route_id, workspace_id) references public.rt_routes (id, workspace_id) on delete cascade,
  constraint rt_plans_name   check (char_length(btrim(name)) between 1 and 200),
  constraint rt_plans_pace   check (pace_s_per_km between 120 and 1800),
  -- Twenty stages at most, so nineteen breaks.
  constraint rt_plans_breaks check (cardinality(breaks_m) <= 19 and app.rt_breaks_ok(breaks_m))
);

create index rt_plans_workspace_idx on public.rt_plans (workspace_id, updated_at desc) where deleted_at is null;
create index rt_plans_route_idx on public.rt_plans (route_id);

create trigger touch_rt_plans before update on public.rt_plans
  for each row execute function public.touch_updated_at();

-- The last break must leave at least 1 km to the finish. Definer, because the
-- route is read whatever the caller's grants on it.
create function app.rt_plan_fits_route() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  total integer;
begin
  select r.total_distance_m into total from public.rt_routes r where r.id = new.route_id;
  if cardinality(new.breaks_m) > 0 and new.breaks_m[cardinality(new.breaks_m)] > total - 1000 then
    raise exception 'The last day must be at least 1 km long'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger rt_plans_fit before insert or update of breaks_m, route_id on public.rt_plans
  for each row execute function app.rt_plan_fits_route();

-- ── Privileges ──────────────────────────────────────────────────────
-- Anyone who can read the workspace reads; owners and editors write. Nothing is
-- readable anonymously unless the workspace is public, which app.can_read()
-- already decides. Routes are never updated: a replaced GPX is a new route.
revoke all on public.rt_routes, public.rt_plans from public, anon, authenticated;
grant select on public.rt_routes, public.rt_plans to anon, authenticated;
grant insert, delete on public.rt_routes to authenticated;
grant insert, update, delete on public.rt_plans to authenticated;
grant select, insert, update, delete on public.rt_routes, public.rt_plans to service_role;

revoke all on function app.rt_breaks_ok(integer[]) from public;
grant execute on function app.rt_breaks_ok(integer[]) to anon, authenticated, service_role;
revoke all on function app.rt_plan_fits_route() from public, anon, authenticated;

alter table public.rt_routes enable row level security;
alter table public.rt_plans  enable row level security;

create policy rt_routes_read   on public.rt_routes for select using (app.can_read(workspace_id));
create policy rt_routes_insert on public.rt_routes for insert with check (app.can_write(workspace_id));
create policy rt_routes_delete on public.rt_routes for delete using (app.can_write(workspace_id));

create policy rt_plans_read   on public.rt_plans for select using (app.can_read(workspace_id));
create policy rt_plans_insert on public.rt_plans for insert with check (app.can_write(workspace_id));
create policy rt_plans_update on public.rt_plans for update
  using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy rt_plans_delete on public.rt_plans for delete using (app.can_write(workspace_id));
