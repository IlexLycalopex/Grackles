-- Looking a book up.
--
-- The Cigar Lounge's reference desk, ported, with one difference that changes
-- what the model is asked for. A cigar's dimensions are not in a free
-- catalogue; a book's are. So this is stage three of four, and the first three
-- stages are free:
--
--   0. your own library — and standing in a bookshop, the answer to "do I
--      already own this?" is the most valuable thing this feature does;
--   1. this table, shared across everybody;
--   2. OpenLibrary, then Google Books, which lib/book-lookup.ts already does;
--   3. one call to M3, on a button press, capped.
--
-- **The model's answer is a better query, not a better record.** It is asked to
-- identify — the canonical title, the author, the series, roughly when it came
-- out — and the app then re-queries OpenLibrary with that and takes the facts
-- from the catalogue. Which is why there is no column here for a page count or
-- a publisher, and why the one field it must never supply has no home at all.

create table public.rl_book_reference (
  id           uuid primary key default gen_random_uuid(),

  -- Canonical title + author, derived from the *answer* rather than from the
  -- question. Two people typing "the new cusk" and "Second Place" have asked
  -- about one book and must land on one row.
  key          text not null unique check (key <> ''),

  -- What was actually typed. The only record of how people ask for things, and
  -- the only way to tell a bad answer from a bad question.
  query        text not null default '',

  title        text not null default '',
  author       text not null default '',
  series       text not null default '',
  series_index numeric,

  -- Bounded because a plausible-looking wrong year is the failure mode, and
  -- these two bounds catch the ones that are wrong in a way arithmetic can see.
  year_published integer
    check (year_published is null or year_published between 1400 and 2100),

  -- The model's own account of how well it knows this book. Displayed, and
  -- never used to decide anything on its own: a confident wrong answer and a
  -- hesitant right one look identical from here.
  confidence   text not null default 'low' check (confidence in ('high', 'medium', 'low')),

  -- Up to two other books the query might have meant, by title only. A title is
  -- enough to offer as a second lookup, and a second lookup usually hits this
  -- table rather than the model.
  alternates   text[] not null default '{}',

  -- What OpenLibrary said when asked using the model's answer. The facts live
  -- here having come from the catalogue, never from the completion.
  isbn         text not null default '',
  pages        integer check (pages is null or pages between 1 and 20000),
  publisher    text not null default '',
  cover_url    text not null default '',
  link_openlibrary text not null default '',

  model        text not null default '',
  prompt_tokens     integer not null default 0,
  completion_tokens integer not null default 0,

  workspace_id uuid references public.workspaces (id) on delete set null,
  looked_up_by uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

-- Deliberately absent: any rating, review score, prize, sales figure or
-- attributed opinion. This is the Cigar Aficionado argument in a genre where it
-- is worse — M3 will produce "won the Booker in 2019" with a straight face, and
-- there is no column for one to land in.
--
-- Also absent, and this is the sharper rule: **the model never supplies an
-- ISBN.** It will produce a well-formed, checksum-valid, entirely fictional one
-- with no signal that it did, and that number would then be written into a
-- field that looks authoritative, used to search a catalogue, and possibly
-- typed into a shop. The isbn column above is filled from OpenLibrary or from a
-- barcode, never from a completion.

create index rl_book_reference_workspace_idx
  on public.rl_book_reference (workspace_id, created_at desc);
create index rl_book_reference_title_idx on public.rl_book_reference (lower(title));
create index rl_book_reference_author_idx on public.rl_book_reference (lower(author));

-- Which reference row an entry was filled from, when it was filled from one.
-- A join rather than a copy, so every claim the model has ever made about a
-- book stays in its own table and is deletable in one statement.
alter table public.rl_library
  add column reference_id uuid references public.rl_book_reference (id) on delete set null;

-- ── the cap ─────────────────────────────────────────────────────────────────

-- Written as a SECURITY DEFINER function from the start, rather than as a
-- correlated subquery inside the policy on the table it counts.
--
-- That is not a stylistic preference. `20260807120000` did it the obvious way
-- for cigars and got 42P17, infinite recursion: evaluating the WITH CHECK
-- requires reading the table, reading the table invokes its policies, and round
-- it goes. The effect was not a leaky cap but a table that refused every
-- insert, and it had been asserted to work in three places before anybody ran
-- it. This is that lesson, applied before rather than after.
create function app.book_lookups_today(ws uuid) returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.rl_book_reference
  where workspace_id = ws
    and created_at > now() - interval '1 day'
$$;

revoke all on function app.book_lookups_today(uuid) from public;
grant execute on function app.book_lookups_today(uuid) to authenticated;

-- ── access ──────────────────────────────────────────────────────────────────

alter table public.rl_book_reference enable row level security;

-- Readable by anyone signed in, including members of a project that never
-- looked anything up. That sharing is what makes the cache worth having.
create policy rl_book_reference_read on public.rl_book_reference
  for select using ((select auth.uid()) is not null);

-- Insert carries the whole gate, and it carries it here rather than only in the
-- API route: a route check protects the button, this decides what the database
-- will accept from anyone holding the publishable key and a session.
--
-- requireWrite rather than owner-only, on the cigar desk's argument: a lookup
-- is one small bounded call, and an editor who cannot use quick-add has been
-- given a feature that does not work for them. The cap is what makes the looser
-- gate defensible.
create policy rl_book_reference_insert on public.rl_book_reference
  for insert with check (
    looked_up_by = (select auth.uid())
    and workspace_id is not null
    and app.can_write(workspace_id)
    and app.book_lookups_today(workspace_id) < 50
  );

-- No update and no delete policy, so neither is possible for anyone but a
-- superuser. Insert-only is what makes a shared table safe enough to share: one
-- member cannot rewrite what another member's lookup found, only add alongside
-- it. This table is a cache of claims, never an authority.
grant select, insert on public.rl_book_reference to authenticated;

-- ── the feature ─────────────────────────────────────────────────────────────

insert into public.ai_features
  (key, app, name, max_tokens, min_role, provider, model,
   default_max_usd, default_max_calls, prompt_allowance_tokens, sends_records)
values
  ('reading.lookup', 'reading-list', 'Look a book up',
   -- The reply below measures around 90 completion tokens; 400 is the ceiling
   -- that keeps a runaway answer from being a runaway bill.
   400, 'editor', 'minimax', 'minimax-m3',
   -- One call, and a small one. The daily cap on the table is the real limit;
   -- this is the per-job ceiling that stops a single lookup running away.
   0.020000, 1, 1200,
   -- Nothing stored is sent. The whole of the user turn is what somebody just
   -- typed into a search box, which is why platform.search is registered the
   -- same way and needs no project's consent.
   false);

-- On for every Reading List that exists, at the feature's own defaults — the
-- same as reading.enrich did when it landed.
insert into public.ai_workspace_features (workspace_id, feature, enabled)
select w.id, 'reading.lookup', true
from public.workspaces w
where w.app = 'reading-list'
on conflict (workspace_id, feature) do nothing;
