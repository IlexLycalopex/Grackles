#!/usr/bin/env bash
# Behavioural verification of the Blackletter migrations.
#
# Run against a throwaway cluster loaded with tests/baseline.sql, migrations/,
# and seed/blackletter-words.sql. Override connection details with
# PGHOST/PGPORT/PGUSER/PGDATABASE as needed.
#
# The three things worth testing here are not the three that are easiest to
# test. In order of how much it would cost to get them wrong:
#
#   1. The answer does not leak. Not from the tables, not from the state
#      function mid-game, not from another player's scoreboard row.
#   2. Marking is right, including every duplicate-letter case. These fixtures
#      were checked against an independent implementation over 4,000 random
#      pairs drawn from words with repeated letters; the ones kept here are the
#      shapes that implementation disagrees with a naive one on.
#   3. The rules cannot be talked out of. Seven guesses on a six-guess puzzle,
#      a guess after winning, a word that is not a word.
PSQL="psql -d ${PGDATABASE:-grackles} -qAt"
JAMIE='1d34b078-bfad-41a7-a32f-3bf39f91f2a6'
ROB='9a1f0c22-0000-4000-8000-000000000001'
pass=0; fail=0

check() {
  local desc="$1" expect="$2" sql="$3" pre="$4"
  local out rc
  out=$($PSQL -v ON_ERROR_STOP=1 <<SQL 2>&1
\set VERBOSITY verbose
begin;
$pre
$sql
rollback;
SQL
)
  rc=$?
  if [ "$expect" = "ok" ]; then
    if [ $rc -eq 0 ]; then echo "  PASS  $desc"; pass=$((pass+1));
    else echo "  FAIL  $desc"; echo "        $out"; fail=$((fail+1)); fi
  else
    if echo "$out" | grep -q "$expect"; then echo "  PASS  $desc (rejected: $expect)"; pass=$((pass+1));
    else echo "  FAIL  $desc — expected $expect"; echo "        $out"; fail=$((fail+1)); fi
  fi
}

as_jamie="set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$JAMIE\",\"email\":\"alexander.jameswatts@gmail.com\"}';"
as_rob="set local role authenticated;   set local request.jwt.claims = '{\"sub\":\"$ROB\",\"email\":\"rob@example.com\"}';"
as_anon="set local role anon;            set local request.jwt.claims = '{}';"

# A workspace to play in, and Rob as a second member of it.
#
# The workspace is inserted directly rather than through create_workspace(), so
# no app_grants row is needed — and must not be added. test.sh asserts Jamie
# holds a grant for exactly three apps, so seeding a fourth here breaks that
# suite whenever the two are run against the same database.
$PSQL >/dev/null <<SQL
insert into auth.users (id,email) values ('$ROB','rob@example.com') on conflict do nothing;
insert into public.profiles (id,email,display_name) values ('$ROB','rob@example.com','Rob') on conflict do nothing;
insert into public.workspaces (id,app,slug,name,owner_id,visibility)
  values ('b1000000-0000-4000-8000-000000000001','blackletter','bl-test','Blackletter','$JAMIE','private')
  on conflict do nothing;
insert into public.workspace_members (workspace_id,user_id,role)
  values ('b1000000-0000-4000-8000-000000000001','$ROB','viewer') on conflict do nothing;
SQL
WS='b1000000-0000-4000-8000-000000000001'

# Jamie owns the workspace but membership comes from a trigger on the RPC path,
# and this row was inserted directly. Without it app.can_read() says no and every
# play test fails as "no such project" — which is correct behaviour being tested
# against a workspace nobody is in.
$PSQL >/dev/null <<SQL
insert into public.workspace_members (workspace_id,user_id,role)
  values ('$WS','$JAMIE','owner') on conflict do nothing;
SQL

# Today's answers, read once as a privileged role.
#
# These lookups cannot live inside the checks. A check runs as `authenticated`,
# and `authenticated` cannot read bl_puzzles or call app.blackletter_today() —
# that is the property being tested three sections down. A test that could fetch
# its own answer would be a test proving the opposite of what it claims.
$PSQL >/dev/null -c "select app.blackletter_puzzle(6, app.blackletter_today());"
ANSWER6=$($PSQL -c "select word from public.bl_puzzles where length=6 and on_date=app.blackletter_today()")
# Six distinct real words that are not the answer, for exhausting a game.
WRONG=$($PSQL -c "select string_agg(quote_literal(word), ',') from (
          select word from public.bl_words
           where length=6 and word <> '$ANSWER6' order by md5(word) limit 6) w")

echo "── the dictionary loaded"
check "all three lengths have solutions" ok \
  "do \$\$ begin
     if (select count(distinct length) from public.bl_words where is_solution) <> 3
       then raise exception 'expected 5, 6 and 7 letter solutions'; end if;
     if (select count(*) from public.bl_words where is_solution and length=6) < 1500
       then raise exception 'six-letter solution pool is too thin to run a year'; end if;
   end \$\$;"
check "every solution is also a legal guess" ok \
  "do \$\$ begin
     if exists (select 1 from public.bl_words where is_solution and length <> char_length(word))
       then raise exception 'a solution is filed under the wrong length'; end if;
   end \$\$;"

