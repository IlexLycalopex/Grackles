-- Blackletter — everything a player is allowed to ask or do.
--
-- Four functions, and between them they are the entire surface of the game. The
-- tables underneath carry no grants, so this file is not a convenience layer
-- over them: it is the only way in.
--
-- All four are SECURITY DEFINER and therefore have to do their own permission
-- checks, because RLS is not going to do it for them. Every one opens with
-- app.can_read(workspace_id) — deliberately can_read and not can_write. Playing
-- is not editing the project, and a viewer who cannot play the game they were
-- invited to has been given a project that does nothing.
--
-- Error codes, continuing the series in supabase/README.md:
--   GRK05  the solution pool for that length is exhausted
--   GRK06  not a word in the guess list
--   GRK07  that game is already finished, or has no attempts left

-- Which day it is, in the only timezone that matters here.
--
-- A daily puzzle has to pick a clock. UTC is the tempting default and is wrong
-- for this site: it rolls over at 1am British Summer Time, so for half the year
-- the new puzzle arrives in the middle of the night after the one people are
-- actually awake for. Europe/London means "today" is today to the people
-- playing. It is fixed here rather than taken from the browser because the
-- puzzle is server-authoritative — a client-chosen date is a client that can
-- ask for tomorrow.
create function app.blackletter_today() returns date
language sql stable set search_path = public, pg_temp as $$
  select (now() at time zone 'Europe/London')::date;
$$;

