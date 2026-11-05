#!/usr/bin/env bash
# Behavioural verification of the JPOD migrations.
#
# Run against a throwaway cluster loaded with tests/baseline.sql and every
# migration in order, except 20261105120200_podcasts_sync_schedule — the
# baseline has neither pg_cron nor pg_net, and that file is nothing but them.
#
# What is worth testing, most expensive to get wrong first:
#
#   1. Time is counted once. A sync that reports what was already counted adds
#      nothing; one that reports more adds the difference, dated today; a
#      position that goes backwards adds nothing and takes nothing away.
#   2. The import keeps its dates, and the baseline keeps having none.
#   3. Only the service role can write listening. A viewer reads, an editor
#      tags, and nobody else touches a row.
#   4. Rules apply to history, and take their tag back with them.
. "$(dirname "$0")/harness.sh"

CAROL='9a1f0c22-0000-4000-8000-000000000003'
as_carol="set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$CAROL\",\"email\":\"carol@example.com\"}';"
as_service="set local role service_role;"
WS='e0000000-0000-4000-8000-000000000001'

# Jamie owns a JPOD; Rob is a viewer in it; Carol is in nothing. Inserted
# directly, as commonplace.sh does, so no app_grants row is created.
$PSQL >/dev/null <<SQL
insert into auth.users (id,email) values ('$ROB','rob@example.com'), ('$CAROL','carol@example.com') on conflict do nothing;
insert into public.profiles (id,email,display_name) values ('$ROB','rob@example.com','Rob'), ('$CAROL','carol@example.com','Carol') on conflict do nothing;
insert into public.workspaces (id,app,slug,name,owner_id,visibility) values
  ('$WS','podcasts','jpod-test','JPOD','$JAMIE','private') on conflict do nothing;
insert into public.workspace_members (workspace_id,user_id,role) values
  ('$WS','$JAMIE','owner'), ('$WS','$ROB','viewer') on conflict do nothing;
SQL

