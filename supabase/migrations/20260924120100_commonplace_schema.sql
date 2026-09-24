-- Commonplace — the learning app. The sixth app moves in.
--
-- docs/commonplace-spec.md is the argument; this is the part of it that lives
-- in the database. Three things about the shape, before the tables:
--
-- 1. Built-in content is not here. The maps and the Gazetteer decks are files
--    in the repo (src/data/gazetteer/), generated and committed, because a list
--    of country names is something to review as a diff and map geometry is
--    something to serve from a CDN. Only what people make or do is stored:
--    their own decks, their progress, and the games they play.
--
-- 2. A card is a fact, and knowledge belongs to a person. cp_card_state has no
--    workspace column on purpose. Learning where Burkina Faso is in one project
--    means knowing it in every other, and a person in two projects is not two
--    people who each half-know Africa. Cards are named by text references
--    (`place:FRA:name`, `card:<uuid>:fwd`) rather than foreign keys, so the
--    built-in decks can be rebuilt without touching anybody's history.
--
-- 3. Everybody's progress is private. Nobody in a project may read what another
--    member has forgotten. Scores are shared, through a function that returns
--    counts and never answers (see cp_daily_scores), which is the same line
--    Blackletter draws between a share grid and a guess.

-- ── Decks people make ────────────────────────────────────────────────
create table public.cp_decks (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  slug         text not null,
  title        text not null,
  -- Only flashcards today. The spec's saved map selections will be a second
  -- value here, which is why this is a column and not an assumption.
  kind         text not null default 'flashcards',
  -- Marking strictness and the default direction. Read by the app, never by a
  -- policy, so jsonb rather than a column per switch.
  settings     jsonb not null default '{}',
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint cp_decks_kind  check (kind in ('flashcards')),
  constraint cp_decks_slug  check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  constraint cp_decks_title check (char_length(btrim(title)) between 1 and 120),
  unique (workspace_id, slug)
);

create trigger touch_cp_decks before update on public.cp_decks
  for each row execute function public.touch_updated_at();

create table public.cp_cards (
  id        uuid primary key default gen_random_uuid(),
  deck_id   uuid not null references public.cp_decks(id) on delete cascade,
  position  integer not null,
  prompt    text not null,
  answer    text not null,
  accepts   text[] not null default '{}',
  hint      text not null default '',
  notes     text not null default '',
  tags      text[] not null default '{}',
  -- Also ask it back to front. A separate fact with its own schedule: knowing
  -- that "le chien" means the dog is not knowing that the dog is "le chien".
  reverse   boolean not null default false,

  constraint cp_cards_prompt check (char_length(btrim(prompt)) between 1 and 500),
  constraint cp_cards_answer check (char_length(btrim(answer)) between 1 and 500),
  constraint cp_cards_hint   check (char_length(hint) <= 500),
  constraint cp_cards_notes  check (char_length(notes) <= 2000)
);

create index cp_cards_deck_idx on public.cp_cards (deck_id, position);

-- ── What a person knows ──────────────────────────────────────────────
-- One row per person per fact per direction. The columns are FSRS's card state,
-- as ts-fsrs names it, so the browser sends exactly what is stored.
create table public.cp_card_state (
  user_id        uuid not null references auth.users(id) on delete cascade,
  card_ref       text not null,
  stability      double precision not null,
  difficulty     double precision not null,
  due_at         timestamptz not null,
  last_at        timestamptz not null,
  reps           integer not null default 0,
  lapses         integer not null default 0,
  -- 0 new, 1 learning, 2 review, 3 relearning
  state          smallint not null,
  learning_steps integer not null default 0,
  scheduled_days integer not null default 0,
  last_result    text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint cp_card_state_ref check (
    card_ref ~ '^(place:[A-Z0-9-]+:(name|locate|capital)|capital:[A-Z0-9-]+:country|card:[0-9a-f-]{36}:(fwd|rev))$'
  ),
  constraint cp_card_state_state  check (state between 0 and 3),
  constraint cp_card_state_result check (last_result in ('clean', 'close', 'hinted', 'revealed')),
  constraint cp_card_state_nums   check (stability >= 0 and difficulty >= 0 and reps >= 0 and lapses >= 0),
  primary key (user_id, card_ref)
);

-- The review queue asks "what is due for me", and the new-cards-per-day limit
-- asks "what did I first see today". Both are one person's rows.
create index cp_card_state_due_idx on public.cp_card_state (user_id, due_at);
create index cp_card_state_new_idx on public.cp_card_state (user_id, created_at);

create trigger touch_cp_card_state before update on public.cp_card_state
  for each row execute function public.touch_updated_at();