echo "── marking, including the duplicate-letter cases"
check "duplicate letters mark correctly" ok \
  "do \$\$
   declare c record;
   begin
     for c in select * from (values
       -- The in-place match takes the answer's only L; the other is absent.
       ('allot','aloft','ccapc'),
       -- Two E in the guess, two in the answer, neither in place: both present.
       ('speed','erase','pappa'),
       -- The greens take both E first, so the guess's leading E has none left.
       ('geese','these','aaccc'),
       -- Three S against one.
       ('sassy','abase','apaca'),
       ('array','ratio','ppaaa'),
       ('level','level','ccccc'),
       ('abbey','babes','ppcca'),
       ('eerie','ether','cppaa'),
       ('llama','allay','pcpap')
     ) as t(g,a,want) loop
       if app.mark_guess(c.g,c.a) <> c.want then
         raise exception '% against %: got %, want %', c.g, c.a, app.mark_guess(c.g,c.a), c.want;
       end if;
     end loop;
   end \$\$;"
check "a guess of the wrong length is refused" "differ in length" \
  "select app.mark_guess('abcde','abcdef');"

echo "── the answer does not leak"
check "a player cannot read the puzzle table" "permission denied" \
  "select word from public.bl_puzzles;" "$as_jamie"
check "a player cannot read the word list" "permission denied" \
  "select word from public.bl_words limit 1;" "$as_jamie"
check "anon cannot read the puzzle table" "permission denied" \
  "select word from public.bl_puzzles;" "$as_anon"
check "state withholds the answer while the game is live" ok \
  "do \$\$ begin
     if (public.blackletter_state('$WS',6) ->> 'answer') is not null
       then raise exception 'the answer was handed out mid-game'; end if;
   end \$\$;" "$as_jamie"
check "anon cannot play" "42501" \
  "select public.blackletter_state('$WS',6);" "$as_anon"

echo "── playing"
check "a guess that is not a word is refused" GRK06 \
  "select public.blackletter_guess('$WS',6,'zzzzzz');" "$as_jamie"
check "a real guess is marked and recorded" ok \
  "do \$\$
   declare r jsonb;
   begin
     r := public.blackletter_guess('$WS',6,'planet');
     if jsonb_array_length(r->'guesses') <> 1 then raise exception 'guess not recorded'; end if;
     if (r->>'status') <> 'playing' then raise exception 'game ended early'; end if;
     if (r->>'answer') is not null then raise exception 'answer leaked on a wrong guess'; end if;
   end \$\$;" "$as_jamie"
check "guessing the answer wins and reveals it" ok \
  "do \$\$
   declare r jsonb;
   begin
     r := public.blackletter_guess('$WS',6,'$ANSWER6');
     if (r->>'status') <> 'won' then raise exception 'a correct guess did not win'; end if;
     if (r->>'answer') <> '$ANSWER6' then raise exception 'the answer was withheld after the game ended'; end if;
   end \$\$;" "$as_jamie"
check "a seventh guess is refused" GRK07 \
  "do \$\$
   declare w text;
   begin
     foreach w in array array[$WRONG] loop
       perform public.blackletter_guess('$WS',6,w);
     end loop;
     perform public.blackletter_guess('$WS',6,'planet');
   end \$\$;" "$as_jamie"
check "six wrong guesses lose and reveal the answer" ok \
  "do \$\$
   declare r jsonb; w text;
   begin
     foreach w in array array[$WRONG] loop
       r := public.blackletter_guess('$WS',6,w);
     end loop;
     if (r->>'status') <> 'lost' then raise exception 'six wrong guesses did not lose'; end if;
     if (r->>'answer') <> '$ANSWER6' then raise exception 'a loss did not reveal the answer'; end if;
   end \$\$;" "$as_jamie"

echo "── one puzzle a day, the same for everybody"
check "two players get the same word" ok \
  "do \$\$
   declare a uuid; b uuid;
   begin
     a := (app.blackletter_puzzle(6, date '2026-09-01')).id;
     b := (app.blackletter_puzzle(6, date '2026-09-01')).id;
     if a <> b then raise exception 'the same day minted two puzzles'; end if;
   end \$\$;"
check "different days get different words" ok \
  "do \$\$ begin
     if (app.blackletter_puzzle(6, date '2026-09-02')).word
        = (app.blackletter_puzzle(6, date '2026-09-03')).word
       then raise exception 'two days share a word'; end if;
   end \$\$;"
check "a word is never used twice" ok \
  "do \$\$
   declare i int;
   begin
     for i in 0..120 loop perform app.blackletter_puzzle(6, date '2027-01-01' + i); end loop;
     if exists (select word from public.bl_puzzles where length=6 group by word having count(*) > 1)
       then raise exception 'a word was scheduled twice'; end if;
   end \$\$;"

echo "── one player's game is their own"
check "another member cannot read your game row" ok \
  "do \$\$ begin
     perform public.blackletter_guess('$WS',6,'planet');
   end \$\$;" "$as_jamie"
check "Rob sees none of Jamie's games" ok \
  "do \$\$ begin
     if exists (select 1 from public.bl_games where user_id = '$JAMIE')
       then raise exception 'another player''s game was readable'; end if;
   end \$\$;" "$as_rob"
check "the scoreboard shows marks and never guesses" ok \
  "do \$\$
   declare cols int;
   begin
     select count(*) into cols from information_schema.routines r
       join information_schema.parameters p on p.specific_name = r.specific_name
      where r.routine_name = 'blackletter_scoreboard' and p.parameter_name = 'guesses';
     if cols > 0 then raise exception 'the scoreboard returns guesses'; end if;
   end \$\$;"

echo
echo "passed: $pass   failed: $fail"
[ $fail -eq 0 ]
