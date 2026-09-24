#!/usr/bin/env bash
# Behavioural verification of the people console (20260924130000).
#
# Same order as admin.sh: nobody else may ask first, then what it reports, then
# what it changes, then what it must refuse to change.
. "$(dirname "$0")/harness.sh"

CIGARS='2faab0b7-59b1-4616-bba5-47b564925268'   # Jamie's, private

# Somebody of this suite's own rather than Rob, whom the earlier suites leave
# holding a second lounge and a pending invitation — both of which the checks
# below would trip over.
KIT='7c000000-0000-4000-8000-000000000001'
$PSQL -c "
  insert into auth.users (id,email) values ('$KIT','kit@example.com') on conflict do nothing;
  insert into public.profiles (id,email,display_name) values ('$KIT','kit@example.com','Kit') on conflict do nothing;
" >/dev/null

SU="perform set_config('role','postgres',true);"

echo "── who may ask"
check "admin_person_projects is refused to a non-admin" 42501 \
  "select * from public.admin_person_projects('$JAMIE');" "$as_rob"
check "admin_add_member is refused to a non-admin" 42501 \
  "select public.admin_add_member('$CIGARS','$KIT','owner');" "$as_rob"
check "admin_add_member is refused to anon" 42501 \
  "select public.admin_add_member('$CIGARS','$KIT','owner');" "$as_anon"

echo "── what it reports"
check "a person's projects arrive with their role and who started them" ok \
  "do \$\$ declare r record; begin
     select * into r from public.admin_person_projects('$JAMIE') where workspace_id = '$CIGARS';
     if r.role <> 'owner' then raise exception 'role missing: %', r.role; end if;
     if r.created_it is not true then raise exception 'creator flag missing'; end if;
   end \$\$;" "$as_jamie"

check "somebody in nothing has nothing listed" ok \
  "do \$\$ begin
     if exists (select 1 from public.admin_person_projects('$KIT')) then
       raise exception 'Kit is listed in something'; end if;
   end \$\$;" "$as_jamie"

echo "── what it can do"
# Checked past RLS, as admin.sh explains: a membership the admin is not party to
# may be invisible through the policy, and a test that reads it that way passes
# whether or not the row landed.
check "an admin can put an existing person straight into a private project" ok \
  "do \$\$ begin
     perform public.admin_add_member('$CIGARS','$KIT','viewer');
     $SU
     if (select role from public.workspace_members
          where workspace_id='$CIGARS' and user_id='$KIT') is distinct from 'viewer' then
       raise exception 'the membership did not land'; end if;
   end \$\$;" "$as_jamie"

check "and the console then lists it, not as theirs" ok \
  "do \$\$ declare r record; begin
     perform public.admin_add_member('$CIGARS','$KIT','editor');
     select * into r from public.admin_person_projects('$KIT') where workspace_id = '$CIGARS';
     if r.role <> 'editor' then raise exception 'not listed as editor'; end if;
     if r.created_it then raise exception 'listed as having started it'; end if;
   end \$\$;" "$as_jamie"

# An invitation left waiting for somebody who is already in would sit in both
# consoles as outstanding and do nothing when accepted.
check "a waiting invitation to the same project is withdrawn, whatever its case" ok \
  "do \$\$ begin
     insert into public.workspace_invites (workspace_id,email,role,invited_by)
       values ('$CIGARS','Kit@Example.com','viewer','$JAMIE');
     perform public.admin_add_member('$CIGARS','$KIT','viewer');
     $SU
     if exists (select 1 from public.workspace_invites
                 where workspace_id='$CIGARS' and email='kit@example.com'
                   and accepted_at is null) then
       raise exception 'the invitation survived'; end if;
   end \$\$;" "$as_jamie"

check "an invitation to a different project is left alone" ok \
  "do \$\$ begin
     $SU
     insert into public.workspace_invites (workspace_id,email,grant_apps,invited_by)
       values (null,'kit@example.com','{reading-list}','$JAMIE');
     perform set_config('role','authenticated',true);
     perform public.admin_add_member('$CIGARS','$KIT','viewer');
     $SU
     if not exists (select 1 from public.workspace_invites
                     where workspace_id is null and email='kit@example.com') then
       raise exception 'a creation-only invitation was withdrawn'; end if;
   end \$\$;" "$as_jamie"

echo "── what it must not do"
# "Add as viewer" silently demoting an owner is the change nobody meant to make.
check "adding somebody already in refuses rather than changing their role" GRK24 \
  "select public.admin_add_member('$CIGARS','$JAMIE','viewer');" "$as_jamie"

check "and the owner is still an owner afterwards" ok \
  "do \$\$ begin
     begin
       perform public.admin_add_member('$CIGARS','$JAMIE','viewer');
     exception when sqlstate 'GRK24' then null;
     end;
     if (select role from public.workspace_members
          where workspace_id='$CIGARS' and user_id='$JAMIE') <> 'owner' then
       raise exception 'demoted'; end if;
   end \$\$;" "$as_jamie"

check "a person who does not exist is refused" P0002 \
  "select public.admin_add_member('$CIGARS','00000000-0000-4000-8000-000000000000','viewer');" "$as_jamie"
check "a project that does not exist is refused" P0002 \
  "select public.admin_add_member('00000000-0000-4000-8000-000000000000','$KIT','viewer');" "$as_jamie"

echo
echo "passed: $pass   failed: $fail"
[ $fail -eq 0 ]