# Two shows, three episodes: one dated and finished, one half-heard, one from
# the bulk baseline with no date at all.
IMPORT="select public.jp_ingest('$WS', '[
  {\"show_uuid\":\"s1\",\"show_title\":\"The Argentina Brief\",\"uuid\":\"e1\",\"title\":\"#6 Milei\",
   \"duration_s\":3180,\"position_s\":3180,\"status\":\"played\",\"listened_at\":\"2026-10-26T20:00:00Z\"},
  {\"show_uuid\":\"s2\",\"show_title\":\"Real Dictators\",\"uuid\":\"e2\",\"title\":\"General Videla Part 1\",
   \"duration_s\":3960,\"position_s\":1200,\"status\":\"in_progress\",\"listened_at\":\"2025-02-09T21:00:00Z\"},
  {\"show_uuid\":\"s2\",\"show_title\":\"Real Dictators\",\"uuid\":\"e3\",\"title\":\"Mao Part 1\",
   \"duration_s\":2280,\"position_s\":0,\"status\":\"played\",\"baseline\":true}
]'::jsonb, 'import');"

echo "── Who may write listening ──"
check "the service role imports" ok "$IMPORT" "$as_service"
check "an owner cannot call jp_ingest" "42501" "$IMPORT" "$as_jamie"
check "anon cannot call jp_ingest" "42501" "$IMPORT" "$as_anon"
check "an unknown source is refused" "GRK40" \
  "select public.jp_ingest('$WS', '[]'::jsonb, 'manual');" "$as_service"
check "a workspace that is not a JPOD is refused" "GRK42" \
  "select public.jp_ingest(gen_random_uuid(), '[]'::jsonb, 'import');" "$as_service"
check "an unknown status is refused" "GRK43" \
  "select public.jp_ingest('$WS', '[{\"show_uuid\":\"s\",\"uuid\":\"x\",\"title\":\"t\",\"status\":\"3\"}]'::jsonb, 'sync');" "$as_service"

# Persist the import for the rest of the suite.
$PSQL >/dev/null -c "set role service_role; $IMPORT"

echo "── The import keeps its dates ──"
check "the finished episode is worth its duration, on the day it was heard" ok "
  do \$\$ begin
    assert (select seconds from public.jp_plays p join public.jp_episodes e on e.id = p.episode_id
             where e.pc_uuid = 'e1') = 3180;
    assert (select played_on from public.jp_plays p join public.jp_episodes e on e.id = p.episode_id
             where e.pc_uuid = 'e1') = date '2026-10-26';
  end \$\$;"
check "the half-heard episode is worth its position" ok "
  do \$\$ begin
    assert (select counted_s from public.jp_episodes where pc_uuid = 'e2') = 1200;
  end \$\$;"
check "the baseline is counted and undated" ok "
  do \$\$ begin
    assert (select p.played_on is null and p.seconds = 2280 and e.baseline and e.last_listened_at is null
              from public.jp_plays p join public.jp_episodes e on e.id = p.episode_id where e.pc_uuid = 'e3');
  end \$\$;"
check "importing the same history twice adds nothing" ok "
  $IMPORT
  do \$\$ begin assert (select count(*) from public.jp_plays) = 3; end \$\$;" "$as_service"

echo "── The sync counts only what is new ──"
check "a sync reporting what is already counted adds nothing" ok "
  select public.jp_ingest('$WS', '[{\"show_uuid\":\"s1\",\"show_title\":\"The Argentina Brief\",\"uuid\":\"e1\",
    \"title\":\"#6 Milei\",\"duration_s\":3180,\"position_s\":0,\"status\":\"played\"}]'::jsonb, 'sync');
  do \$\$ begin assert (select count(*) from public.jp_plays) = 3; end \$\$;" "$as_service"
check "further progress adds the difference, dated today" ok "
  select public.jp_ingest('$WS', '[{\"show_uuid\":\"s2\",\"show_title\":\"Real Dictators\",\"uuid\":\"e2\",
    \"title\":\"General Videla Part 1\",\"duration_s\":3960,\"position_s\":2000,\"status\":\"in_progress\"}]'::jsonb, 'sync');
  do \$\$ begin
    assert (select seconds from public.jp_plays where source = 'sync') = 800;
    assert (select played_on from public.jp_plays where source = 'sync') = (now() at time zone 'Europe/London')::date;
  end \$\$;" "$as_service"
check "finishing it adds the remainder of its duration" ok "
  select public.jp_ingest('$WS', '[{\"show_uuid\":\"s2\",\"show_title\":\"Real Dictators\",\"uuid\":\"e2\",
    \"title\":\"General Videla Part 1\",\"duration_s\":3960,\"position_s\":0,\"status\":\"played\"}]'::jsonb, 'sync');
  do \$\$ begin
    assert (select sum(seconds) from public.jp_plays p join public.jp_episodes e on e.id = p.episode_id
             where e.pc_uuid = 'e2') = 3960;
  end \$\$;" "$as_service"
check "a position moving backwards adds nothing" ok "
  select public.jp_ingest('$WS', '[{\"show_uuid\":\"s2\",\"show_title\":\"Real Dictators\",\"uuid\":\"e2\",
    \"title\":\"General Videla Part 1\",\"duration_s\":3960,\"position_s\":300,\"status\":\"in_progress\"}]'::jsonb, 'sync');
  do \$\$ begin
    assert (select count(*) from public.jp_plays p join public.jp_episodes e on e.id = p.episode_id where e.pc_uuid = 'e2') = 1;
    assert (select counted_s from public.jp_episodes where pc_uuid = 'e2') = 1200;
    assert (select position_s from public.jp_episodes where pc_uuid = 'e2') = 300;
  end \$\$;" "$as_service"
check "a new episode from the sync is credited today" ok "
  select public.jp_ingest('$WS', '[{\"show_uuid\":\"s1\",\"show_title\":\"The Argentina Brief\",\"uuid\":\"e9\",
    \"title\":\"#7 Ades\",\"duration_s\":2520,\"position_s\":2300,\"status\":\"in_progress\"}]'::jsonb, 'sync');
  do \$\$ begin
    assert (select p.seconds = 2300 and p.played_on is not null and e.last_listened_at is not null
              from public.jp_plays p join public.jp_episodes e on e.id = p.episode_id where e.pc_uuid = 'e9');
  end \$\$;" "$as_service"

echo "── Reading ──"
check "an owner reads every episode" ok "
  do \$\$ begin assert (select count(*) from public.jp_listen_log) = 3; end \$\$;" "$as_jamie"
check "a viewer reads every episode" ok "
  do \$\$ begin assert (select count(*) from public.jp_listen_log) = 3; end \$\$;" "$as_rob"
check "a stranger reads nothing" ok "
  do \$\$ begin
    assert (select count(*) from public.jp_listen_log) = 0;
    assert (select count(*) from public.jp_plays) = 0;
  end \$\$;" "$as_carol"
check "monthly totals leave the undated baseline out" ok "
  do \$\$ begin
    assert (select coalesce(sum(seconds), 0) from public.jp_monthly('$WS')) = 3180 + 1200;
  end \$\$;" "$as_jamie"
check "show totals include the baseline" ok "
  do \$\$ begin
    assert (select seconds from public.jp_show_summary('$WS') where title = 'Real Dictators') = 1200 + 2280;
  end \$\$;" "$as_jamie"

echo "── Tags ──"
check "an editor tags a show" ok "
  update public.jp_shows set tags = '{argentina}' where pc_uuid = 's1';
  do \$\$ begin assert (select all_tags from public.jp_listen_log where title = '#6 Milei') = '{argentina}'; end \$\$;" "$as_jamie"
check "an editor cannot rename a show" "42501" \
  "update public.jp_shows set title = 'Something else' where pc_uuid = 's1';" "$as_jamie"
check "a viewer cannot tag" ok "
  update public.jp_shows set tags = '{argentina}' where pc_uuid = 's1';
  do \$\$ begin assert (select tags from public.jp_shows where pc_uuid = 's1') = '{}'; end \$\$;" "$as_rob"
check "a tag with a space is refused" "23514" \
  "update public.jp_shows set tags = '{latin america}' where pc_uuid = 's1';" "$as_jamie"
check "a rule tags history at once, and only what it matches" ok "
  insert into public.jp_tag_rules (workspace_id, tag, pattern) values ('$WS', 'argentina', 'videla|milei');
  do \$\$ begin
    assert (select auto_tags from public.jp_episodes where pc_uuid = 'e2') = '{argentina}';
    assert (select auto_tags from public.jp_episodes where pc_uuid = 'e3') = '{}';
  end \$\$;" "$as_jamie"
check "a tagged total counts only tagged episodes of a mixed show" ok "
  insert into public.jp_tag_rules (workspace_id, tag, pattern) values ('$WS', 'argentina', 'videla');
  do \$\$ begin
    assert (select seconds from public.jp_show_summary('$WS', 'argentina') where title = 'Real Dictators') = 1200;
  end \$\$;" "$as_jamie"
check "deleting a rule takes its tag back" ok "
  insert into public.jp_tag_rules (workspace_id, tag, pattern) values ('$WS', 'argentina', 'videla');
  delete from public.jp_tag_rules where pattern = 'videla';
  do \$\$ begin assert (select auto_tags from public.jp_episodes where pc_uuid = 'e2') = '{}'; end \$\$;" "$as_jamie"
check "a pattern that does not compile is refused" "23514" \
  "insert into public.jp_tag_rules (workspace_id, tag, pattern) values ('$WS', 'argentina', 'milei(');" "$as_jamie"
check "a viewer cannot add a rule" "42501" \
  "insert into public.jp_tag_rules (workspace_id, tag, pattern) values ('$WS', 'argentina', 'x');" "$as_rob"
check "a new episode from the sync picks up existing rules" ok "
  insert into public.jp_tag_rules (workspace_id, tag, pattern) values ('$WS', 'patagonia', 'patagonia');
  set local role service_role;
  select public.jp_ingest('$WS', '[{\"show_uuid\":\"s3\",\"show_title\":\"The Science of Birds\",\"uuid\":\"e7\",
    \"title\":\"From the Field: Patagonia\",\"duration_s\":3840,\"position_s\":60,\"status\":\"in_progress\"}]'::jsonb, 'sync');
  do \$\$ begin assert (select auto_tags from public.jp_episodes where pc_uuid = 'e7') = '{patagonia}'; end \$\$;" "$as_jamie"

echo
echo "jpod: $pass passed, $fail failed"
[ $fail -eq 0 ]
