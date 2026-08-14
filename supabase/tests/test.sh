#!/usr/bin/env bash
# Behavioural verification of the invite/creation migrations.
# Run against a throwaway cluster loaded with tests/baseline.sql + migrations/.
# Override connection details with PGHOST/PGPORT/PGUSER/PGDATABASE as needed.
. "$(dirname "$0")/harness.sh"

# Rob exists as a user but has no grants and owns nothing.
$PSQL -c "insert into auth.users (id,email) values ('$ROB','rob@example.com') on conflict do nothing;
          insert into public.profiles (id,email,display_name) values ('$ROB','rob@example.com','Rob') on conflict do nothing;" >/dev/null

echo "── backfill and seeding"
check "Jamie holds a grant for all 3 apps" ok \
  "do \$\$ begin if (select count(*) from public.app_grants where user_id='$JAMIE') <> 3
     then raise exception 'expected 3 grants, got %', (select count(*) from public.app_grants where user_id='$JAMIE'); end if; end \$\$;"
check "Jamie is a platform admin" ok \
  "do \$\$ begin if not (select is_platform_admin from public.profiles where id='$JAMIE')
     then raise exception 'not admin'; end if; end \$\$;"
check "Rob has no grants" ok \
  "do \$\$ begin if exists (select 1 from public.app_grants where user_id='$ROB')
     then raise exception 'unexpected grant'; end if; end \$\$;"

echo "── workspace creation"
check "admin creates a workspace beyond quota" ok \
  "select public.create_workspace('cigar-lounge','jamie-two','Second Lounge');" "$as_jamie"
check "ungranted user cannot create" GRK03 \
  "select public.create_workspace('cigar-lounge','rob','Rob''s Lounge');" "$as_rob"
check "ungranted user cannot insert directly (RLS)" "row-level security" \
  "insert into public.workspaces (app,slug,name,owner_id) values ('cigar-lounge','rob','X','$ROB');" "$as_rob"
check "duplicate app/slug is a clean error" GRK04 \
  "select public.create_workspace('cigar-lounge','jamie','Clash');" "$as_jamie"
check "reading-list is seeded with a year" ok \
  "do \$\$ declare w uuid; begin
     w := public.create_workspace('reading-list','jamie-two','RL2');
     if not exists (select 1 from public.rl_years where workspace_id = w) then
       raise exception 'no year seeded'; end if; end \$\$;" "$as_jamie"
check "listening-party is seeded with a contributor" ok \
  "do \$\$ declare w uuid; begin
     w := public.create_workspace('listening-party','jamie-two','LP2');
     if not exists (select 1 from public.lp_contributors where workspace_id = w and user_id = '$JAMIE') then
       raise exception 'no contributor seeded'; end if; end \$\$;" "$as_jamie"

echo "── invite issuing"
check "admin may attach creation grants to an invite" ok \
  "insert into public.workspace_invites (workspace_id,email,role,invited_by,grant_apps)
   values ('2faab0b7-59b1-4616-bba5-47b564925268','rob@example.com','viewer','$JAMIE','{cigar-lounge}');" "$as_jamie"
check "admin may issue a creation-only invite (no workspace)" ok \
  "insert into public.workspace_invites (workspace_id,email,invited_by,grant_apps)
   values (null,'rob@example.com','$JAMIE','{reading-list}');" "$as_jamie"
check "invite with neither purpose is rejected" "workspace_invites_purpose_ck" \
  "insert into public.workspace_invites (workspace_id,email,invited_by)
   values (null,'rob@example.com','$JAMIE');" "$as_jamie"
# The pending-invite index has to keep working once workspace_id can be null,
# or creation-only invites stack up silently and the settings page stops
# reporting duplicates.
check "duplicate creation-only invite is rejected" "workspace_invites_pending_idx" \
  "insert into public.workspace_invites (workspace_id,email,invited_by,grant_apps)
   values (null,'dup@example.com','$JAMIE','{reading-list}');
   insert into public.workspace_invites (workspace_id,email,invited_by,grant_apps)
   values (null,'dup@example.com','$JAMIE','{cigar-lounge}');" "$as_jamie"
