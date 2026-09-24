#!/usr/bin/env bash
# Behavioural verification of the Commonplace migrations.
#
# Run against a throwaway cluster loaded with tests/baseline.sql and every
# migration in order. Override connection details with PGHOST/PGPORT/PGUSER/
# PGDATABASE as needed.
#
# What is worth testing, most expensive to get wrong first:
#
#   1. Progress is private. Nobody reads another member's card state, runs or
#      answers, and the shared scoreboard carries counts and never cards.
#   2. Time is the server's. A run's length comes from its own two stamps, and
#      an answer cannot land on a run that has already been totalled.
#   3. The daily challenge is the same ten for everybody and one go each.
#   4. A deck save keeps card ids, so editing a deck never resets anybody's
#      schedule, and cannot adopt another deck's card along with its history.
. "$(dirname "$0")/harness.sh"

CAROL='9a1f0c22-0000-4000-8000-000000000003'
as_carol="set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$CAROL\",\"email\":\"carol@example.com\"}';"
WS='c0000000-0000-4000-8000-000000000001'
OTHER='c0000000-0000-4000-8000-000000000002'

# Jamie owns a Commonplace; Rob is a viewer in it; Carol is in nothing. A
# second workspace owned by Carol holds a deck whose card Jamie must not be able
# to adopt. Inserted directly, as blackletter.sh does, so no app_grants row is
# created (test.sh counts Jamie's grants).
$PSQL >/dev/null <<SQL
insert into auth.users (id,email) values ('$ROB','rob@example.com'), ('$CAROL','carol@example.com') on conflict do nothing;
insert into public.profiles (id,email,display_name) values ('$ROB','rob@example.com','Rob'), ('$CAROL','carol@example.com','Carol') on conflict do nothing;
insert into public.workspaces (id,app,slug,name,owner_id,visibility) values
  ('$WS','commonplace','cp-test','Commonplace','$JAMIE','private'),
  ('$OTHER','commonplace','cp-carol','Carol''s','$CAROL','private')
  on conflict do nothing;
insert into public.workspace_members (workspace_id,user_id,role) values
  ('$WS','$JAMIE','owner'), ('$WS','$ROB','viewer'), ('$OTHER','$CAROL','owner')
  on conflict do nothing;
insert into public.cp_decks (id, workspace_id, slug, title) values
  ('d0000000-0000-4000-8000-000000000009', '$OTHER', 'carols', 'Carol''s cards') on conflict do nothing;
insert into public.cp_cards (id, deck_id, position, prompt, answer) values
  ('e0000000-0000-4000-8000-000000000009', 'd0000000-0000-4000-8000-000000000009', 1, 'secret', 'card')
  on conflict do nothing;
SQL

STATE='{"stability":2.3,"difficulty":5.1,"due_at":"2026-10-01T00:00:00Z","last_at":"2026-09-24T00:00:00Z","reps":1,"lapses":0,"state":2,"learning_steps":0,"scheduled_days":7}'
call="public.cp_start_run('$WS','europe','name','{}','all','europe|name',3)"
start="select $call"

echo "── who may play"
check "a member can start a run" ok "select $call is not null;" "$as_jamie"
check "a viewer can play (playing is not editing)" ok "$start;" "$as_rob"
check "a non-member cannot" 42501 "$start;" "$as_carol"
check "nobody signed out can" "permission denied" "$start;" "$as_anon"

echo "── recording answers"
check "an answer and its schedule are written together" ok "do \$\$ declare r uuid; begin
  r := $call;
  perform public.cp_record_answer(r, 'place:FRA:name', 'clean', 1, 0, 2400, '$STATE');
  if not exists (select 1 from public.cp_card_state where card_ref = 'place:FRA:name' and reps = 1 and last_result = 'clean')
    then raise exception 'no state'; end if;
  if (select count(*) from public.cp_run_answers where run_id = r) <> 1 then raise exception 'no answer'; end if;
end \$\$;" "$as_jamie"
check "a mode that does not schedule leaves state alone" ok "do \$\$ declare r uuid; begin
  r := $call;
  perform public.cp_record_answer(r, 'place:FRA:name', 'revealed', 3, 0, 9000, null);
  if exists (select 1 from public.cp_card_state) then raise exception 'state written'; end if;
