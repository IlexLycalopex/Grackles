-- Blackletter — the word game. The fifth app moves in.
--
-- Every other app in this repo is a record-keeping app: a workspace holds rows,
-- members read and edit them, and RLS decides who sees what. Blackletter is the
-- first one that has to keep a secret, and that changes the shape of it in three
-- ways worth stating before the tables.
--
-- 1. The answer never leaves the database. bl_puzzles holds it and carries no
--    grant to anon or authenticated at all, so there is no policy to get wrong:
--    the privilege check refuses before RLS is consulted. Everything a player is
--    allowed to know is returned by the SECURITY DEFINER functions at the bottom
--    of this file, which is the same shape app.cigar_lookups_today() takes and
--    for the same reason — stepping outside RLS is what lets a function answer a
--    question about a table nobody may read.
--
-- 2. Guessing is a write, so it is a function and not an insert. The rules that
--    make the game a game — six attempts, one puzzle a day, a real word, no
--    playing yesterday's puzzle today — are all things a client would otherwise
--    be trusted to enforce on itself. They are in app.blackletter_guess(), which
--    is the only way a row reaches bl_games.
--
-- 3. A member may not read another member's game. This is the first table here
--    where that is true — everywhere else, membership *is* readability. A
--    finished game's guesses contain the answer, so the scoreboard is a function
--    that returns marks and never guesses, and the policy on bl_games is simply
--    own-rows-only.
--
-- The word lists and the puzzle schedule are deliberately global rather than
-- per-workspace. "The same word for everybody today" is the whole daily-puzzle
-- premise, and a per-workspace schedule would quietly break it the day a second
-- workspace existed — two people comparing grids in a group chat would be
-- comparing different puzzles.

-- ── The dictionary ───────────────────────────────────────────────────
-- Loaded from supabase/seed/blackletter-words.sql, which is generated. See
-- build-blackletter-words.py for how a word gets into either list.
create table public.bl_words (
  word        text primary key,
  length      integer not null,
  -- Whether a puzzle may answer with this word. Every solution is also a legal
  -- guess, which is why this is a flag on one row rather than two tables: the
  -- two lists cannot drift into disagreeing about that.
  is_solution boolean not null default false,

  constraint bl_words_length      check (length between 4 and 12),
  constraint bl_words_shape       check (word ~ '^[a-z]+$'),
  constraint bl_words_length_true check (length = char_length(word))
);

-- Guess validation asks "is this a word of this length", and minting a puzzle
-- asks "which solutions of this length have not been used". Both are answered
-- by this index without touching the table.
create index bl_words_length_idx on public.bl_words (length, word);
create index bl_words_solution_idx on public.bl_words (length, word) where is_solution;

-- ── The schedule ─────────────────────────────────────────────────────
-- One puzzle per length per day, minted on first demand and then fixed forever.
--
-- The spec proposed deriving the answer arithmetically — day-index modulo the
-- list length — and locking the list order for all time so that history stayed
-- true. That constraint exists only because a static site has nowhere to write
-- down what it played. There is somewhere here, so the row is the record: the
-- word list can be reordered, extended, or have a word withdrawn after it turns
-- out to be a poor answer, and not one player's history moves.
create table public.bl_puzzles (
  id         uuid primary key default gen_random_uuid(),
  length     integer not null,
  on_date    date    not null,
  word       text    not null references public.bl_words(word),

  -- On the puzzle, not in a constant. Six is the classic and is what all three
  -- lengths open with, but if it is ever tuned, changing a constant would
  -- retroactively rewrite how hard every finished game was and how long every
  -- share grid should have been.
  attempts   integer not null default 6,

  created_at timestamptz not null default now(),

  constraint bl_puzzles_attempts check (attempts between 3 and 12),
  unique (length, on_date)
);

-- ── A player's game ──────────────────────────────────────────────────
-- One row per person per puzzle per workspace. The workspace is on it because
-- the scoreboard is per workspace: the same person playing the same puzzle in
-- two projects is two games, which is the honest reading of "how did our group
-- do today" and avoids the alternative where joining a second workspace
-- retrospectively populates its leaderboard with games played elsewhere.
create table public.bl_games (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  puzzle_id    uuid not null references public.bl_puzzles(id) on delete cascade,

  -- Parallel arrays, appended to together by app.blackletter_guess(). guesses[i]
  -- is what was typed and marks[i] is how it came back, one character per letter:
  -- c correct, p present, a absent. The share grid is marks alone, which is what
  -- makes it spoiler-free — and is why the scoreboard can show it to somebody
  -- who has not played yet.
  guesses      text[] not null default '{}',
  marks        text[] not null default '{}',

  status       text not null default 'playing',

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz,

  constraint bl_games_status check (status in ('playing', 'won', 'lost')),
  constraint bl_games_arrays_aligned
    check (cardinality(guesses) = cardinality(marks)),
  -- A finished game has a finishing time and an unfinished one does not. Both
  -- directions, because the streak reads finished_at and a won game without one
  -- would silently drop out of it.
  constraint bl_games_finished_at
    check ((status = 'playing') = (finished_at is null)),
  unique (workspace_id, user_id, puzzle_id)
);

