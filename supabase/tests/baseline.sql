-- Local reconstruction of the live `grackles` Supabase schema as of migration
-- 20260731103318_smoke_from_humidor, plus minimal Supabase platform stubs
-- (auth.uid(), auth.jwt(), and the anon/authenticated/service_role roles).
--
-- This exists so the migrations in ../migrations can be applied and exercised
-- against the real schema shape without touching the hosted project. It is NOT
-- the source of truth for the live schema and is not applied to it.
--
-- Run this against a throwaway cluster only — never a Supabase instance.

-- citext goes in `extensions`, as it does on Supabase — not `public`, which is
-- where a bare CREATE EXTENSION would put it. The difference is not cosmetic:
-- a SECURITY DEFINER function whose search_path omits `extensions` cannot
-- resolve the type when its body is validated, so a migration that passes
-- against a public-schema citext still fails in production.
create schema if not exists extensions;
create extension if not exists citext with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- Ordinary sessions see `extensions`, as they do on Supabase, so plain DDL can
-- name citext. A function with its own `SET search_path` does not inherit this
-- — which is the asymmetry the harness exists to reproduce. Set for the
-- database as well as this session, so the migrations and tests that follow in
-- separate psql sessions get it too.
set search_path = public, extensions;
do $$
begin
  execute format('alter database %I set search_path to public, extensions', current_database());
end
$$;

-- Roles are cluster-wide, so they may already exist from an earlier run.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;
grant usage on schema public to anon, authenticated, service_role;

create schema auth;
create table auth.users (
  id    uuid primary key,
  email citext not null
);

-- Supabase resolves these from the request JWT; here from a session GUC.
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;

create schema app;
grant usage on schema app to anon, authenticated, service_role;

create type member_role as enum ('owner', 'editor', 'viewer');
create type app_slug   as enum ('listening-party', 'reading-list', 'cigar-lounge');
create type visibility as enum ('private', 'unlisted', 'public');

-- ── tables ──────────────────────────────────────────────────────────────────

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        citext not null,
  display_name text not null default '',
  avatar_url   text,
  created_at   timestamptz not null default now()
);

create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  app         app_slug not null,
  slug        text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text not null check (name <> ''),
  description text not null default '',
  visibility  visibility not null default 'private',
  owner_id    uuid not null references public.profiles (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (app, slug)
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  role         member_role not null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.workspace_invites (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email        citext not null,
  role         member_role not null default 'viewer',
  token        text not null unique default (replace(gen_random_uuid()::text, '-', '')
                                          || replace(gen_random_uuid()::text, '-', '')),
  invited_by   uuid not null references public.profiles (id),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '14 days'),
  accepted_at  timestamptz,
  accepted_by  uuid references public.profiles (id)
);

-- One pending invitation per address per workspace. The settings page catches
-- the 23505 from this to report a duplicate rather than a failure.
create unique index workspace_invites_pending_idx
  on public.workspace_invites (workspace_id, email)
  where accepted_at is null;

create table public.cl_cigars (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  slug         text not null check (slug <> ''),
  status       text not null default 'smoked' check (status in ('humidor', 'smoked')),
  quantity     integer not null default 1 check (quantity > 0),
  name         text not null check (name <> ''),
  photo_path   text not null default '',
  unique (workspace_id, slug)
);

create table public.rl_years (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  year         integer not null,
  status       text not null default 'active' check (status in ('active', 'complete')),
  total_books  integer,
  created_at   timestamptz not null default now(),
  unique (workspace_id, year)
);

create table public.rl_books (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  year_id      uuid not null references public.rl_years (id) on delete cascade,
  order_read   integer not null check (order_read >= 1),
  title        text not null check (title <> ''),
  unique (year_id, order_read)
);

create table public.rl_publisher_aliases (
  alias     text primary key,
  canonical text
);