end \$\$;" "$as_jamie"
check "the first answer to a card in a run is the one kept" ok "do \$\$ declare r uuid; begin
  r := $call;
  perform public.cp_record_answer(r, 'place:FRA:name', 'revealed', 3, 0, 9000, null);
  perform public.cp_record_answer(r, 'place:FRA:name', 'clean', 1, 0, 1000, null);
  if (select result from public.cp_run_answers where run_id = r) <> 'revealed' then raise exception 'overwritten'; end if;
end \$\$;" "$as_jamie"
check "a card reference that is not one is refused" 22023 "do \$\$ declare r uuid; begin
  r := $call; perform public.cp_record_answer(r, 'place:FRA:dance', 'clean', 1, 0, 1, null); end \$\$;" "$as_jamie"
check "an unknown result is refused" 23514 "do \$\$ declare r uuid; begin
  r := $call; perform public.cp_record_answer(r, 'place:FRA:name', 'perfect', 1, 0, 1, null); end \$\$;" "$as_jamie"
check "a nonsense schedule is refused" 23514 "do \$\$ declare r uuid; begin
  r := $call; perform public.cp_record_answer(r, 'place:FRA:name', 'clean', 1, 0, 1,
    '{\"stability\":-1,\"difficulty\":1,\"due_at\":\"2026-10-01\",\"last_at\":\"2026-09-24\",\"reps\":1,\"lapses\":0,\"state\":2}'); end \$\$;" "$as_jamie"
check "nobody may write card state directly" "permission denied" \
  "insert into public.cp_card_state (user_id, card_ref, stability, difficulty, due_at, last_at, state, last_result)
   values ('$JAMIE','place:FRA:name',1,1,now(),now(),2,'clean');" "$as_jamie"
check "nobody may write a run directly" "permission denied" \
  "insert into public.cp_runs (workspace_id,user_id,deck_ref,mode,pb_key,total) values ('$WS','$JAMIE','europe','name','x',1);" "$as_jamie"

echo "── progress is private"
$PSQL >/dev/null <<SQL
begin;
$as_jamie
do \$\$ declare r uuid; begin
  r := public.cp_start_run('$WS','europe','name','{}','all','europe|name|kept',2);
  perform public.cp_record_answer(r, 'place:DEU:name', 'clean', 1, 0, 2000, '$STATE');
  perform public.cp_record_answer(r, 'place:ITA:name', 'hinted', 1, 2, 9000, '$STATE');
  perform public.cp_finish_run(r);
end \$\$;
commit;
SQL
check "Jamie sees his own state" ok "do \$\$ begin if (select count(*) from public.cp_card_state) <> 2 then raise exception 'wrong count'; end if; end \$\$;" "$as_jamie"
check "Rob, in the same project, sees none of it" ok "do \$\$ begin
  if exists (select 1 from public.cp_card_state) then raise exception 'state leaked'; end if;
  if exists (select 1 from public.cp_runs) then raise exception 'runs leaked'; end if;
  if exists (select 1 from public.cp_run_answers) then raise exception 'answers leaked'; end if;
end \$\$;" "$as_rob"
KEPT=$($PSQL -c "select id from public.cp_runs where pb_key = 'europe|name|kept'")
check "Rob cannot record against Jamie's run, even knowing its id" 42501 \
  "select public.cp_record_answer('$KEPT', 'place:FRA:name', 'clean', 1, 0, 1, null);" "$as_rob"
check "or finish it" 42501 "select public.cp_finish_run('$KEPT');" "$as_rob"

echo "── finishing"
check "totals come from the answers and the clock from the server" ok "do \$\$ declare r uuid; j jsonb; begin
  r := $call;
  perform public.cp_record_answer(r, 'place:FRA:name', 'clean', 1, 0, 1, null);
  perform public.cp_record_answer(r, 'place:ESP:name', 'close', 1, 0, 1, null);
  perform public.cp_record_answer(r, 'place:PRT:name', 'revealed', 3, 3, 1, null);
  j := public.cp_finish_run(r);
  if (j->>'clean')::int <> 1 or (j->>'close')::int <> 1 or (j->>'revealed')::int <> 1 or (j->>'hinted')::int <> 0
    then raise exception 'bad totals %', j; end if;
  if (j->>'duration_ms') is null then raise exception 'no duration'; end if;
  if (select finished_at from public.cp_runs where id = r) is null then raise exception 'not stamped'; end if;