create index bl_games_puzzle_idx on public.bl_games (workspace_id, puzzle_id);
-- The streak walks one player's finished games backwards through time.
create index bl_games_streak_idx on public.bl_games (workspace_id, user_id, finished_at desc);

create trigger touch_bl_games before update on public.bl_games
  for each row execute function public.touch_updated_at();

-- ── Privileges ───────────────────────────────────────────────────────
-- Supabase's default privileges on `public` grant `authenticated` the full set
-- on any new table, so a GRANT here would narrow nothing — withholding takes a
-- REVOKE. This is the lesson 20260807150000 was written about, applied up front
-- this time rather than as a correction.
--
-- bl_words and bl_puzzles are readable by nobody. The dictionary is not secret,
-- but there is no reason to let a client pull 47,000 rows to answer a question a
-- function answers in one lookup, and bl_puzzles holds the answer outright.
revoke all on public.bl_words   from anon, authenticated;
revoke all on public.bl_puzzles from anon, authenticated;

-- A game is written only by app.blackletter_guess(). The player may read their
-- own row back; nothing may write one directly.
revoke all on public.bl_games from anon, authenticated;
grant select on public.bl_games to authenticated;

alter table public.bl_words   enable row level security;
alter table public.bl_puzzles enable row level security;
alter table public.bl_games   enable row level security;

-- No policies at all on the first two: RLS enabled with no policy denies
-- everything, which is the intent stated twice.

-- Own rows only, and only in a workspace you can still read. The second half
-- matters when somebody is removed from a project: their games stop being
-- visible to them there, which is the same rule every other table follows.
create policy bl_games_read on public.bl_games for select
  using (user_id = (select auth.uid()) and app.can_read(workspace_id));

-- ── Marking a guess ──────────────────────────────────────────────────
create function app.mark_guess(p_guess text, p_answer text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  n     integer := char_length(p_answer);
  -- The cast is load-bearing: array_fill is polymorphic and an untyped 'a'
  -- leaves it with nothing to resolve against, which fails at call time rather
  -- than when the function is created.
  marks text[]    := array_fill('a'::text, array[n]);
  pool  integer[] := array_fill(0, array[26]);
  i     integer;
  c     integer;
begin
  if char_length(p_guess) <> n then
    raise exception 'guess and answer differ in length';
  end if;

  -- Exact positions first, and the two passes are not interchangeable. A letter
  -- matched in place must be taken out of what remains available before any
  -- present-but-elsewhere match is allowed to claim it, or a guess of ALLOT
  -- against ALOFT marks both Ls when the answer has one.
  for i in 1..n loop
    if substr(p_guess, i, 1) = substr(p_answer, i, 1) then
      marks[i] := 'c';
    else
      c := ascii(substr(p_answer, i, 1)) - 96;
      pool[c] := pool[c] + 1;
    end if;
  end loop;

  -- Then present, left to right, each one spending a letter from what is left.
  -- Left to right is the rule Wordle uses and is observable: guessing SPEED
  -- against ERASE marks the first E present and the second absent, not both
  -- amber and not the other way round.
  for i in 1..n loop
    if marks[i] = 'a' then
      c := ascii(substr(p_guess, i, 1)) - 96;
      if pool[c] > 0 then
        marks[i] := 'p';
        pool[c] := pool[c] - 1;
      end if;
    end if;
  end loop;

  return array_to_string(marks, '');
end;
$$;

-- ── Minting the day's puzzle ─────────────────────────────────────────
create function app.blackletter_puzzle(p_length integer, p_date date)
returns public.bl_puzzles
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  puzzle public.bl_puzzles;
begin
  select * into puzzle from public.bl_puzzles
   where length = p_length and on_date = p_date;
  if found then
    return puzzle;
  end if;

  -- Never used before, ordered by a hash of the word and the date. The hash is
  -- doing the job the spec gave to a locked list order: it spreads consecutive
  -- days across the alphabet, where a modulo over a sorted list would hand out
  -- words sharing a prefix on consecutive days.
  insert into public.bl_puzzles (length, on_date, word)
  select p_length, p_date, w.word
    from public.bl_words w
   where w.length = p_length
     and w.is_solution
     and not exists (select 1 from public.bl_puzzles p where p.word = w.word)
   order by md5(w.word || p_date::text)
   limit 1
  -- Two players arriving in the same second both try to mint. The loser of that
  -- race wants the winner's puzzle, not an error and not a second word.
  on conflict (length, on_date) do nothing
  returning * into puzzle;

  if puzzle.id is null then
    select * into puzzle from public.bl_puzzles
     where length = p_length and on_date = p_date;
  end if;

  -- Only reachable once every solution of this length has been used — six years
  -- out. Saying so plainly beats a null-answer game nobody can diagnose.
  if puzzle.id is null then
    raise exception 'no unused % letter solutions remain', p_length
      using errcode = 'GRK05';
  end if;

  return puzzle;
end;
$$;

comment on function app.blackletter_puzzle(integer, date) is
  'The puzzle for a length and a date, minted on first demand and fixed after.';
