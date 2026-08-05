-- Platform administrators: the people who may hand out creation rights.
--
-- Workspace ownership answers "who runs this lounge". It does not answer "who
-- may invite a new person to run a lounge of their own", which is a
-- platform-level question and previously had no answer other than service_role.

alter table public.profiles
  add column is_platform_admin boolean not null default false;

-- Seed from current reality: whoever already owns a workspace is running the
-- platform. Deterministic rather than a hardcoded uuid.
update public.profiles p
   set is_platform_admin = true
 where exists (select 1 from public.workspaces w where w.owner_id = p.id);

-- profiles_update_self lets a user update their own row, and `authenticated`
-- holds table-level UPDATE, which implies every column. Without this, any user
-- could set is_platform_admin on themselves.
--
-- Column-level REVOKE does not cut down a table-level grant, so the table-level
-- privilege is withdrawn and only the safe columns re-granted.
--
-- `email` is deliberately NOT re-granted: it is the address invites are matched
-- against. A user who can rewrite their own profiles.email can claim an invite
-- addressed to someone else. (20260805120300 additionally moves that check onto
-- auth.users, so this is one of two independent barriers.)
revoke update on public.profiles from anon, authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

create function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select p.is_platform_admin from public.profiles p where p.id = auth.uid()),
    false
  )
$$;

revoke all on function app.is_platform_admin() from public;
grant execute on function app.is_platform_admin() to anon, authenticated;

-- Admins are not quota-limited: otherwise the person who hands out creation
-- rights has to raise their own ceiling by hand before every new workspace.
create or replace function app.can_create(a app_slug) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_platform_admin() or exists (
    select 1
    from public.app_grants g
    where g.user_id = auth.uid()
      and g.app = a
      and (
        select count(*)
        from public.workspaces w
        where w.owner_id = auth.uid() and w.app = a
      ) < g.max_workspaces
  )
$$;