end \$\$;" "$as_jamie"
check "an answer after the finish is refused" GRK42 "do \$\$ declare r uuid; begin
  r := $call; perform public.cp_finish_run(r);
  perform public.cp_record_answer(r, 'place:FRA:name', 'clean', 1, 0, 1, null); end \$\$;" "$as_jamie"
check "finishing twice reports the same finish" ok "do \$\$ declare r uuid; a jsonb; b jsonb; begin
  r := $call; perform public.cp_record_answer(r, 'place:FRA:name', 'clean', 1, 0, 1, null);
  a := public.cp_finish_run(r); b := public.cp_finish_run(r);
  if a <> b then raise exception '% then %', a, b; end if; end \$\$;" "$as_jamie"
check "the previous best is an earlier run, never this one" ok "do \$\$ declare r uuid; j jsonb; begin
  r := public.cp_start_run('$WS','europe','name','{}','all','europe|name|kept',2);
  j := public.cp_finish_run(r);
  if (j->'previous_best'->>'known')::int <> 1 then raise exception 'expected the kept run (1 known): %', j; end if;
end \$\$;" "$as_jamie"
check "a first run has no previous best" ok "do \$\$ declare r uuid; j jsonb; begin
  r := public.cp_start_run('$WS','europe','name','{}','all','brand-new-key',2);
  j := public.cp_finish_run(r);
  if j->'previous_best' <> 'null'::jsonb then raise exception 'unexpected best %', j; end if;
end \$\$;" "$as_jamie"

echo "── the daily challenge"
REFS="array['place:FRA:name','place:DEU:name','place:ITA:name']"
$PSQL >/dev/null <<SQL
begin;
$as_jamie
select public.cp_daily_today('$WS','europe',$REFS);
commit;
SQL
check "a later, different proposal gets the first one" ok "do \$\$ declare j jsonb; begin
  j := public.cp_daily_today('$WS','africa', array['place:KEN:name']);
  if j->>'deck_ref' <> 'europe' or jsonb_array_length(j->'card_refs') <> 3 then raise exception 'got %', j; end if;
end \$\$;" "$as_rob"
check "a bad card list is refused" 22023 "select public.cp_daily_today('$WS','europe', array['nope']);" "$as_jamie"
check "one go a day" GRK40 "do \$\$ declare d uuid := (select id from public.cp_daily where workspace_id = '$WS');
  begin
  perform public.cp_start_run('$WS','europe','daily','{}','all','daily',3,d);
  perform public.cp_start_run('$WS','europe','daily','{}','all','daily',3,d); end \$\$;" "$as_jamie"
check "yesterday's challenge cannot be started" GRK41 "do \$\$ declare d uuid; begin
  insert into public.cp_daily (workspace_id, day, deck_ref, card_refs)
    values ('$WS', current_date - 3, 'europe', array['place:FRA:name']) returning id into d;
  set local role authenticated;
  perform public.cp_start_run('$WS','europe','daily','{}','all','daily',1,d); end \$\$;" "$as_jamie set local role postgres;"
$PSQL >/dev/null <<SQL
begin;
$as_rob
do \$\$ declare r uuid; d uuid := (select id from public.cp_daily where workspace_id = '$WS');
begin
  r := public.cp_start_run('$WS','europe','daily','{}','all','daily',3,d);
  perform public.cp_record_answer(r, 'place:FRA:name', 'clean', 1, 0, 1, null);
  perform public.cp_record_answer(r, 'place:DEU:name', 'hinted', 1, 1, 1, null);
  perform public.cp_finish_run(r);
end \$\$;
commit;
SQL
check "the scoreboard shows another member's counts" ok "do \$\$ declare n int; begin
  select count(*) into n from public.cp_daily_scores('$WS') s where s.display_name = 'Rob' and s.clean = 1 and s.hinted = 1 and s.finished;
  if n <> 1 then raise exception 'Rob not on the board'; end if; end \$\$;" "$as_jamie"
check "the scoreboard has no column that could carry a card" ok "do \$\$ begin
  if exists (select 1 from information_schema.parameters
              where specific_name like 'cp_daily_scores%' and parameter_mode = 'OUT'
                and parameter_name ~ 'ref|card|answer|guess')
  then raise exception 'a card column'; end if; end \$\$;"
check "a non-member cannot read the scoreboard" 42501 "select * from public.cp_daily_scores('$WS');" "$as_carol"

