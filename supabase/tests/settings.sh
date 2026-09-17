#!/usr/bin/env bash
# Behavioural verification of the project settings migration (20260917120000).
#
# Two properties carry the rest: an address that has moved keeps answering, and
# a project cannot be left with nobody able to administer it.
. "$(dirname "$0")/harness.sh"

CIGARS='2faab0b7-59b1-4616-bba5-47b564925268'   # Jamie's, private
LP='1b1893ef-e69c-4833-b8d4-640b60d2c791'       # Jamie's, public

$PSQL -c "
  insert into auth.users (id,email) values ('$ROB','rob@example.com') on conflict do nothing;
  insert into public.profiles (id,email,display_name) values ('$ROB','rob@example.com','Rob') on conflict do nothing;
" >/dev/null

SU="perform set_config('role','postgres',true);"

echo "── renaming"
check "an owner can rename a project" ok \
  "do \$\$ begin
     update public.workspaces set name = 'The Humidor' where id = '$CIGARS';
     if (select name from public.workspaces where id = '$CIGARS') <> 'The Humidor'
       then raise exception 'name did not change'; end if; end \$\$;" "$as_jamie"
check "a stranger cannot rename it" ok \
  "do \$\$ begin
     update public.workspaces set name = 'Rob''s now' where id = '$LP';
     if (select name from public.workspaces where id = '$LP') = 'Rob''s now'
       then raise exception 'RLS let a non-owner rename a project'; end if; end \$\$;" "$as_rob"
check "an empty name is refused" 23514 \
  "update public.workspaces set name = '' where id = '$CIGARS';" "$as_jamie"
check "an address with spaces in it is refused" 23514 \
  "update public.workspaces set slug = 'not a slug' where id = '$CIGARS';" "$as_jamie"

echo "── the old address keeps answering"
check "changing the address records the old one" ok \
  "do \$\$ begin
     update public.workspaces set slug = 'cedarhouse' where id = '$CIGARS';
     if not exists (select 1 from public.workspace_slug_history
                     where app = 'cigar-lounge' and slug = 'jamie' and workspace_id = '$CIGARS')
       then raise exception 'no forwarding row'; end if; end \$\$;" "$as_jamie"
check "changing it twice forwards both addresses to the project" ok \
  "do \$\$ begin
     update public.workspaces set slug = 'cedarhouse' where id = '$CIGARS';
     update public.workspaces set slug = 'the-humidor' where id = '$CIGARS';
     if (select count(*) from public.workspace_slug_history where workspace_id = '$CIGARS') <> 2
       then raise exception 'expected 2 forwarding rows, got %',
         (select count(*) from public.workspace_slug_history where workspace_id = '$CIGARS'); end if;
   end \$\$;" "$as_jamie"
check "renaming back clears the forwarding row it would shadow" ok \
  "do \$\$ begin
     update public.workspaces set slug = 'cedarhouse' where id = '$CIGARS';
     update public.workspaces set slug = 'jamie'      where id = '$CIGARS';
     if exists (select 1 from public.workspace_slug_history
                 where app = 'cigar-lounge' and slug = 'jamie')
       then raise exception 'a live address is still forwarding'; end if;
     if not exists (select 1 from public.workspace_slug_history
                     where app = 'cigar-lounge' and slug = 'cedarhouse')
       then raise exception 'the address just given up is not forwarding'; end if;
   end \$\$;" "$as_jamie"
check "a new project taking a freed address clears the forwarding row" ok \
  "do \$\$ begin
     update public.workspaces set slug = 'cedarhouse' where id = '$CIGARS';
     perform public.create_workspace('cigar-lounge','jamie','A second lounge');
     if exists (select 1 from public.workspace_slug_history
                 where app = 'cigar-lounge' and slug = 'jamie')
       then raise exception 'the new project is being forwarded away from its own address'; end if;
   end \$\$;" "$as_jamie"
check "one address forwards to one project, the most recent to give it up" ok \
  "do \$\$ declare other uuid; begin
     update public.workspaces set slug = 'cedarhouse' where id = '$CIGARS';
     other := public.create_workspace('cigar-lounge','jamie','A second lounge');
     update public.workspaces set slug = 'elsewhere' where id = other;
     if (select workspace_id from public.workspace_slug_history
          where app = 'cigar-lounge' and slug = 'jamie') <> other
       then raise exception 'forwarding to the wrong project'; end if;
   end \$\$;" "$as_jamie"
check "deleting a project takes its forwarding rows with it" ok \
  "do \$\$ begin
     update public.workspaces set slug = 'cedarhouse' where id = '$CIGARS';
     delete from public.workspaces where id = '$CIGARS';
     if exists (select 1 from public.workspace_slug_history where workspace_id = '$CIGARS')
       then raise exception 'forwarding outlived the project'; end if; end \$\$;" "$as_jamie"

echo "── who may read a forwarding address"
check "a stranger may read one for a public project" ok \
  "do \$\$ begin
     $SU
     update public.workspaces set slug = 'siblings' where id = '$LP';
     perform set_config('role','anon',true);
     if not exists (select 1 from public.workspace_slug_history where slug = 'brothers')
       then raise exception 'a public project''s old address is hidden'; end if; end \$\$;" "$as_anon"
check "a stranger may not read one for a private project" ok \
  "do \$\$ begin
     $SU
     update public.workspaces set slug = 'cedarhouse' where id = '$CIGARS';
     perform set_config('role','authenticated',true);
     if exists (select 1 from public.workspace_slug_history where slug = 'jamie')
       then raise exception 'a private project''s old address leaked'; end if; end \$\$;" "$as_rob"
check "nobody may write the forwarding table by hand" "permission denied" \
  "insert into public.workspace_slug_history (app, slug, workspace_id)
   values ('cigar-lounge','anything','$CIGARS');" "$as_jamie"
