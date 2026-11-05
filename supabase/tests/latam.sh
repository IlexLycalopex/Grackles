#!/usr/bin/env bash
# Behavioural verification of the LatAm migrations.
#
# Run against a throwaway cluster loaded with tests/baseline.sql and every
# migration in order (the JPOD sync schedule excepted: the baseline has no
# pg_cron).
#
# What is worth testing, most expensive to get wrong first:
#
#   1. A token is the only way in, and only while its owner can still write.
#      A revoked token, a stranger's guess and a demoted editor all get nothing.
#   2. The same entry sent twice is one row.
#   3. Reading is matched, and a doubtful match is saved for checking rather
#      than refused or silently guessed.
#   4. Nobody reads a token's digest, and a viewer cannot resolve To check.
. "$(dirname "$0")/harness.sh"

LX='e1000000-0000-4000-8000-000000000001'
RL='e1000000-0000-4000-8000-000000000002'
TOKEN='lx_testtoken000000000000000000000000000000000000'

# Jamie owns a LatAm and a Reading List; Rob edits the LatAm. Two books in the
# library, one of them being read.
$PSQL >/dev/null <<SQL
insert into auth.users (id,email) values ('$ROB','rob@example.com') on conflict do nothing;
insert into public.profiles (id,email,display_name) values ('$ROB','rob@example.com','Rob') on conflict do nothing;
insert into public.workspaces (id,app,slug,name,owner_id,visibility) values
  ('$LX','latam','lx-test','LatAm','$JAMIE','private'),
  ('$RL','reading-list','rl-lx-test','Reading','$JAMIE','private') on conflict do nothing;
insert into public.workspace_members (workspace_id,user_id,role) values
  ('$LX','$JAMIE','owner'), ('$LX','$ROB','editor'), ('$RL','$JAMIE','owner') on conflict do nothing;
insert into public.rl_library (workspace_id, work_key, title, author, reading) values
  ('$RL', 'facundo', 'Facundo', 'Domingo F. Sarmiento', true),
  ('$RL', 'uttermost', 'Uttermost Part of the Earth', 'Lucas Bridges', false);
insert into public.lx_settings (workspace_id, reading_workspace_id) values ('$LX', '$RL');
insert into public.lx_capture_tokens (workspace_id, user_id, label, token_hash)
  values ('$LX', '$JAMIE', 'Test phone', extensions.digest('$TOKEN', 'sha256'));
SQL

cap() { echo "select public.lx_capture('$1', '$2'::jsonb)"; }
capx() { echo "public.lx_capture('$1', '$2'::jsonb)"; }

echo "── Who may capture ──"
check "a good token captures, as anon" ok "
  $(cap "$TOKEN" '{"id":"a1","type":"lesson","title":"Voseo","minutes":45}');
  reset role;
  do \$\$ begin assert (select count(*) from public.lx_activities where source_ref = 'a1') = 1; end \$\$;" "$as_anon"
check "a wrong token is refused" "GRK52" "$(cap "lx_guess" '{"id":"a2","type":"mate"}');" "$as_anon"
check "a revoked token is refused" "GRK52" "
  update public.lx_capture_tokens set revoked_at = now();
  $(cap "$TOKEN" '{"id":"a3","type":"mate"}');"
check "a token whose owner lost write access is refused" "GRK52" "
  update public.workspace_members set role = 'viewer' where workspace_id = '$LX' and user_id = '$JAMIE';
  $(cap "$TOKEN" '{"id":"a4","type":"mate"}');"
check "anon cannot insert directly" "42501" \
  "insert into public.lx_activities (workspace_id, occurred_on, type, source, source_ref) values ('$LX', current_date, 'mate', 'phone', 'x');" "$as_anon"
check "nobody reads a token's digest" "42501" "select token_hash from public.lx_capture_tokens;" "$as_jamie"
check "an editor creates a token and gets it back once" ok "
  do \$\$ declare t text; begin
    t := public.lx_token_create('$LX', 'Pixel');
    assert t like 'lx\_%';
    assert (select count(*) from public.lx_capture_tokens where label = 'Pixel') = 1;
  end \$\$;" "$as_rob"
check "a stranger cannot create a token" "42501" "select public.lx_token_create('$LX', 'Mine');" "$as_anon"

echo "── What is accepted ──"
check "an unknown type is refused" "GRK54" "$(cap "$TOKEN" '{"id":"b1","type":"dance","minutes":10}');" "$as_anon"
check "a lesson needs minutes" "GRK54" "$(cap "$TOKEN" '{"id":"b2","type":"lesson"}');" "$as_anon"
check "mate needs none" ok "$(cap "$TOKEN" '{"id":"b3","type":"mate"}');" "$as_anon"
check "more than five hours is refused" "GRK54" "$(cap "$TOKEN" '{"id":"b4","type":"film","minutes":301}');" "$as_anon"
check "an entry needs its own id" "GRK54" "$(cap "$TOKEN" '{"type":"film","minutes":90}');" "$as_anon"
check "the same id twice is one row" ok "
  $(cap "$TOKEN" '{"id":"b5","type":"film","title":"Relatos salvajes","minutes":122}');
  do \$\$ begin
    assert ($(capx "$TOKEN" '{"id":"b5","type":"film","title":"Relatos salvajes","minutes":122}')->>'duplicate')::boolean;
    assert (select count(*) from public.lx_activities where source_ref = 'b5') = 1;
  end \$\$;"