create table public.cp_prefs (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  retention   double precision not null default 0.9,
  new_per_day integer not null default 20,
  updated_at  timestamptz not null default now(),

  -- Above 0.97 the review load grows without limit; below 0.7 it is not
  -- learning any more. The same bounds FSRS's own documentation gives.
  constraint cp_prefs_retention check (retention between 0.7 and 0.97),
  constraint cp_prefs_new check (new_per_day between 0 and 200)
);

-- ── The daily challenge ──────────────────────────────────────────────
-- Written once on first request and then true, like bl_puzzles. Per workspace
-- rather than global, unlike Blackletter: the ten places are drawn from the
-- built-in decks, which every workspace has, but "the same ten as the people I
-- play with" is the promise, and a workspace is who that is.
create table public.cp_daily (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  day          date not null,
  deck_ref     text not null,
  card_refs    text[] not null,
  created_at   timestamptz not null default now(),

  constraint cp_daily_size check (cardinality(card_refs) between 1 and 20),
  unique (workspace_id, day)
);

-- ── Games played ─────────────────────────────────────────────────────
create table public.cp_runs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  deck_ref     text not null,
  mode         text not null,
  settings     jsonb not null default '{}',
  scope        text not null default 'all',
  pb_key       text not null,
  -- Both clocks are the server's. A personal best is a time, and a time the
  -- browser reports is a time anybody can type.
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  total        integer not null,
  -- Filled in by cp_finish_run() from cp_run_answers, never sent.
  clean        integer not null default 0,
  close        integer not null default 0,
  hinted       integer not null default 0,
  revealed     integer not null default 0,
  daily_id     uuid references public.cp_daily(id) on delete cascade,

  constraint cp_runs_mode  check (mode ~ '^[a-z-]{1,20}$'),
  constraint cp_runs_total check (total between 0 and 1000),
  constraint cp_runs_deck  check (deck_ref ~ '^[a-z0-9-]{1,80}$')
);

create index cp_runs_best_idx on public.cp_runs (user_id, pb_key, finished_at);
create index cp_runs_recent_idx on public.cp_runs (workspace_id, user_id, started_at desc);
-- One daily run per person per day, enforced where it cannot be argued with.
create unique index cp_runs_daily_once on public.cp_runs (daily_id, user_id) where daily_id is not null;

create table public.cp_run_answers (
  run_id      uuid not null references public.cp_runs(id) on delete cascade,
  card_ref    text not null,
  result      text not null,
  attempts    smallint not null,
  hints       smallint not null,
  ms          integer not null,
  answered_at timestamptz not null default now(),

  constraint cp_run_answers_result check (result in ('clean', 'close', 'hinted', 'revealed')),
  constraint cp_run_answers_nums check (attempts between 0 and 100 and hints between 0 and 100 and ms >= 0),
  primary key (run_id, card_ref)
);

-- ── Privileges ───────────────────────────────────────────────────────
-- Supabase's default privileges grant `authenticated` everything on a new
-- table, so withholding takes a revoke (20260807150000). Every write below is a
-- function; the only direct write anybody holds is deleting a deck.
revoke all on public.cp_decks, public.cp_cards, public.cp_card_state, public.cp_prefs,
              public.cp_daily, public.cp_runs, public.cp_run_answers
  from anon, authenticated;

grant select, delete on public.cp_decks to authenticated;
grant select on public.cp_cards, public.cp_card_state, public.cp_prefs,
                public.cp_daily, public.cp_runs, public.cp_run_answers to authenticated;

alter table public.cp_decks       enable row level security;
alter table public.cp_cards       enable row level security;
alter table public.cp_card_state  enable row level security;
alter table public.cp_prefs       enable row level security;
alter table public.cp_daily       enable row level security;
alter table public.cp_runs        enable row level security;
alter table public.cp_run_answers enable row level security;

create policy cp_decks_read on public.cp_decks for select
  using (app.can_read(workspace_id));
create policy cp_decks_delete on public.cp_decks for delete
  using (app.can_write(workspace_id));

create policy cp_cards_read on public.cp_cards for select
  using (exists (select 1 from public.cp_decks d where d.id = deck_id and app.can_read(d.workspace_id)));

-- Own rows, and nothing else. There is no workspace to check: see (2) above.
create policy cp_card_state_read on public.cp_card_state for select
  using (user_id = (select auth.uid()));
create policy cp_prefs_read on public.cp_prefs for select
  using (user_id = (select auth.uid()));

create policy cp_daily_read on public.cp_daily for select
  using (app.can_read(workspace_id));

-- Your own games, in a project you can still see. Everybody else's arrive as
-- counts through cp_daily_scores().
create policy cp_runs_read on public.cp_runs for select
  using (user_id = (select auth.uid()) and app.can_read(workspace_id));
create policy cp_run_answers_read on public.cp_run_answers for select
  using (exists (select 1 from public.cp_runs r where r.id = run_id and r.user_id = (select auth.uid())));