check "duplicate membership invite is still rejected" "workspace_invites_pending_idx" \
  "insert into public.workspace_invites (workspace_id,email,role,invited_by)
   values ('2faab0b7-59b1-4616-bba5-47b564925268','dup2@example.com','viewer','$JAMIE');
   insert into public.workspace_invites (workspace_id,email,role,invited_by)
   values ('2faab0b7-59b1-4616-bba5-47b564925268','dup2@example.com','editor','$JAMIE');" "$as_jamie"
# Rob owns a workspace but is not an admin.
$PSQL -c "insert into public.app_grants (user_id,app,max_workspaces) values ('$ROB','cigar-lounge',1);
          insert into public.workspaces (id,app,slug,name,owner_id) values
            ('3c000000-0000-4000-8000-000000000009','cigar-lounge','rob','Rob''s Lounge','$ROB');" >/dev/null
check "non-admin owner may invite into their own workspace" ok \
  "insert into public.workspace_invites (workspace_id,email,role,invited_by)
   values ('3c000000-0000-4000-8000-000000000009','sam@example.com','viewer','$ROB');" "$as_rob"
check "non-admin owner may NOT attach creation grants" "row-level security" \
  "insert into public.workspace_invites (workspace_id,email,role,invited_by,grant_apps)
   values ('3c000000-0000-4000-8000-000000000009','sam@example.com','viewer','$ROB','{cigar-lounge}');" "$as_rob"
check "non-admin cannot invite into someone else's workspace" "row-level security" \
  "insert into public.workspace_invites (workspace_id,email,role,invited_by)
   values ('2faab0b7-59b1-4616-bba5-47b564925268','sam@example.com','viewer','$ROB');" "$as_rob"

echo "── invite acceptance"
$PSQL -c "delete from public.app_grants where user_id='$ROB';
          delete from public.workspaces where owner_id='$ROB';
          insert into public.workspace_invites (workspace_id,email,role,invited_by,grant_apps,token)
          values ('2faab0b7-59b1-4616-bba5-47b564925268','rob@example.com','viewer','$JAMIE','{cigar-lounge}','TOKEN_BOTH');
          insert into public.workspace_invites (workspace_id,email,invited_by,grant_apps,token)
          values (null,'rob@example.com','$JAMIE','{reading-list}','TOKEN_GRANT');
          insert into public.workspace_invites (workspace_id,email,role,invited_by,token)
          values ('2faab0b7-59b1-4616-bba5-47b564925268','someone.else@example.com','viewer','$JAMIE','TOKEN_WRONG');" >/dev/null

check "combined invite grants membership AND creation rights" ok \
  "do \$\$ declare r jsonb; begin
     r := public.accept_invite('TOKEN_BOTH');
     if not exists (select 1 from public.workspace_members
                    where user_id='$ROB' and workspace_id='2faab0b7-59b1-4616-bba5-47b564925268' and role='viewer')
       then raise exception 'no membership'; end if;
     if not exists (select 1 from public.app_grants where user_id='$ROB' and app='cigar-lounge')
       then raise exception 'no grant'; end if;
     if r->>'workspace_id' is null then raise exception 'workspace_id not returned'; end if;
   end \$\$;" "$as_rob"
check "creation-only invite returns null workspace_id" ok \
  "do \$\$ declare r jsonb; begin
     r := public.accept_invite('TOKEN_GRANT');
     if r->>'workspace_id' is not null then raise exception 'unexpected workspace'; end if;
     if not exists (select 1 from public.app_grants where user_id='$ROB' and app='reading-list')
       then raise exception 'no grant'; end if;
   end \$\$;" "$as_rob"
check "invite for another address is refused" GRK02 \
  "select public.accept_invite('TOKEN_WRONG');" "$as_rob"
check "unknown token is refused" GRK01 \
  "select public.accept_invite('nope');" "$as_rob"