-- ── Where a game stands ──────────────────────────────────────────────
create function public.blackletter_state(p_workspace uuid, p_length integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me     uuid := auth.uid();
  today  date := app.blackletter_today();
  puzzle public.bl_puzzles;
  game   public.bl_games;
begin
  if me is null then
    raise exception 'you must be signed in to play' using errcode = '42501';
  end if;
  if not app.can_read(p_workspace) then
    raise exception 'no such project' using errcode = '42501';
  end if;

  puzzle := app.blackletter_puzzle(p_length, today);

  select * into game from public.bl_games
   where workspace_id = p_workspace and user_id = me and puzzle_id = puzzle.id;

  return jsonb_build_object(
    'date',     today,
    'length',   p_length,
    'attempts', puzzle.attempts,
    'guesses',  coalesce(to_jsonb(game.guesses), '[]'::jsonb),
    'marks',    coalesce(to_jsonb(game.marks), '[]'::jsonb),
    'status',   coalesce(game.status, 'playing'),
    -- The whole design in one line. The answer is in `puzzle` throughout this
    -- function and is put into the reply only once the game can no longer be
    -- affected by knowing it.
    'answer',   case when game.status in ('won', 'lost') then to_jsonb(puzzle.word) else 'null'::jsonb end
  );
end;
$$;

-- ── Making a guess ───────────────────────────────────────────────────
create function public.blackletter_guess(
  p_workspace uuid,
  p_length    integer,
  p_guess     text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me     uuid := auth.uid();
  today  date := app.blackletter_today();
  guess  text := lower(btrim(p_guess));
  puzzle public.bl_puzzles;
  game   public.bl_games;
  -- Prefixed because bl_games has columns of both these names. plpgsql resolves
  -- an ambiguous reference in favour of the variable, so `set marks = marks || …`
  -- would quietly append to the local rather than to the column and every game
  -- would sit at one mark forever.
  v_marks  text;
  v_status text;
begin
  if me is null then
    raise exception 'you must be signed in to play' using errcode = '42501';
  end if;
  if not app.can_read(p_workspace) then
    raise exception 'no such project' using errcode = '42501';
  end if;

  puzzle := app.blackletter_puzzle(p_length, today);

  -- The dictionary check is here and not only in the browser. The client checks
  -- too, so that a typo answers instantly instead of after a round trip, but a
  -- client check is a courtesy: without this one, a crafted request could spend
  -- its six attempts on AAAAAA, BBBBBB and so on and read the answer off the
  -- letter counts without ever guessing a word.
  if not exists (
    select 1 from public.bl_words w
     where w.word = guess and w.length = p_length
  ) then
    raise exception '% is not in the word list', upper(guess) using errcode = 'GRK06';
  end if;

  -- Ensure the row exists, then take it. Doing it in this order rather than
  -- select-then-insert-if-missing is what survives two first guesses arriving
  -- together: the loser's insert does nothing instead of violating the unique
  -- constraint, and both go on to lock the same row.
  insert into public.bl_games (workspace_id, user_id, puzzle_id)
  values (p_workspace, me, puzzle.id)
  on conflict (workspace_id, user_id, puzzle_id) do nothing;

  -- FOR UPDATE holds it until this transaction ends. Without it a double-tap
  -- would have both requests read five guesses, both append, and produce a
  -- seventh attempt on a six-attempt puzzle.
  select * into game from public.bl_games
   where workspace_id = p_workspace and user_id = me and puzzle_id = puzzle.id
   for update;

  if game.status <> 'playing' then
    raise exception 'today''s % letter game is already finished', p_length
      using errcode = 'GRK07';
  end if;
  if cardinality(game.guesses) >= puzzle.attempts then
    raise exception 'no attempts left' using errcode = 'GRK07';
  end if;

  v_marks  := app.mark_guess(guess, puzzle.word);
  v_status := case
                when guess = puzzle.word then 'won'
                when cardinality(game.guesses) + 1 >= puzzle.attempts then 'lost'
                else 'playing'
              end;

  update public.bl_games g
     set guesses     = g.guesses || guess,
         marks       = g.marks   || v_marks,
         status      = v_status,
         finished_at = case when v_status = 'playing' then null else now() end
   where g.id = game.id
   returning * into game;

  return jsonb_build_object(
    'date',     today,
    'length',   p_length,
    'attempts', puzzle.attempts,
    'guesses',  to_jsonb(game.guesses),
    'marks',    to_jsonb(game.marks),
    'status',   game.status,
    'answer',   case when game.status = 'playing' then 'null'::jsonb else to_jsonb(puzzle.word) end
  );
end;
$$;

-- ── How everybody did ────────────────────────────────────────────────
-- The reason the game is on Grackles rather than on a static host: the workspace
-- is the group you compare grids with.
--
-- This returns marks and never guesses, which is what makes it safe to show to
-- somebody who has not played yet. A row of 🟩🟩⬜⬜🟨 says how well a guess went
-- without saying what the guess was, and that asymmetry is the same one that
-- makes Wordle's share text spoiler-free.
create function public.blackletter_scoreboard(
  p_workspace uuid,
  p_length    integer,
  p_date      date default null
) returns table (
  user_id      uuid,
  display_name text,
  status       text,
  attempts_used integer,
  marks        text[],
  finished_at  timestamptz
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  on_day date := coalesce(p_date, app.blackletter_today());
begin
  if auth.uid() is null or not app.can_read(p_workspace) then
    raise exception 'no such project' using errcode = '42501';
  end if;

  return query
  select g.user_id,
         coalesce(nullif(p.display_name, ''), 'Someone'),
         g.status,
         cardinality(g.guesses),
         g.marks,
         g.finished_at
    from public.bl_games g
    join public.bl_puzzles z on z.id = g.puzzle_id
    left join public.profiles p on p.id = g.user_id
   where g.workspace_id = p_workspace
     and z.length = p_length
     and z.on_date = on_day
   -- Finished first, fewest guesses first, earliest first. Anyone still playing
   -- sorts to the bottom without their progress being ranked, because a partial
   -- game's guess count is not a score.
   order by (g.status = 'playing'), cardinality(g.guesses), g.finished_at;
end;
$$;

-- ── A player's record ────────────────────────────────────────────────
-- Derived, never stored. The same argument the WBPR caller count is built on: a
-- streak column is a number that goes wrong the first time a game is corrected
-- or a workspace is left, and the games are right there to be counted.
create function public.blackletter_stats(p_workspace uuid, p_length integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me      uuid := auth.uid();
  today   date := app.blackletter_today();
  result  jsonb;
  streak  integer := 0;
  best    integer := 0;
  run     integer := 0;
  prev    date;
  r       record;
begin
  if me is null or not app.can_read(p_workspace) then
    raise exception 'no such project' using errcode = '42501';
  end if;

  -- Streaks are walked oldest to newest, and are per length on purpose: a
  -- five-letter run and a seven-letter run are different achievements, and
  -- folding them together means missing one day of sevens breaks the other two.
  for r in
    select z.on_date, g.status
      from public.bl_games g
      join public.bl_puzzles z on z.id = g.puzzle_id
     where g.workspace_id = p_workspace and g.user_id = me
       and z.length = p_length and g.status <> 'playing'
     order by z.on_date
  loop
    if r.status = 'won' and prev is not null and r.on_date = prev + 1 then
      run := run + 1;
    elsif r.status = 'won' then
      run := 1;
    else
      run := 0;
    end if;
    prev := r.on_date;
    best := greatest(best, run);
  end loop;

  -- A run is only *current* if it reaches yesterday or today. Today's puzzle
  -- being unplayed does not break a streak; the day before last does.
  streak := case when prev >= today - 1 then run else 0 end;

  select jsonb_build_object(
           'played',       count(*),
           'won',          count(*) filter (where g.status = 'won'),
           'streak',       streak,
           'max_streak',   best,
           'distribution', coalesce(
             (select jsonb_object_agg(n::text, c) from (
                select cardinality(g2.guesses) as n, count(*) as c
                  from public.bl_games g2
                  join public.bl_puzzles z2 on z2.id = g2.puzzle_id
                 where g2.workspace_id = p_workspace and g2.user_id = me
                   and z2.length = p_length and g2.status = 'won'
                 group by 1
              ) d), '{}'::jsonb)
         )
    into result
    from public.bl_games g
    join public.bl_puzzles z on z.id = g.puzzle_id
   where g.workspace_id = p_workspace and g.user_id = me
     and z.length = p_length and g.status <> 'playing';

  return result;
end;
$$;

-- ── Privileges ───────────────────────────────────────────────────────
-- app.* is not an exposed schema, so mark_guess, blackletter_puzzle and
-- blackletter_today are reachable from the functions above and not as RPCs.
revoke all on function app.blackletter_today() from public, anon, authenticated;
revoke all on function app.mark_guess(text, text) from public, anon, authenticated;
revoke all on function app.blackletter_puzzle(integer, date) from public, anon, authenticated;

-- Anonymous visitors may read a public workspace but may not play one: a game
-- belongs to a person, and there is no person here to hang it on.
revoke all on function public.blackletter_state(uuid, integer) from public, anon;
revoke all on function public.blackletter_guess(uuid, integer, text) from public, anon;
revoke all on function public.blackletter_scoreboard(uuid, integer, date) from public, anon;
revoke all on function public.blackletter_stats(uuid, integer) from public, anon;

grant execute on function public.blackletter_state(uuid, integer) to authenticated;
grant execute on function public.blackletter_guess(uuid, integer, text) to authenticated;
grant execute on function public.blackletter_scoreboard(uuid, integer, date) to authenticated;
grant execute on function public.blackletter_stats(uuid, integer) to authenticated;