echo "── decks"
CARDS='[{"prompt":"the dog","answer":"le chien","accepts":["chien"],"reverse":true},{"prompt":"the cat","answer":"le chat"}]'
check "a viewer cannot save a deck" 42501 "select public.cp_save_deck('$WS', null, 'french', 'French', '{}', '$CARDS');" "$as_rob"
check "an owner can, and the cards arrive in order" ok "do \$\$ declare d uuid; begin
  d := public.cp_save_deck('$WS', null, 'french', 'French', '{}', '$CARDS');
  if (select string_agg(prompt, ',' order by position) from public.cp_cards where deck_id = d) <> 'the dog,the cat'
    then raise exception 'wrong cards'; end if;
  if not (select reverse from public.cp_cards where deck_id = d and position = 1) then raise exception 'reverse lost'; end if;
end \$\$;" "$as_jamie"
check "editing keeps each card's id, and removing one removes only it" ok "do \$\$ declare d uuid; dog uuid; cat uuid; begin
  d := public.cp_save_deck('$WS', null, 'french', 'French', '{}', '$CARDS');
  select id into dog from public.cp_cards where deck_id = d and prompt = 'the dog';
  perform public.cp_save_deck('$WS', d, 'french', 'French words', '{}',
    jsonb_build_array(jsonb_build_object('id', dog, 'prompt', 'the dog', 'answer', 'le chien (m)'),
                      jsonb_build_object('prompt', 'the bird', 'answer', 'l''oiseau')));
  if (select answer from public.cp_cards where id = dog) <> 'le chien (m)' then raise exception 'dog changed id'; end if;
  if exists (select 1 from public.cp_cards where deck_id = d and prompt = 'the cat') then raise exception 'cat survived'; end if;
  if (select count(*) from public.cp_cards where deck_id = d) <> 2 then raise exception 'wrong count'; end if;
  if (select title from public.cp_decks where id = d) <> 'French words' then raise exception 'title'; end if;
end \$\$;" "$as_jamie"
check "a save cannot adopt another deck's card" ok "do \$\$ declare d uuid; begin
  d := public.cp_save_deck('$WS', null, 'thief', 'Thief', '{}',
    '[{\"id\":\"e0000000-0000-4000-8000-000000000009\",\"prompt\":\"mine now\",\"answer\":\"x\"}]');
  if exists (select 1 from public.cp_cards where deck_id = d and id = 'e0000000-0000-4000-8000-000000000009')
    then raise exception 'adopted'; end if;
  set local role postgres;
  if (select prompt from public.cp_cards where id = 'e0000000-0000-4000-8000-000000000009') <> 'secret'
    then raise exception 'Carol''s card was rewritten'; end if;
end \$\$;" "$as_jamie"
check "a save cannot edit a deck in another project" 42501 \
  "select public.cp_save_deck('$OTHER', 'd0000000-0000-4000-8000-000000000009', 'carols', 'Mine', '{}', '[]');" "$as_jamie"
check "an address already taken is a clean error" GRK04 "do \$\$ begin
  perform public.cp_save_deck('$WS', null, 'french', 'French', '{}', '[]');
  perform public.cp_save_deck('$WS', null, 'french', 'French again', '{}', '[]'); end \$\$;" "$as_jamie"
check "a card with no answer is refused" 23514 \
  "select public.cp_save_deck('$WS', null, 'bad', 'Bad', '{}', '[{\"prompt\":\"x\",\"answer\":\"  \"}]');" "$as_jamie"
check "Carol cannot see Jamie's decks" ok "do \$\$ begin
  if exists (select 1 from public.cp_decks where workspace_id = '$WS') then raise exception 'visible'; end if; end \$\$;" "$as_carol"
check "a viewer's delete removes nothing" ok "do \$\$ declare n int; begin
  delete from public.cp_decks where id = 'd0000000-0000-4000-8000-000000000009';
  get diagnostics n = row_count; if n <> 0 then raise exception 'deleted'; end if; end \$\$;" "$as_jamie"

echo "── preferences"
check "preferences are saved and read back" ok "do \$\$ begin
  perform public.cp_set_prefs(0.85, 30);
  if (select new_per_day from public.cp_prefs) <> 30 then raise exception 'not saved'; end if; end \$\$;" "$as_jamie"
check "retention outside FSRS's range is refused" 23514 "select public.cp_set_prefs(0.99, 20);" "$as_jamie"

echo
echo "commonplace: $pass passed, $fail failed"
[ $fail -eq 0 ]