check "invite cannot be redeemed twice" GRK01 \
  "select public.accept_invite('TOKEN_BOTH'); select public.accept_invite('TOKEN_BOTH');" "$as_rob"

echo "── resolving an invitation before sign-in"
# The signed-out half of the flow: anon holds a token and nothing else, and has
# to be able to learn which address to send a sign-in link to.
check "anon resolves a pending invite from its token" ok \
  "do \$\$ declare r jsonb; begin
     r := public.invite_email_for_token('TOKEN_BOTH');
     if r is null then raise exception 'no invite returned'; end if;
     if r->>'email' <> 'rob@example.com' then raise exception 'wrong email: %', r->>'email'; end if;
     if r->>'workspace_name' is null then raise exception 'no workspace name'; end if;
   end \$\$;" "$as_anon"
check "unknown token resolves to nothing" ok \
  "do \$\$ begin if public.invite_email_for_token('nope') is not null
     then raise exception 'leaked'; end if; end \$\$;" "$as_anon"
check "accepted invite no longer resolves" ok \
  "do \$\$ begin
     update public.workspace_invites set accepted_at = now() where token = 'TOKEN_GRANT';
     if public.invite_email_for_token('TOKEN_GRANT') is not null
       then raise exception 'spent invite still resolves'; end if; end \$\$;" "$as_jamie"
check "expired invite no longer resolves" ok \
  "do \$\$ begin
     update public.workspace_invites set expires_at = now() - interval '1 day' where token = 'TOKEN_BOTH';
     if public.invite_email_for_token('TOKEN_BOTH') is not null
       then raise exception 'expired invite still resolves'; end if; end \$\$;" "$as_jamie"
check "anon still cannot read the invites table" "permission denied" \
  "select count(*) from public.workspace_invites;" "$as_anon"

echo "── quota after acceptance"
check "granted user creates exactly one, then is capped" GRK03 \
  "select public.accept_invite('TOKEN_BOTH');
   select public.create_workspace('cigar-lounge','rob','Rob''s Lounge');
   select public.create_workspace('cigar-lounge','rob-two','Second');" "$as_rob"

echo "── privilege escalation"
check "user cannot self-promote to platform admin" "permission denied for table profiles" \
  "update public.profiles set is_platform_admin = true where id='$ROB';" "$as_rob"
check "user cannot rewrite their profile email" "permission denied for table profiles" \
  "update public.profiles set email='alexander.jameswatts@gmail.com' where id='$ROB';" "$as_rob"
check "user may still edit their display name" ok \
  "update public.profiles set display_name='Robert' where id='$ROB';" "$as_rob"
check "user cannot write their own entitlements" "permission denied" \
  "insert into public.app_grants (user_id,app,max_workspaces) values ('$ROB','reading-list',99);" "$as_rob"
check "user cannot read another user's entitlements" ok \
  "do \$\$ begin if exists (select 1 from public.app_grants where user_id='$JAMIE')
     then raise exception 'leaked'; end if; end \$\$;" "$as_rob"

echo "── anonymous access"
check "anon cannot read a private workspace's cigars" ok \
  "do \$\$ begin if exists (select 1 from public.cl_cigars
       where workspace_id='2faab0b7-59b1-4616-bba5-47b564925268')
     then raise exception 'leaked'; end if; end \$\$;" "$as_anon"
check "anon cannot write" "permission denied" \
  "insert into public.cl_cigars (workspace_id,slug,name)
   values ('2faab0b7-59b1-4616-bba5-47b564925268','x','X');" "$as_anon"
check "anon cannot read profiles at all" "permission denied" \
  "select count(*) from public.profiles;" "$as_anon"
check "anon can still read a public workspace" ok \
  "do \$\$ begin if not exists (select 1 from public.workspaces where slug='brothers')
     then raise exception 'public workspace not visible'; end if; end \$\$;" "$as_anon"

echo
echo "passed: $pass   failed: $fail"
[ $fail -eq 0 ]
