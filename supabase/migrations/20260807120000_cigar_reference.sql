-- Looking a cigar up.
--
-- One table, and it is global rather than workspace-scoped. The dimensions of
-- a Partagás Serie D No. 4 are a fact about the world, not about a lounge, so
-- scoping them per workspace would mean paying for the same answer once per
-- member. Shared, the second person to look one up pays nothing and an active
-- lounge trends toward free — which is the whole cost argument for the feature.
--
-- What it holds is claims, not authority. Every row is what a language model
-- said when asked, and the app displays it as a suggestion until a human has
-- accepted it into an entry. `workspace_id` and `looked_up_by` record who asked
-- and who paid, so a row that turns out to be wrong can be traced rather than
-- merely deleted.
--
-- Deliberately absent: any rating, score or price. An earlier draft carried a
-- Cigar Aficionado score, and it is the one thing a model will confabulate with
-- a straight face and a real magazine's name attached. Dimensions, wrapper,
-- origin and flavour profile are what M3 is actually reliable on and are most
-- of what makes quick-add worth having.

create table public.cl_cigar_reference (
  id           uuid primary key default gen_random_uuid(),

  -- Canonical brand + name + ring gauge, derived from the *answer* rather than
  -- from the question. Two people typing "partagas serie d 4" and "Partagás
  -- Serie D No.4" have asked about one cigar and must land on one row.
  key          text not null unique check (key <> ''),

  -- What was actually typed, kept because it is the only record of how people
  -- ask for things and the only way to tell a bad answer from a bad question.
  query        text not null default '',

  brand        text not null default '',
  line         text not null default '',
  name         text not null default '',
  vitola       text not null default '',

  -- Decimal inches, not the `4 7/8"` that cl_cigars.length_text keeps. That
  -- column is the honest record of what the box says; this one exists to be
  -- compared against a `5x50` typed into a search box.
  length_inches numeric check (length_inches is null or length_inches between 1 and 12),
  ring_gauge   integer check (ring_gauge is null or ring_gauge between 20 and 90),

  wrapper      text not null default '',
  binder       text not null default '',
  filler       text not null default '',
  country      text not null default '',
  factory      text not null default '',
  strength     text check (strength is null or strength in ('mild', 'medium', 'full')),
  flavour      text not null default '',

  -- The model's own account of how well it knows this cigar. Displayed, and
  -- never used to decide anything on its own — a confident wrong answer and a
  -- hesitant right one look identical from here.
  confidence   text not null default 'low' check (confidence in ('high', 'medium', 'low')),

  -- Up to two other cigars the query might have meant, by name only. Names are
  -- enough to offer as a second lookup, and a second lookup usually hits this
  -- table rather than the model.
  alternates   text[] not null default '{}',

  model        text not null default '',
  prompt_tokens     integer not null default 0,
  completion_tokens integer not null default 0,

  -- Which lounge paid for it, and who pressed the button. Attribution, not
  -- scope: every signed-in reader sees every row.
  workspace_id uuid references public.workspaces (id) on delete set null,
  looked_up_by uuid not null references public.profiles (id),
  created_at   timestamptz not null default now()
);

-- The daily cap counts rows by workspace and time, and the RLS policy below
-- runs that count on every insert.
create index cl_cigar_reference_workspace_idx
  on public.cl_cigar_reference (workspace_id, created_at desc);

-- Cache lookup narrows on brand, name or line before the matcher in
-- `lib/cigar-search.ts` ranks what comes back. `gin_trgm_ops` would serve the
-- leading-wildcard ilike better, but pg_trgm is not installed and a table this
-- size does not need it yet — revisit at a few thousand rows.
create index cl_cigar_reference_brand_idx on public.cl_cigar_reference (lower(brand));
create index cl_cigar_reference_name_idx  on public.cl_cigar_reference (lower(name));

alter table public.cl_cigar_reference enable row level security;

-- Readable by anyone signed in, including members of a workspace that never
-- looked anything up. That is the sharing that makes the cache worth having.
-- `(select auth.uid())` rather than a bare call, here and below: Postgres
-- re-evaluates the bare form once per row, and Supabase's linter flags every
-- policy that uses it. The older policies in this project have the same fault
-- and are noted in supabase/README.md as worth a sweep; new ones do not need to
-- join them.
create policy cl_cigar_reference_read on public.cl_cigar_reference
  for select using ((select auth.uid()) is not null);

-- Insert carries the whole gate, and it carries it here rather than only in the
-- API route. A route check protects the button; this decides what the database
-- will accept from anyone holding the publishable key and a session.
--
-- Three conditions:
--   * the row is attributed to the person inserting it — you cannot spend in
--     someone else's name;
--   * they can write to the workspace they are charging it to. Not is_owner(),
--     which is what the WBPR agent uses: a night at the desk is an open-ended
--     spend and the owner's decision, whereas a lookup is one small bounded
--     call and an editor who cannot use quick-add has been given a feature
--     that does not work for them. The cap below is what makes that defensible;
--   * that workspace has not already had 50 lookups in the last day.
create policy cl_cigar_reference_insert on public.cl_cigar_reference
  for insert with check (
    looked_up_by = (select auth.uid())
    and workspace_id is not null
    and app.can_write(workspace_id)
    and (
      select count(*) from public.cl_cigar_reference r
      where r.workspace_id = cl_cigar_reference.workspace_id
        and r.created_at > now() - interval '1 day'
    ) < 50
  );

-- No update policy and no delete policy, so neither is possible for anyone but
-- a superuser. Insert-only is what makes a shared table safe enough to share:
-- one member cannot rewrite what another member's lookup found, only add
-- alongside it. Correcting a bad row is a deliberate administrative act, not
-- something the next person to search happens to do.
grant select, insert on public.cl_cigar_reference to authenticated;

-- Which reference row an entry was filled from, when it was filled from one.
-- The claims stay in their own table: this is a join, not a copy, so nothing a
-- model said is ever mistaken for something you wrote — and every claim it
-- ever made can be dropped in one statement.
alter table public.cl_cigars
  add column reference_id uuid references public.cl_cigar_reference (id) on delete set null;
