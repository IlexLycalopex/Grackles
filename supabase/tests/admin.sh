#!/usr/bin/env bash
# Behavioural verification of the platform console (20260814101800).
#
# Two properties matter more than the rest and are checked first: that none of
# it answers anybody who is not a platform admin, and that none of it can leave
# the site in a state only the service-role key can recover from.
. "$(dirname "$0")/harness.sh"

CIGARS='2faab0b7-59b1-4616-bba5-47b564925268'   # Jamie's, private

$PSQL -c "
  insert into auth.users (id,email) values ('$ROB','rob@example.com') on conflict do nothing;
  insert into public.profiles (id,email,display_name) values ('$ROB','rob@example.com','Rob') on conflict do nothing;
" >/dev/null

SU="perform set_config('role','postgres',true);"
DOWN="perform set_config('role','authenticated',true);"

echo "── who may ask"
# Every one of them, not a sample: a console is exactly the surface where one
# ungated function is the whole problem.
for fn in admin_overview admin_projects admin_people admin_invites; do
  check "$fn is refused to a non-admin" 42501 "select * from public.$fn();" "$as_rob"
done
check "admin_members is refused to a non-admin" 42501 \
  "select * from public.admin_members('$CIGARS');" "$as_rob"
check "admin_set_grant is refused to a non-admin" 42501 \
  "select public.admin_set_grant('$ROB','cigar-lounge',1);" "$as_rob"
check "admin_set_visibility is refused to a non-admin" 42501 \
  "select public.admin_set_visibility('$CIGARS','public');" "$as_rob"
check "admin_set_platform_admin is refused to a non-admin" 42501 \
  "select public.admin_set_platform_admin('$ROB',true);" "$as_rob"
check "admin_remove_member is refused to a non-admin" 42501 \
  "select public.admin_remove_member('$CIGARS','$JAMIE');" "$as_rob"

echo "── what it can see"
# RLS hides a private project from an admin who is not a member, and rightly so
# on every other page. This is the one that needs the other answer.
check "an admin sees every project, including ones they are not in" ok \
  "do \$\$ declare n bigint; begin
     $SU
     insert into auth.users (id,email) values ('7b000000-0000-4000-8000-000000000001','sam@example.com');
     insert into public.profiles (id,email,display_name)
       values ('7b000000-0000-4000-8000-000000000001','sam@example.com','Sam');
     insert into public.app_grants (user_id,app,max_workspaces)
       values ('7b000000-0000-4000-8000-000000000001','reading-list',1);
     insert into public.workspaces (id,app,slug,name,visibility,owner_id)
       values ('7b000000-0000-4000-8000-0000000000ff','reading-list','sams','Sam''s','private',
               '7b000000-0000-4000-8000-000000000001');
     $DOWN
     select count(*) into n from public.admin_projects()
      where slug = 'sams';
     if n <> 1 then raise exception 'a private project was invisible to the admin'; end if;
   end \$\$;" "$as_jamie"

check "it reports counts, and the entries stay unreadable" ok \
  "do \$\$ declare r record; begin
     $SU
     insert into public.cl_cigars (workspace_id,slug,name)
       values ('$CIGARS','a-test','A test');
     $DOWN
     select * into r from public.admin_projects() where id = '$CIGARS';
     if r.records < 1 then raise exception 'the count did not reach the console'; end if;
   end \$\$;" "$as_jamie"

check "a person's four entitlements arrive together" ok \
  "do \$\$ declare r record; begin
     select * into r from public.admin_people() where id = '$JAMIE';
     if r.is_admin is not true then raise exception 'admin flag missing'; end if;
     if r.owns < 1 then raise exception 'ownership missing'; end if;
     if r.grants is null then raise exception 'grants missing'; end if;
   end \$\$;" "$as_jamie"

echo "── what it can do"
# Verified past RLS deliberately. app_grants_read is "user_id = auth.uid()", so
# an admin checking somebody else's grant through the policy sees nothing and a
# test written that way passes whether or not the grant landed — which is how
# the first version of this reported a failure that was not one, and how the
# withdrawal test beside it passed without proving anything at all.
check "an admin can grant creation rights outside an invitation" ok \
  "do \$\$ begin
     perform public.admin_set_grant('$ROB','cigar-lounge',2);
     $SU
     if not exists (select 1 from public.app_grants
                     where user_id='$ROB' and app='cigar-lounge' and max_workspaces=2) then
       raise exception 'the grant did not land'; end if;
   end \$\$;" "$as_jamie"

check "zero withdraws it" ok \
  "do \$\$ begin
     perform public.admin_set_grant('$ROB','cigar-lounge',2);
     perform public.admin_set_grant('$ROB','cigar-lounge',0);
     $SU
     if exists (select 1 from public.app_grants where user_id='$ROB' and app='cigar-lounge') then
       raise exception 'the grant survived'; end if;
   end \$\$;" "$as_jamie"

# And through the console's own read, which is the path the page actually uses.
check "the console reports the grant it just made" ok \
  "do \$\$ declare g jsonb; begin
     perform public.admin_set_grant('$ROB','reading-list',3);
     select grants into g from public.admin_people() where id = '$ROB';
     if (g->>'reading-list')::integer <> 3 then
       raise exception 'the console did not see it: %', g; end if;
   end \$\$;" "$as_jamie"

check "an admin can change any project's visibility" ok \
  "do \$\$ begin
     perform public.admin_set_visibility('$CIGARS','unlisted');
     if (select visibility from public.workspaces where id='$CIGARS') <> 'unlisted' then
       raise exception 'visibility unchanged'; end if;
   end \$\$;" "$as_jamie"

echo "── what it must not do"
# A site with nobody who can hand out entitlements needs the service-role key to
# recover, and not needing that key is the whole point of the admin flag.
check "the last platform admin cannot be removed" GRK20 \
  "select public.admin_set_platform_admin('$JAMIE', false);" "$as_jamie"

check "one of two admins can be removed" ok \
  "do \$\$ begin
     $SU
     update public.profiles set is_platform_admin = true where id = '$ROB';
     $DOWN
     perform public.admin_set_platform_admin('$ROB', false);
     if (select is_platform_admin from public.profiles where id='$ROB') then
       raise exception 'still an admin'; end if;
   end \$\$;" "$as_jamie"

# A project with no owner cannot be administered by anybody, including the
# admin who just did it.
check "the last owner cannot be demoted" GRK21 \
  "select public.admin_set_member_role('$CIGARS','$JAMIE','viewer');" "$as_jamie"
check "the last owner cannot be removed" GRK21 \
  "select public.admin_remove_member('$CIGARS','$JAMIE');" "$as_jamie"

check "a second owner can be demoted" ok \
  "do \$\$ begin
     $SU
     insert into public.workspace_members (workspace_id,user_id,role)
       values ('$CIGARS','$ROB','owner')
       on conflict (workspace_id,user_id) do update set role='owner';
     $DOWN
     perform public.admin_set_member_role('$CIGARS','$ROB','viewer');
     if (select role from public.workspace_members
          where workspace_id='$CIGARS' and user_id='$ROB') <> 'viewer' then
       raise exception 'not demoted'; end if;
   end \$\$;" "$as_jamie"

echo
echo "passed: $pass   failed: $fail"
[ $fail -eq 0 ]