check "a lesson is tagged spanish and with the focus" ok "
  $(cap "$TOKEN" '{"id":"b6","type":"lesson","minutes":45,"tags":"Rioplatense"}');
  do \$\$ begin
    assert (select tags from public.lx_activities where source_ref = 'b6') = '{rioplatense,spanish,argentina}';
  end \$\$;"

echo "── Reading is checked ──"
check "a close title matches the book being read" ok "
  do \$\$ declare r jsonb; begin
    r := $(capx "$TOKEN" '{"id":"c1","type":"reading","title":"facundo","minutes":30}');
    assert r->>'state' = 'ok';
    assert (select library_id is not null and title = 'Facundo' from public.lx_activities where source_ref = 'c1');
  end \$\$;"
check "a match on a book not being read says so" ok "
  do \$\$ declare r jsonb; begin
    r := $(capx "$TOKEN" '{"id":"c2","type":"reading","title":"Uttermost part of the earth","minutes":20}');
    assert r->>'message' like '%not marked as being read%';
  end \$\$;"
check "an unknown title is saved and goes to To check" ok "
  do \$\$ declare r jsonb; begin
    r := $(capx "$TOKEN" '{"id":"c3","type":"reading","title":"Rayuela","minutes":25}');
    assert r->>'state' = 'to_check';
    assert (select check_state = 'to_check' and library_id is null from public.lx_activities where source_ref = 'c3');
  end \$\$;"
check "a shared article becomes an article, titled from the page" ok "
  do \$\$ declare r jsonb; begin
    r := $(capx "$TOKEN" '{"id":"c4","type":"reading","minutes":6,"link":"https://example.com/a","page":{"kind":"article","title":"Milei y el peso","words":1200}}');
    assert (select type = 'article' and title = 'Milei y el peso' and check_state = 'ok' from public.lx_activities where source_ref = 'c4');
  end \$\$;"
check "an article logged at far longer than its length is flagged" ok "
  do \$\$ declare r jsonb; begin
    r := $(capx "$TOKEN" '{"id":"c5","type":"article","minutes":90,"page":{"kind":"article","title":"Short piece","words":600}}');
    assert r->>'state' = 'to_check';
  end \$\$;"

echo "── Resolving To check ──"
$PSQL >/dev/null -c "set role anon; $(cap "$TOKEN" '{"id":"d1","type":"reading","title":"Rayuela","minutes":25}');"
check "an editor marks an entry checked" ok "
  update public.lx_activities set check_state = 'ok', check_note = '' where source_ref = 'd1';
  do \$\$ begin assert (select check_state from public.lx_activities where source_ref = 'd1') = 'ok'; end \$\$;" "$as_rob"
check "a viewer cannot" ok "
  update public.lx_activities set check_state = 'ok' where source_ref = 'd1';
  do \$\$ begin assert (select check_state from public.lx_activities where source_ref = 'd1') = 'to_check'; end \$\$;" \
  "update public.workspace_members set role = 'viewer' where workspace_id = '$LX' and user_id = '$ROB'; $as_rob"
check "nobody rewrites where an entry came from" "42501" \
  "update public.lx_activities set source_ref = 'x' where source_ref = 'd1';" "$as_jamie"

echo "── Duolingo ──"
# Each check runs in its own rolled-back transaction, so each replays the
# snapshots it needs.
ing() { echo "select public.lx_duolingo_ingest('$LX', 'Oso_Sur', $1, $(( $1 + 9000 )), 1071);"; }
duo() { echo "(select $1 from public.lx_activities where source = 'duolingo')"; }
check "the first snapshot is a starting line, not practice" ok "
  $(ing 80000)
  do \$\$ begin assert (select count(*) from public.lx_activities where source = 'duolingo') = 0; end \$\$;"
check "growth becomes the day's entry, three XP a minute, tagged spanish" ok "
  $(ing 80000) $(ing 80030)
  do \$\$ begin assert $(duo minutes) = 10; assert $(duo tags) = '{spanish}'; end \$\$;"
check "a later run the same day rewrites the one entry" ok "
  $(ing 80000) $(ing 80030) $(ing 80045)
  do \$\$ begin
    assert (select count(*) from public.lx_activities where source = 'duolingo') = 1;
    assert $(duo title) = 'Spanish · 45 XP';
  end \$\$;"
check "a fall in XP takes nothing away" ok "
  $(ing 80000) $(ing 80045) $(ing 80010)
  do \$\$ begin assert $(duo minutes) = 15; end \$\$;"
check "XP from another account is not compared" ok "
  $(ing 80000) select public.lx_duolingo_ingest('$LX', 'someone_else', 500, 500, 1);
  do \$\$ begin assert (select count(*) from public.lx_activities where source = 'duolingo') = 0; end \$\$;"
check "nobody but the sync ingests" "42501" "$(ing 90000)" "$as_jamie"
check "a username is a username" "23514" "update public.lx_settings set duolingo_username = 'a b' where workspace_id = '$LX';"
check "an editor sets the username" ok "
  update public.lx_settings set duolingo_username = 'Oso_Sur' where workspace_id = '$LX';
  do \$\$ begin assert (select duolingo_username from public.lx_settings where workspace_id = '$LX') = 'Oso_Sur'; end \$\$;" "$as_rob"

echo
echo "latam: $pass passed, $fail failed"
[ $fail -eq 0 ]