check "nor delete from it" "permission denied" \
  "delete from public.workspace_slug_history where slug = 'jamie';" "$as_jamie"

echo "── leaving"
check "a member can take a project off their own list" ok \
  "do \$\$ begin
     $SU
     insert into public.workspace_members (workspace_id,user_id,role) values ('$LP','$ROB','viewer');
     perform set_config('role','authenticated',true);
     perform public.leave_workspace('$LP');
     if exists (select 1 from public.workspace_members where workspace_id='$LP' and user_id='$ROB')
       then raise exception 'still a member'; end if; end \$\$;" "$as_rob"
check "leaving takes nothing else with it" ok \
  "do \$\$ begin
     $SU
     insert into public.workspace_members (workspace_id,user_id,role) values ('$LP','$ROB','editor');
     perform set_config('role','authenticated',true);
     perform public.leave_workspace('$LP');
     -- Asserted as superuser: members_read stops showing Rob the roster the
     -- moment he is off it, so asking as Rob cannot tell a row that is gone
     -- from one that is merely no longer his business.
     $SU
     if not exists (select 1 from public.workspaces where id='$LP')
       then raise exception 'the project went with them'; end if;
     if not exists (select 1 from public.workspace_members where workspace_id='$LP' and user_id='$JAMIE')
       then raise exception 'somebody else''s membership went with them'; end if; end \$\$;" "$as_rob"
check "the last owner cannot leave" GRK21 \
  "select public.leave_workspace('$LP');" "$as_jamie"
check "an owner who is not the last one can" ok \
  "do \$\$ begin
     $SU
     insert into public.workspace_members (workspace_id,user_id,role) values ('$LP','$ROB','owner');
     perform set_config('role','authenticated',true);
     perform public.leave_workspace('$LP');
     $SU
     if (select count(*) from public.workspace_members where workspace_id='$LP' and role='owner') <> 1
       then raise exception 'wrong number of owners left'; end if; end \$\$;" "$as_rob"
check "leaving does not hand over who created it" ok \
  "do \$\$ begin
     $SU
     insert into public.workspace_members (workspace_id,user_id,role) values ('$LP','$ROB','owner');
     perform set_config('role','authenticated',true);
     perform public.leave_workspace('$LP');
     $SU
     if (select owner_id from public.workspaces where id='$LP') <> '$JAMIE'
       then raise exception 'owner_id moved'; end if; end \$\$;" "$as_rob"
check "somebody who is not a member is told so" GRK22 \
  "select public.leave_workspace('$CIGARS');" "$as_rob"
check "leaving a project that does not exist is the same answer" GRK22 \
  "select public.leave_workspace('00000000-0000-4000-8000-000000000000');" "$as_rob"
check "an anonymous visitor cannot call it" 42501 \
  "select public.leave_workspace('$LP');" "$as_anon"

echo "── deleting"
# `set constraints all immediate` in every one of these, and it is the point
# rather than a detail. guard_last_owner() is a DEFERRED constraint trigger, so
# it fires at commit — and check() rolls back, so without this line it never
# fires at all and each of these passes while proving nothing.
check "an owner can delete a project, and its records go with it" ok \
  "delete from public.workspaces where id = '$CIGARS';
   set constraints all immediate;
   do \$\$ begin
     if exists (select 1 from public.cl_cigars where workspace_id = '$CIGARS')
       then raise exception 'records outlived the project'; end if;
     if exists (select 1 from public.workspace_members where workspace_id = '$CIGARS')
       then raise exception 'memberships outlived the project'; end if; end \$\$;" "$as_jamie"

# The one production told us to write. Deleting a project cascades its
# memberships away, so at commit the workspace has no owners left, and the only
# reason that is not an exception is the early return in guard_last_owner() for
# a workspace that no longer exists. The guard was missing from baseline.sql
# until 2026-09-17, so this could not have been asked locally at all.
check "the last-owner guard does not block deleting a project" ok \
  "delete from public.workspaces where id = '$CIGARS';
   set constraints all immediate;
   do \$\$ begin
     if exists (select 1 from public.workspaces where id = '$CIGARS')
       then raise exception 'the project is still there'; end if; end \$\$;" "$as_jamie"
check "a project with two owners deletes just the same" ok \
  "do \$\$ begin
     $SU
     insert into public.workspace_members (workspace_id,user_id,role) values ('$CIGARS','$ROB','owner');
     perform set_config('role','authenticated',true);
   end \$\$;
   delete from public.workspaces where id = '$CIGARS';
   set constraints all immediate;
   do \$\$ begin
     $SU
     if exists (select 1 from public.workspace_members where workspace_id = '$CIGARS')
       then raise exception 'memberships outlived the project'; end if; end \$\$;" "$as_jamie"

# The other side of the same guard: the project stays, so the early return does
# not apply and taking its only owner off it is refused.
check "removing the last owner without deleting the project is still refused" "must keep at least one owner" \
  "delete from public.workspace_members where workspace_id = '$CIGARS' and user_id = '$JAMIE';
   set constraints all immediate;" "$as_jamie"
check "leaving as the last owner is refused before the guard has to say so" GRK21 \
  "select public.leave_workspace('$CIGARS'); set constraints all immediate;" "$as_jamie"

check "a viewer cannot delete a project" ok \
  "do \$\$ begin
     $SU
     insert into public.workspace_members (workspace_id,user_id,role) values ('$CIGARS','$ROB','viewer');
     perform set_config('role','authenticated',true);
     delete from public.workspaces where id = '$CIGARS';
     if not exists (select 1 from public.workspaces where id = '$CIGARS')
       then raise exception 'RLS let a viewer delete a project'; end if; end \$\$;" "$as_rob"

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]