create table public.lp_contributors (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  slug         text not null check (slug <> ''),
  name         text not null check (name <> ''),
  color        text not null check (color <> ''),
  user_id      uuid references public.profiles (id),
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table public.lp_seasons (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  slug         text not null check (slug <> ''),
  title        text not null check (title <> ''),
  total_weeks  integer not null check (total_weeks >= 1),
  unique (workspace_id, slug)
);

create table public.lp_season_contributors (
  season_id      uuid not null references public.lp_seasons (id) on delete cascade,
  contributor_id uuid not null references public.lp_contributors (id) on delete cascade,
  sort_order     integer not null default 0,
  primary key (season_id, contributor_id)
);

create table public.lp_selections (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  season_id      uuid not null references public.lp_seasons (id) on delete cascade,
  contributor_id uuid not null references public.lp_contributors (id) on delete cascade,
  week           integer not null check (week >= 1),
  year_slot      integer not null,
  album          text not null default '',
  artist         text not null default '',
  status         text not null check (status in ('completed', 'upcoming')),
  unique (season_id, week, contributor_id)
);

-- ── helpers ─────────────────────────────────────────────────────────────────

create function app.workspace_role(ws uuid) returns member_role
language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.workspace_members
  where workspace_id = ws and user_id = auth.uid()
$$;

create function app.can_read(ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = ws and w.visibility in ('public', 'unlisted')
  ) or app.workspace_role(ws) is not null
$$;

create function app.can_write(ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(app.workspace_role(ws) in ('owner', 'editor'), false)
$$;

create function app.is_owner(ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(app.workspace_role(ws) = 'owner', false)
$$;

create function app.shares_workspace_with(other uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = auth.uid() and theirs.user_id = other
  )
$$;

create function public.handle_new_workspace() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (workspace_id, user_id) do update set role = 'owner';
  return new;
end;
$$;
create trigger workspaces_add_owner after insert on public.workspaces
  for each row execute function public.handle_new_workspace();

-- Production's copy of this has `search_path = public, pg_temp`, which cannot
-- resolve citext and so fails to compile the moment it is called — the invite
-- that had been sitting unaccepted since July was hitting exactly this. It is
-- given a working path here because the harness needs the starting shape to
-- exist in order to test replacing it; 20260805120300 drops it either way.
create function public.accept_invite(invite_token text) returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  inv      public.workspace_invites;
  me       uuid := auth.uid();
  my_email citext;
begin
  if me is null then
    raise exception 'you must be signed in to accept an invite';
  end if;
  select email into my_email from public.profiles where id = me;

  select * into inv from public.workspace_invites
  where token = invite_token and accepted_at is null and expires_at > now();

  if not found then
    raise exception 'that invite is invalid, expired, or already used';
  end if;
  if inv.email <> my_email then
    raise exception 'that invite was issued to a different email address';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (inv.workspace_id, me, inv.role)
  on conflict (workspace_id, user_id) do nothing;

  update public.workspace_invites
  set accepted_at = now(), accepted_by = me
  where id = inv.id;

  return inv.workspace_id;
end;
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table public.profiles               enable row level security;
alter table public.workspaces             enable row level security;
alter table public.workspace_members      enable row level security;
alter table public.workspace_invites      enable row level security;
alter table public.cl_cigars              enable row level security;
alter table public.rl_years               enable row level security;
alter table public.rl_books               enable row level security;
alter table public.rl_publisher_aliases   enable row level security;
alter table public.lp_contributors        enable row level security;
alter table public.lp_seasons             enable row level security;
alter table public.lp_season_contributors enable row level security;
alter table public.lp_selections          enable row level security;

create policy profiles_read on public.profiles for select
  using (id = auth.uid() or app.shares_workspace_with(id));
create policy profiles_update_self on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

create policy workspaces_read on public.workspaces for select
  using (visibility in ('public', 'unlisted') or app.workspace_role(id) is not null);
create policy workspaces_insert on public.workspaces for insert
  with check (owner_id = auth.uid());
create policy workspaces_update on public.workspaces for update
  using (app.is_owner(id)) with check (app.is_owner(id));
create policy workspaces_delete on public.workspaces for delete
  using (app.is_owner(id));

create policy members_read on public.workspace_members for select
  using (user_id = auth.uid() or app.workspace_role(workspace_id) is not null);
create policy members_manage on public.workspace_members for all
  using (app.is_owner(workspace_id)) with check (app.is_owner(workspace_id));

create policy invites_read on public.workspace_invites for select
  using (app.is_owner(workspace_id)
         or email = (select p.email from public.profiles p where p.id = auth.uid()));
create policy invites_manage on public.workspace_invites for all
  using (app.is_owner(workspace_id))
  with check (app.is_owner(workspace_id) and invited_by = auth.uid());

create policy cl_cigars_read   on public.cl_cigars for select using (app.can_read(workspace_id));
create policy cl_cigars_insert on public.cl_cigars for insert with check (app.can_write(workspace_id));
create policy cl_cigars_update on public.cl_cigars for update using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy cl_cigars_delete on public.cl_cigars for delete using (app.can_write(workspace_id));

create policy rl_years_read   on public.rl_years for select using (app.can_read(workspace_id));
create policy rl_years_insert on public.rl_years for insert with check (app.can_write(workspace_id));
create policy rl_years_update on public.rl_years for update using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy rl_years_delete on public.rl_years for delete using (app.can_write(workspace_id));

create policy rl_books_read   on public.rl_books for select using (app.can_read(workspace_id));
create policy rl_books_insert on public.rl_books for insert with check (app.can_write(workspace_id));
create policy rl_books_update on public.rl_books for update using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy rl_books_delete on public.rl_books for delete using (app.can_write(workspace_id));

create policy rl_publisher_aliases_read on public.rl_publisher_aliases for select using (true);

create policy lp_contributors_read   on public.lp_contributors for select using (app.can_read(workspace_id));
create policy lp_contributors_insert on public.lp_contributors for insert with check (app.can_write(workspace_id));
create policy lp_contributors_update on public.lp_contributors for update using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy lp_contributors_delete on public.lp_contributors for delete using (app.can_write(workspace_id));

create policy lp_seasons_read   on public.lp_seasons for select using (app.can_read(workspace_id));
create policy lp_seasons_insert on public.lp_seasons for insert with check (app.can_write(workspace_id));
create policy lp_seasons_update on public.lp_seasons for update using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy lp_seasons_delete on public.lp_seasons for delete using (app.can_write(workspace_id));

create policy lp_season_contributors_read on public.lp_season_contributors for select
  using (exists (select 1 from public.lp_seasons s where s.id = season_id and app.can_read(s.workspace_id)));
create policy lp_season_contributors_write on public.lp_season_contributors for all
  using (exists (select 1 from public.lp_seasons s where s.id = season_id and app.can_write(s.workspace_id)))
  with check (exists (select 1 from public.lp_seasons s where s.id = season_id and app.can_write(s.workspace_id)));

create policy lp_selections_read   on public.lp_selections for select using (app.can_read(workspace_id));
create policy lp_selections_insert on public.lp_selections for insert with check (app.can_write(workspace_id));
create policy lp_selections_update on public.lp_selections for update using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy lp_selections_delete on public.lp_selections for delete using (app.can_write(workspace_id));

-- ── grants (mirrors the live project: anon and authenticated hold full DML) ──

grant all on all tables in schema public to anon, authenticated, service_role;
grant execute on function app.can_read(uuid), app.can_write(uuid), app.is_owner(uuid),
                          app.workspace_role(uuid), app.shares_workspace_with(uuid)
  to anon, authenticated;
revoke all on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated, service_role;

-- ── seed: mirrors current production data ───────────────────────────────────

insert into auth.users (id, email) values
  ('1d34b078-bfad-41a7-a32f-3bf39f91f2a6', 'alexander.jameswatts@gmail.com');
insert into public.profiles (id, email, display_name) values
  ('1d34b078-bfad-41a7-a32f-3bf39f91f2a6', 'alexander.jameswatts@gmail.com', 'Jamie');

insert into public.workspaces (id, app, slug, name, visibility, owner_id) values
  ('1b1893ef-e69c-4833-b8d4-640b60d2c791', 'listening-party', 'brothers', 'Listening Party', 'public',  '1d34b078-bfad-41a7-a32f-3bf39f91f2a6'),
  ('2faab0b7-59b1-4616-bba5-47b564925268', 'cigar-lounge',    'jamie',    'Cigar Lounge',    'private', '1d34b078-bfad-41a7-a32f-3bf39f91f2a6'),
  ('f569c7a7-3666-487a-88f8-1f665d803e31', 'reading-list',    'jamie',    'Reading List',    'public',  '1d34b078-bfad-41a7-a32f-3bf39f91f2a6');

insert into public.workspace_invites (workspace_id, email, role, invited_by) values
  ('1b1893ef-e69c-4833-b8d4-640b60d2c791', 'jamie.watts@mysoftx3.com', 'viewer', '1d34b078-bfad-41a7-a32f-3bf39f91f2a6');
