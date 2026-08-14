-- The AI registry: what features exist, what models they may call, what the
-- platform allows, and which prompt produced a given answer.
--
-- Phase 0 of docs/ai-architecture.md. Nothing here refuses anything yet — the
-- gates arrive in 20260814100300 and the budgets they read in ...100200. This
-- file is the configuration those two will consult, installed first so that a
-- month of recording can happen before anything starts saying no.
--
-- Features are rows rather than an enum for one reason: the platform control
-- that matters most is "turn this one off", and a deploy is not an incident
-- response. lib/ai/features.ts mirrors the keys for typing, the same way
-- lib/apps.ts mirrors app_slug.

-- Present in production from the original core migrations, absent from
-- tests/baseline.sql. Recreated idempotently so this file applies to both.
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── Features ────────────────────────────────────────────────────────────────

create table public.ai_features (
  key            text primary key,
  app            app_slug not null,
  name           text not null,
  enabled        boolean not null default true,

  -- The worst case for one call, in completion tokens. Reserved against the
  -- budget before the call happens, so this is a cost control and not only a
  -- length one. lib/ai clamps every request to it.
  max_tokens     integer not null check (max_tokens between 1 and 8000),

  -- The lowest role that may run it. 'anon' means nothing on its own: a
  -- workspace must also set allow_anon, and be public. Two independent
  -- switches, because a feature strangers can run is the one that needs two.
  min_role       text not null default 'owner'
                 check (min_role in ('anon', 'viewer', 'editor', 'owner')),

  -- Bound per feature. Classification and prose have different requirements
  -- and should not share a model because the registry had one column for it.
  provider       text not null default 'minimax',
  model          text not null default 'minimax-m3',

  -- Defaults for a job of this feature, copied onto the job at admission so
  -- that raising a default does not retroactively widen a job already running.
  default_max_usd   numeric(10,6) not null default 0.100000
                    check (default_max_usd > 0),
  default_max_calls integer not null default 1 check (default_max_calls > 0),
  max_depth         integer not null default 0 check (max_depth between 0 and 4),

  -- The quality floor and the mark left when it trips. Null disables the
  -- check. A feature switched off by its own failure rate has to report
  -- differently from one an admin turned off: the useful next action is a
  -- prompt rollback, not a re-enable.
  quality_floor    numeric check (quality_floor > 0 and quality_floor <= 1),
  auto_disabled_at timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on column public.ai_features.max_depth is
  'How far this feature may fan out. 0 means it may not spawn child jobs at all, which is the right default: a feature that has never needed to recurse should not be able to.';

-- ── Platform settings ───────────────────────────────────────────────────────

-- One row, and the primary key is what guarantees it. Two sets of platform
-- settings disagreeing is not a state worth being able to reach.
create table public.ai_platform_settings (
  id                     boolean primary key default true check (id),

  -- The kill switch. Refuses new jobs and the next call of a running one; it
  -- does not interrupt a call in flight, because those tokens are already
  -- being paid for.
  enabled                boolean not null default true,

  -- Admission pause: running jobs drain, new ones are refused. A softer
  -- instrument than the switch above, and an incident usually wants this one.
  admissions_open        boolean not null default true,

  -- Applied to a payer whose budget row leaves monthly_usd null.
  default_monthly_usd    numeric(10,4) not null default 5.0000
                         check (default_monthly_usd >= 0),

  -- The blunt limits, per actor. They catch a loop in a page before any
  -- per-feature ceiling notices.
  actor_rate_per_minute  integer not null default 20 check (actor_rate_per_minute > 0),
  anon_rate_per_hour     integer not null default 6 check (anon_rate_per_hour > 0),

  -- No single job may reserve more than this share of what the payer has left,
  -- so the first large batch of the month cannot lock its owner out of their
  -- own account until it finishes.
  max_job_share          numeric(4,3) not null default 0.500
                         check (max_job_share > 0 and max_job_share <= 1),

  updated_at             timestamptz not null default now()
);

insert into public.ai_platform_settings (id) values (true);

-- ── Models and prices ───────────────────────────────────────────────────────

-- Prices are data, versioned by effective_from rather than updated in place: a
-- report over August has to value August's calls at August's prices. The row
-- that applied is also snapshotted onto the call itself, so this table is what
-- a new call reads and what the admin page edits — never what a report joins to.
create table public.ai_models (
  provider                text not null,
  model                   text not null,
  prompt_usd_per_mtok     numeric(10,4) not null check (prompt_usd_per_mtok >= 0),
  completion_usd_per_mtok numeric(10,4) not null check (completion_usd_per_mtok >= 0),
  effective_from          timestamptz not null default now(),
  allowed                 boolean not null default true,
  notes                   text not null default '',
  primary key (provider, model, effective_from)
);

-- PLACEHOLDER PRICES. These are the shape, not the figures: check them against
-- MiniMax's current price list before phase 1 turns budgets on, because every
-- refusal downstream is computed from them. A wrong price here does not fail
-- loudly — it quietly makes every limit the wrong size.
insert into public.ai_models
  (provider, model, prompt_usd_per_mtok, completion_usd_per_mtok, notes)
values
  ('minimax', 'minimax-m3', 0.3000, 1.2000, 'placeholder — verify before enforcement');

-- ── Prompt versions ─────────────────────────────────────────────────────────

-- A prompt is a deployable artefact. Without a version on every call, a report
-- spanning a prompt change compares two different systems and says nothing
-- about either.
--
-- The body stays in code, where it is edited; this table records what was
-- actually sent, hashed. If the two ever disagree, this one is right.
create table public.ai_prompt_versions (
  id          integer generated always as identity primary key,
  feature     text not null references public.ai_features(key) on delete cascade,
  version     integer not null,
  hash        text not null,
  body        text not null,
  active      boolean not null default false,
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  unique (feature, version),
  unique (feature, hash)
);

-- Only one active version per feature, enforced rather than remembered.
create unique index ai_prompt_versions_one_active
  on public.ai_prompt_versions (feature) where active;

-- ── Row-level security ──────────────────────────────────────────────────────

alter table public.ai_features          enable row level security;
alter table public.ai_platform_settings enable row level security;
alter table public.ai_models            enable row level security;
alter table public.ai_prompt_versions   enable row level security;

-- Supabase's default privileges hand new tables full DML to anon and
-- authenticated. Configuration is not user-writable.
revoke all on public.ai_features          from anon, authenticated;
revoke all on public.ai_platform_settings from anon, authenticated;
revoke all on public.ai_models            from anon, authenticated;
revoke all on public.ai_prompt_versions   from anon, authenticated;

-- Readable by everyone, including anon: a page decides whether to render a
-- button from these, and an anonymous visitor on a public archive is a
-- supported case rather than an error to guard against.
grant select on public.ai_features to anon, authenticated;
grant select on public.ai_models   to anon, authenticated;
grant select on public.ai_platform_settings to anon, authenticated;

create policy ai_features_read on public.ai_features for select using (true);
create policy ai_models_read   on public.ai_models   for select using (true);
create policy ai_platform_settings_read on public.ai_platform_settings
  for select using (true);

-- Writable by platform admins through the page, which is why these are
-- policies rather than service_role-only.
grant insert, update, delete on public.ai_features to authenticated;
grant insert, update, delete on public.ai_models to authenticated;
grant update on public.ai_platform_settings to authenticated;

create policy ai_features_write on public.ai_features
  for all using (app.is_platform_admin()) with check (app.is_platform_admin());
create policy ai_models_write on public.ai_models
  for all using (app.is_platform_admin()) with check (app.is_platform_admin());
create policy ai_platform_settings_write on public.ai_platform_settings
  for update using (app.is_platform_admin()) with check (app.is_platform_admin());

-- Prompt bodies are not public. The app does not need to read them — it holds
-- them in code and registers them by hash — so nothing is lost by keeping the
-- table to admins, and a feature's rules stop being readable by anyone who can
-- reach the API.
grant select on public.ai_prompt_versions to authenticated;
create policy ai_prompt_versions_read on public.ai_prompt_versions
  for select using (app.is_platform_admin());

-- Rolling back to an earlier version is an admin action and the only write
-- offered here; new versions arrive through ai_register_prompt().
grant update (active, notes) on public.ai_prompt_versions to authenticated;
create policy ai_prompt_versions_write on public.ai_prompt_versions
  for update using (app.is_platform_admin()) with check (app.is_platform_admin());

create trigger touch_ai_features before update on public.ai_features
  for each row execute function public.touch_updated_at();
create trigger touch_ai_platform_settings before update on public.ai_platform_settings
  for each row execute function public.touch_updated_at();

-- ── Registering a prompt ────────────────────────────────────────────────────

-- Called by lib/ai with the body it is about to send. A hash it has seen
-- before returns the existing id; a new one inserts a version and becomes
-- active if nothing else is.
--
-- SECURITY DEFINER because the table is admin-readable and this is how a
-- non-admin owner's own sitting gets a version recorded against it. The cap is
-- what stops that being an unbounded write: a feature accumulating 200
-- versions is a bug or an abuse, and either way the answer is to stop.
create function public.ai_register_prompt(p_feature text, p_body text)
returns integer
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  -- md5 rather than sha256 so this needs no extension in the search path. The
  -- hash is an identity for deduplication, not a security claim — nobody is
  -- being kept out by it, and a collision between two prompts we wrote is not
  -- a threat model.
  v_hash text := md5(p_body);
  v_id   integer;
  v_next integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select id into v_id from public.ai_prompt_versions
   where feature = p_feature and hash = v_hash;
  if found then return v_id; end if;

  select coalesce(max(version), 0) + 1 into v_next
    from public.ai_prompt_versions where feature = p_feature;

  if v_next > 200 then
    raise exception 'too many prompt versions for %', p_feature using errcode = 'GRK1A';
  end if;

  insert into public.ai_prompt_versions (feature, version, hash, body, active)
  values (
    p_feature, v_next, v_hash, p_body,
    not exists (select 1 from public.ai_prompt_versions
                 where feature = p_feature and active)
  )
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.ai_register_prompt(text, text) from public;
grant execute on function public.ai_register_prompt(text, text) to authenticated;

-- ── Seed: the features that exist today ─────────────────────────────────────

-- The desk and its write-up, described exactly as they already behave. Nothing
-- about WBPR changes when this lands; it only becomes describable.
insert into public.ai_features
  (key, app, name, max_tokens, min_role, default_max_usd, default_max_calls, quality_floor)
values
  ('wbpr.desk',    'wbpr', 'The desk',       700,  'owner', 0.200000, 40, 0.10),
  ('wbpr.writeup', 'wbpr', 'The write-up',   2000, 'owner', 0.050000,  1, 0.20);
