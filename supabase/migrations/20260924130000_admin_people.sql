-- The people console.
--
-- The platform console answers "who is in this project" one project at a time.
-- It cannot answer "what can this person reach", which is the question that
-- comes up when somebody joins, leaves, or asks why they cannot see something —
-- and it cannot put an existing person into a project without sending them an
-- invitation to accept, even though they already have an account.
--
-- Same shape as 20260814101800: SECURITY DEFINER, gated on
-- app.is_platform_admin(), metadata and never contents.

/**
 * Every project one person belongs to, and as what.
 *
 * `created_it` is separate from the role because the two can differ: somebody
 * made co-owner of a project they did not start owns it but has not spent any
 * of their allowance on it, and the page says which.
 */
create function public.admin_person_projects(p_user uuid)
returns table (
  workspace_id uuid,
  app          app_slug,
  slug         text,
  name         text,
  visibility   visibility,
  external_url text,
  role         member_role,
  created_it   boolean,
  joined_at    timestamptz
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  return query
  select w.id, w.app, w.slug, w.name, w.visibility, w.external_url,
         m.role, w.owner_id is not distinct from p_user, m.created_at
    from public.workspace_members m
    join public.workspaces w on w.id = m.workspace_id
   where m.user_id = p_user
   order by w.app, w.name;
end $$;

/**
 * Put somebody who already has an account straight into a project.
 *
 * An invitation is the right tool for an address; for a person who is already
 * here it is a round trip through their inbox to arrive at the same row. This
 * refuses rather than overwrites when they are already a member, because
 * "add as viewer" silently demoting an owner is the kind of change nobody
 * meant to make — changing a role is admin_set_member_role's job, with its
 * last-owner guard.
 *
 * Any invitation still waiting for the same person to the same project is
 * withdrawn in the same statement. Left behind, it would sit in both consoles
 * as something outstanding, and accepting it later would do nothing visible.
 */
create function public.admin_add_member(p_workspace uuid, p_user uuid, p_role member_role)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'no such person' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.workspaces where id = p_workspace) then
    raise exception 'no such project' using errcode = 'P0002';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (p_workspace, p_user, p_role)
  on conflict (workspace_id, user_id) do nothing;

  if not found then
    raise exception 'already a member of that project' using errcode = 'GRK24';
  end if;

  -- lower() spelled out although both columns are citext. citext's operators
  -- live in `extensions`, which is not on this function's search_path, so a
  -- bare `=` resolves to text equality and is quietly case-sensitive — the
  -- test for exactly this failed until it said so.
  delete from public.workspace_invites i
   using public.profiles p
   where p.id = p_user
     and i.workspace_id = p_workspace
     and lower(i.email::text) = lower(p.email::text)
     and i.accepted_at is null;
end $$;

revoke all on function public.admin_person_projects(uuid) from public;
grant execute on function public.admin_person_projects(uuid) to authenticated;
revoke all on function public.admin_add_member(uuid, uuid, member_role) from public;
grant execute on function public.admin_add_member(uuid, uuid, member_role) to authenticated;
