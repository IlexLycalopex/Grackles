-- Commonplace — everything a player may do.
--
-- The tables carry select grants and nothing else (bar deleting a deck), so
-- these functions are the only way anything is written. All are SECURITY
-- DEFINER and so do their own permission checks, opening with app.can_read()
-- for playing and app.can_write() for editing a deck: playing is not editing
-- the project, and a viewer who cannot play has been given a project that does
-- nothing (the same rule as Blackletter).
--
-- One trade-off is stated plainly in the spec and repeated here because this is
-- where it lives: answers are marked in the browser, so these functions accept
-- a result rather than work one out. What they do not accept from the browser
-- is time. Both ends of a run are stamped with the server's clock.
--
-- Error codes, continuing the series in supabase/README.md:
--   GRK40  already played today's challenge
--   GRK41  that is not today's challenge
--   GRK42  that run is finished
--   GRK43  too many cards in one deck

-- Which day it is. Europe/London, for the reason app.blackletter_today() gives.
create function app.commonplace_today() returns date
language sql stable set search_path = public, pg_temp as $$
  select (now() at time zone 'Europe/London')::date;
$$;

-- The same pattern cp_card_state checks and decks.ts exports as REF_PATTERN.
create function app.cp_valid_ref(p_ref text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select p_ref ~ '^(place:[A-Z0-9-]+:(name|locate|capital)|capital:[A-Z0-9-]+:country|card:[0-9a-f-]{36}:(fwd|rev))$';
$$;

-- ── Starting a run ───────────────────────────────────────────────────
create function public.cp_start_run(
  p_workspace uuid,
  p_deck_ref  text,
  p_mode      text,
  p_settings  jsonb,
  p_scope     text,
  p_pb_key    text,
  p_total     integer,
  p_daily     uuid default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me     uuid := auth.uid();
  new_id uuid;
begin
  if me is null then
    raise exception 'you must be signed in to play' using errcode = '42501';
  end if;
  if not app.can_read(p_workspace) then
    raise exception 'no such project' using errcode = '42501';
  end if;

  if p_daily is not null and not exists (
    select 1 from public.cp_daily
     where id = p_daily and workspace_id = p_workspace and day = app.commonplace_today()
  ) then
    raise exception 'that is not today''s challenge' using errcode = 'GRK41';
  end if;

  begin
    insert into public.cp_runs (workspace_id, user_id, deck_ref, mode, settings, scope, pb_key, total, daily_id)
    values (p_workspace, me, p_deck_ref, p_mode, coalesce(p_settings, '{}'), coalesce(p_scope, 'all'),
            left(p_pb_key, 300), p_total, p_daily)
    returning id into new_id;
  exception when unique_violation then
    raise exception 'you have already played today''s challenge' using errcode = 'GRK40';
  end;

  return new_id;
end;
$$;

-- ── Recording one answer ─────────────────────────────────────────────
-- The answer and the new schedule are written together, so a card can never be
-- rescheduled by an answer that was not recorded, or recorded without moving
-- its schedule. Called after every card, so closing the tab halfway through a
-- run loses nothing that was answered.
create function public.cp_record_answer(
  p_run      uuid,
  p_card_ref text,
  p_result   text,
  p_attempts integer,
  p_hints    integer,
  p_ms       integer,
  p_state    jsonb default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me  uuid := auth.uid();
  run public.cp_runs;
begin
  if me is null then
    raise exception 'you must be signed in to play' using errcode = '42501';
  end if;

  -- The row lock orders this against cp_finish_run(): an answer that arrives
  -- after the run has been totalled is refused rather than left uncounted.
  select * into run from public.cp_runs where id = p_run and user_id = me for update;
  if not found or not app.can_read(run.workspace_id) then
    raise exception 'no such run' using errcode = '42501';
  end if;
  if run.finished_at is not null then
    raise exception 'that run is finished' using errcode = 'GRK42';
  end if;
  if not app.cp_valid_ref(p_card_ref) then
    raise exception 'not a card: %', p_card_ref using errcode = '22023';
  end if;

  -- First answer wins. Learn mode asks a card again after a miss, and it is the
  -- first try that says whether it was known.
  insert into public.cp_run_answers (run_id, card_ref, result, attempts, hints, ms)
  values (p_run, p_card_ref, p_result, greatest(p_attempts, 0), greatest(p_hints, 0), greatest(p_ms, 0))
  on conflict (run_id, card_ref) do nothing;

  if p_state is null then
    return;
  end if;

  insert into public.cp_card_state as s (
    user_id, card_ref, stability, difficulty, due_at, last_at, reps, lapses,
    state, learning_steps, scheduled_days, last_result
  ) values (
    me, p_card_ref,
    (p_state->>'stability')::double precision,
    (p_state->>'difficulty')::double precision,
    (p_state->>'due_at')::timestamptz,
    (p_state->>'last_at')::timestamptz,
    (p_state->>'reps')::integer,
    (p_state->>'lapses')::integer,
    (p_state->>'state')::smallint,
    coalesce((p_state->>'learning_steps')::integer, 0),
    coalesce((p_state->>'scheduled_days')::integer, 0),
    p_result
  )
  on conflict (user_id, card_ref) do update
     set stability      = excluded.stability,
         difficulty     = excluded.difficulty,
         due_at         = excluded.due_at,
         last_at        = excluded.last_at,
         reps           = excluded.reps,
         lapses         = excluded.lapses,
         state          = excluded.state,
         learning_steps = excluded.learning_steps,
         scheduled_days = excluded.scheduled_days,
         last_result    = excluded.last_result;
end;
$$;

-- ── Finishing a run ──────────────────────────────────────────────────
-- Totals come from the answers, not from the browser, and the best to compare
-- against is found before this run is counted, so "your previous best" is never
-- the run that just finished. Safe to call twice: the second call reports the
-- same finish.
create function public.cp_finish_run(p_run uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me   uuid := auth.uid();
  run  public.cp_runs;
  best record;
begin
  select * into run from public.cp_runs where id = p_run and user_id = me for update;
  if not found or not app.can_read(run.workspace_id) then
    raise exception 'no such run' using errcode = '42501';
  end if;

  if run.finished_at is null then
    update public.cp_runs r
       set finished_at = now(),
           clean    = (select count(*) from public.cp_run_answers a where a.run_id = r.id and a.result = 'clean'),
           close    = (select count(*) from public.cp_run_answers a where a.run_id = r.id and a.result = 'close'),
           hinted   = (select count(*) from public.cp_run_answers a where a.run_id = r.id and a.result = 'hinted'),
           revealed = (select count(*) from public.cp_run_answers a where a.run_id = r.id and a.result = 'revealed')
     where r.id = run.id
     returning * into run;
  end if;

  -- Best is most known, then quickest. "Known" is clean plus close: a slip is
  -- still knowing the place.
  select r.clean + r.close as known, r.total,
         (extract(epoch from r.finished_at - r.started_at) * 1000)::bigint as duration_ms,
         r.finished_at
    into best
    from public.cp_runs r
   where r.user_id = me and r.pb_key = run.pb_key and r.id <> run.id
     and r.finished_at is not null and r.finished_at < run.finished_at
   order by r.clean + r.close desc, r.finished_at - r.started_at asc
   limit 1;

  return jsonb_build_object(
    'clean',       run.clean,
    'close',       run.close,
    'hinted',      run.hinted,
    'revealed',    run.revealed,
    'total',       run.total,
    'duration_ms', (extract(epoch from run.finished_at - run.started_at) * 1000)::bigint,
    'previous_best', case when best.known is null then null else jsonb_build_object(
      'known', best.known, 'total', best.total, 'duration_ms', best.duration_ms, 'finished_at', best.finished_at
    ) end
  );
end;
$$;

-- ── The daily challenge ──────────────────────────────────────────────
-- The app proposes today's ten (a hash of the workspace and the date, so every
-- member proposes the same ones) and the first proposal to arrive is kept.
-- After that the row is the record, whatever the deck files later say.
create function public.cp_daily_today(
  p_workspace uuid,
  p_deck_ref  text,
  p_card_refs text[]
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me    uuid := auth.uid();
  today date := app.commonplace_today();
  daily public.cp_daily;
  mine  public.cp_runs;
begin
  if me is null then
    raise exception 'you must be signed in to play' using errcode = '42501';
  end if;
  if not app.can_read(p_workspace) then
    raise exception 'no such project' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(p_card_refs) r where not app.cp_valid_ref(r)) then
    raise exception 'not a list of cards' using errcode = '22023';
  end if;

  insert into public.cp_daily (workspace_id, day, deck_ref, card_refs)
  values (p_workspace, today, p_deck_ref, p_card_refs)
  on conflict (workspace_id, day) do nothing;

  select * into daily from public.cp_daily where workspace_id = p_workspace and day = today;
  select * into mine from public.cp_runs where daily_id = daily.id and user_id = me;

  return jsonb_build_object(
    'id',        daily.id,
    'day',       daily.day,
    'deck_ref',  daily.deck_ref,
    'card_refs', to_jsonb(daily.card_refs),
    'run',       case when mine.id is null then null else jsonb_build_object(
      'id', mine.id, 'finished', mine.finished_at is not null
    ) end
  );
end;
$$;

-- Counts and times, never answers. A row of numbers says how well somebody did
-- without saying which places they got, so it can be shown to a member who has
-- not played yet.
create function public.cp_daily_scores(p_workspace uuid, p_day date default null)
returns table (
  user_id      uuid,
  display_name text,
  finished     boolean,
  clean        integer,
  close        integer,
  hinted       integer,
  revealed     integer,
  total        integer,
  duration_ms  bigint
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not app.can_read(p_workspace) then
    raise exception 'no such project' using errcode = '42501';
  end if;

  return query
  select r.user_id,
         coalesce(nullif(p.display_name, ''), 'Someone'),
         r.finished_at is not null,
         r.clean, r.close, r.hinted, r.revealed, r.total,
         case when r.finished_at is null then null
              else (extract(epoch from r.finished_at - r.started_at) * 1000)::bigint end
    from public.cp_runs r
    join public.cp_daily d on d.id = r.daily_id
    left join public.profiles p on p.id = r.user_id
   where d.workspace_id = p_workspace
     and d.day = coalesce(p_day, app.commonplace_today())
   order by (r.finished_at is null), r.clean + r.close desc, r.finished_at - r.started_at;
end;
$$;

-- ── Decks ────────────────────────────────────────────────────────────
-- A deck and all its cards in one call and one transaction. Cards keep their
-- ids across edits, because a card's id is in its card reference and its
-- reference is what a person's progress is filed under: renumbering on save
-- would reset everybody's schedule every time a typo was fixed.
create function public.cp_save_deck(
  p_workspace uuid,
  p_id        uuid,
  p_slug      text,
  p_title     text,
  p_settings  jsonb,
  p_cards     jsonb
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_deck  uuid;
  card    jsonb;
  pos     integer;
  card_id uuid;
begin
  if auth.uid() is null or not app.can_write(p_workspace) then
    raise exception 'you cannot edit decks in this project' using errcode = '42501';
  end if;
  if jsonb_typeof(p_cards) <> 'array' then
    raise exception 'cards must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(p_cards) > 2000 then
    raise exception 'a deck holds at most 2,000 cards' using errcode = 'GRK43';
  end if;

  begin
    if p_id is null then
      insert into public.cp_decks (workspace_id, slug, title, settings, created_by)
      values (p_workspace, p_slug, btrim(p_title), coalesce(p_settings, '{}'), auth.uid())
      returning id into v_deck;
    else
      update public.cp_decks
         set slug = p_slug, title = btrim(p_title), settings = coalesce(p_settings, '{}')
       where id = p_id and workspace_id = p_workspace
      returning id into v_deck;
      if v_deck is null then
        raise exception 'no such deck' using errcode = 'P0002';
      end if;
    end if;
  exception when unique_violation then
    raise exception 'the address % is already taken', p_slug using errcode = 'GRK04';
  end;

  -- Cards no longer in the list go. Their references stay in people's
  -- progress, harmlessly: a reference to nothing is never due for anything.
  delete from public.cp_cards c
   where c.deck_id = v_deck
     and c.id not in (
       select (e->>'id')::uuid from jsonb_array_elements(p_cards) e
        where e->>'id' ~ '^[0-9a-f-]{36}$'
     );

  for card, pos in select e, o::integer from jsonb_array_elements(p_cards) with ordinality as t(e, o) loop
    card_id := case when card->>'id' ~ '^[0-9a-f-]{36}$' then (card->>'id')::uuid end;

    update public.cp_cards c
       set position = pos,
           prompt   = btrim(card->>'prompt'),
           answer   = btrim(card->>'answer'),
           accepts  = coalesce(array(select jsonb_array_elements_text(card->'accepts')), '{}'),
           hint     = coalesce(card->>'hint', ''),
           notes    = coalesce(card->>'notes', ''),
           tags     = coalesce(array(select jsonb_array_elements_text(card->'tags')), '{}'),
           reverse  = coalesce((card->>'reverse')::boolean, false)
     where c.id = card_id and c.deck_id = v_deck;

    -- An id that is not a card of this deck is not honoured: it is a new card.
    -- Otherwise a crafted save could adopt another deck's card, and with it the
    -- progress people have made on that card.
    if not found then
      insert into public.cp_cards (deck_id, position, prompt, answer, accepts, hint, notes, tags, reverse)
      values (
        v_deck, pos, btrim(card->>'prompt'), btrim(card->>'answer'),
        coalesce(array(select jsonb_array_elements_text(card->'accepts')), '{}'),
        coalesce(card->>'hint', ''), coalesce(card->>'notes', ''),
        coalesce(array(select jsonb_array_elements_text(card->'tags')), '{}'),
        coalesce((card->>'reverse')::boolean, false)
      );
    end if;
  end loop;

  return v_deck;
end;
$$;

-- ── Preferences ──────────────────────────────────────────────────────
create function public.cp_set_prefs(p_retention double precision, p_new_per_day integer)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then
    raise exception 'you must be signed in' using errcode = '42501';
  end if;
  insert into public.cp_prefs (user_id, retention, new_per_day, updated_at)
  values (auth.uid(), p_retention, p_new_per_day, now())
  on conflict (user_id) do update
     set retention = excluded.retention, new_per_day = excluded.new_per_day, updated_at = now();
end;
$$;

-- ── Privileges ───────────────────────────────────────────────────────
revoke all on function app.commonplace_today() from public, anon, authenticated;
revoke all on function app.cp_valid_ref(text) from public, anon, authenticated;

revoke all on function public.cp_start_run(uuid, text, text, jsonb, text, text, integer, uuid) from public, anon;
revoke all on function public.cp_record_answer(uuid, text, text, integer, integer, integer, jsonb) from public, anon;
revoke all on function public.cp_finish_run(uuid) from public, anon;
revoke all on function public.cp_daily_today(uuid, text, text[]) from public, anon;
revoke all on function public.cp_daily_scores(uuid, date) from public, anon;
revoke all on function public.cp_save_deck(uuid, uuid, text, text, jsonb, jsonb) from public, anon;
revoke all on function public.cp_set_prefs(double precision, integer) from public, anon;

grant execute on function public.cp_start_run(uuid, text, text, jsonb, text, text, integer, uuid) to authenticated;
grant execute on function public.cp_record_answer(uuid, text, text, integer, integer, integer, jsonb) to authenticated;
grant execute on function public.cp_finish_run(uuid) to authenticated;
grant execute on function public.cp_daily_today(uuid, text, text[]) to authenticated;
grant execute on function public.cp_daily_scores(uuid, date) to authenticated;
grant execute on function public.cp_save_deck(uuid, uuid, text, text, jsonb, jsonb) to authenticated;
grant execute on function public.cp_set_prefs(double precision, integer) to authenticated;
