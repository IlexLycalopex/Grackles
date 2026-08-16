-- The platform console.
--
-- Whoever runs Grackles can currently see their own projects and administer the
-- ones they are a member of, which is the same view everybody else gets. There
-- is no page that answers "what exists on this site", and the AI console is the
-- only place that answers "what is happening on it" — for one subsystem.
--
-- Everything here is a SECURITY DEFINER read gated on app.is_platform_admin(),
-- for the reason ai_admin_spend() already established: the policies are not
-- wrong. workspaces_read excluding a private project the admin is not in is
-- exactly right for every other page on the site. The console needs a different
-- question asked, by somebody entitled to ask it, and that is a function rather
-- than a weakened policy.
--
-- ONE LINE HELD DELIBERATELY: this shows metadata and counts, never contents.
-- An admin can see that a private Cigar Lounge holds forty entries, who owns it
-- and who may read it; they cannot read the entries. Being able to administer a
-- project is not the same as being able to read it, and collapsing the two
-- would make every private project on the site private only by courtesy.

/**
 * The headline numbers. One round trip for the top of the page.
 */
create function public.admin_overview()
returns table (
  projects        bigint,
  public_projects bigint,
  external        bigint,
  people          bigint,
  admins          bigint,
  memberships     bigint,
  pending_invites bigint,
  ai_spend_usd    numeric,
  ai_jobs_running bigint
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  return query
  select
    (select count(*) from public.workspaces),
    (select count(*) from public.workspaces where visibility = 'public'),
    -- Still served from GitHub Pages. The number that goes down as the
    -- migration finishes, which is worth having somewhere visible.
    (select count(*) from public.workspaces where external_url <> ''),
    (select count(*) from public.profiles),
    (select count(*) from public.profiles where is_platform_admin),
    (select count(*) from public.workspace_members),
    (select count(*) from public.workspace_invites
      where accepted_at is null and expires_at > now()),
    (select coalesce(sum(cost_usd), 0) from public.ai_calls
      where date_trunc('month', created_at) = date_trunc('month', now())),
    (select count(*) from public.ai_jobs where status in ('queued', 'running'));
end $$;

/**
 * Every project on the site.
 *
 * `records` is a count and nothing more — see the note at the top of this file.
 * It is the difference between a project somebody is using and one that was
 * created and forgotten, which is most of what an admin wants to know.
 */
create function public.admin_projects()
returns table (
  id           uuid,
  app          app_slug,
  slug         text,
  name         text,
  visibility   visibility,
  external_url text,
  owner_id     uuid,
  owner_name   text,
  owner_email  text,
  members      bigint,
  records      bigint,
  ai_spend_usd numeric,
  created_at   timestamptz,
  updated_at   timestamptz
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  return query
  select
    w.id, w.app, w.slug, w.name, w.visibility, w.external_url,
    w.owner_id, o.display_name, o.email::text,
    (select count(*) from public.workspace_members m where m.workspace_id = w.id),
    case w.app
      when 'reading-list'    then (select count(*) from public.rl_books b where b.workspace_id = w.id)
      when 'cigar-lounge'    then (select count(*) from public.cl_cigars c where c.workspace_id = w.id)
      when 'listening-party' then (select count(*) from public.lp_selections s where s.workspace_id = w.id)
      when 'wbpr'            then (select count(*) from public.wbpr_broadcasts b where b.workspace_id = w.id)
      when 'blackletter'     then (select count(*) from public.bl_games g where g.workspace_id = w.id)
      -- The four still on GitHub Pages hold nothing here, and an `external_url`
      -- with no rows behind it is the honest answer rather than a missing case.
      else 0::bigint
    end,
    (select coalesce(sum(c.cost_usd), 0) from public.ai_calls c
      where c.workspace_id = w.id
        and date_trunc('month', c.created_at) = date_trunc('month', now())),
    w.created_at, w.updated_at
  from public.workspaces w
  left join public.profiles o on o.id = w.owner_id
  order by w.app, w.slug;
end $$;

/**
 * Every person, and everything that has been granted to them.
 *
 * The four facts that decide what somebody can do here — admin, what they may
 * create, what they may spend, what they belong to — live in four tables and
 * have never been visible together. Handing them out one screen at a time is
 * how somebody ends up with an AI allowance and no way to use it.
 */
create function public.admin_people()
returns table (
  id            uuid,
  display_name  text,
  email         text,
  is_admin      boolean,
  owns          bigint,
  memberships   bigint,
  grants        jsonb,
  ai_monthly_usd numeric,
  ai_enabled    boolean,
  ai_spend_usd  numeric,
  created_at    timestamptz
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_default numeric;
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  select default_monthly_usd into v_default from public.ai_platform_settings;

  return query
  select
    p.id, p.display_name, p.email::text, p.is_platform_admin,
    (select count(*) from public.workspaces w where w.owner_id = p.id),
    (select count(*) from public.workspace_members m where m.user_id = p.id),
    coalesce(
      (select jsonb_object_agg(g.app, g.max_workspaces)
         from public.app_grants g where g.user_id = p.id),
      '{}'::jsonb
    ),
    -- Null means the platform default applies, and the page says so rather
    -- than showing a blank that reads as nothing.
    coalesce(b.monthly_usd, case when b.user_id is null then null else v_default end),
    coalesce(b.enabled, false),
    (select coalesce(sum(c.cost_usd), 0) from public.ai_calls c
      where c.payer_id = p.id
        and date_trunc('month', c.created_at) = date_trunc('month', now())),
    p.created_at
  from public.profiles p
  left join public.ai_budgets b on b.user_id = p.id
  order by p.is_platform_admin desc, p.display_name;
end $$;

/** Every invitation still outstanding, across every project. */
create function public.admin_invites()
returns table (
  id             uuid,
  email          text,
  role           member_role,
  workspace_name text,
  app            app_slug,
  grant_apps     app_slug[],
  invited_by     text,
  created_at     timestamptz,
  expires_at     timestamptz
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  return query
  select i.id, i.email::text, i.role, w.name, w.app, i.grant_apps,
         b.display_name, i.created_at, i.expires_at
    from public.workspace_invites i
    left join public.workspaces w on w.id = i.workspace_id
    left join public.profiles b on b.id = i.invited_by
   where i.accepted_at is null
   order by i.created_at desc;
end $$;

-- ── Controls ────────────────────────────────────────────────────────────────

/**
 * Make or unmake a platform admin.
 *
 * Refuses to remove the last one. A site with nobody who can hand out
 * entitlements is a site that needs the service-role key to recover, and the
 * whole point of this table is to not need that.
 */
create function public.admin_set_platform_admin(p_user uuid, p_is_admin boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  if not p_is_admin and (
    select count(*) from public.profiles
     where is_platform_admin and id <> p_user
  ) = 0 then
    raise exception 'that is the last platform admin' using errcode = 'GRK20';
  end if;

  update public.profiles set is_platform_admin = p_is_admin where id = p_user;
end $$;

/**
 * Hand out or withdraw the right to create a project in an app.
 *
 * Until now this only happened by attaching it to an invitation, which meant
 * granting somebody a second app after they had joined was a service-role
 * operation. Zero withdraws it.
 */
create function public.admin_set_grant(p_user uuid, p_app app_slug, p_max integer)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  if coalesce(p_max, 0) <= 0 then
    delete from public.app_grants where user_id = p_user and app = p_app;
    return;
  end if;

  insert into public.app_grants (user_id, app, max_workspaces, granted_by)
  values (p_user, p_app, p_max, auth.uid())
  on conflict (user_id, app) do update
    set max_workspaces = excluded.max_workspaces,
        granted_by = excluded.granted_by;
end $$;

create function public.admin_set_visibility(p_workspace uuid, p_visibility visibility)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;
  update public.workspaces set visibility = p_visibility where id = p_workspace;
end $$;

create function public.admin_revoke_invite(p_invite uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;
  delete from public.workspace_invites where id = p_invite and accepted_at is null;
end $$;

/**
 * Change or remove somebody's role in any project.
 *
 * The last-owner guard is repeated here rather than left to the trigger,
 * because an admin reaching past RLS is exactly the caller most able to leave a
 * project with nobody able to administer it — and this function is the only
 * path that can do it to a project the caller is not a member of.
 */
create function public.admin_set_member_role(p_workspace uuid, p_user uuid, p_role member_role)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  if p_role <> 'owner' and (
    select count(*) from public.workspace_members
     where workspace_id = p_workspace and role = 'owner' and user_id <> p_user
  ) = 0 then
    raise exception 'that is the last owner of that project' using errcode = 'GRK21';
  end if;

  update public.workspace_members set role = p_role
   where workspace_id = p_workspace and user_id = p_user;
end $$;

create function public.admin_remove_member(p_workspace uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  if (select count(*) from public.workspace_members
       where workspace_id = p_workspace and role = 'owner' and user_id <> p_user) = 0
  then
    raise exception 'that is the last owner of that project' using errcode = 'GRK21';
  end if;

  delete from public.workspace_members
   where workspace_id = p_workspace and user_id = p_user;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'admin_overview()', 'admin_projects()', 'admin_people()', 'admin_invites()',
    'admin_set_platform_admin(uuid, boolean)', 'admin_set_grant(uuid, app_slug, integer)',
    'admin_set_visibility(uuid, visibility)', 'admin_revoke_invite(uuid)',
    'admin_set_member_role(uuid, uuid, member_role)', 'admin_remove_member(uuid, uuid)'
  ]
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

/**
 * Who is in one project.
 *
 * Loaded per project rather than all at once: the console shows it behind a
 * disclosure, and a site with a hundred projects should not fetch every roster
 * to render a page where most of them stay shut.
 *
 * This exists because the console cannot send an admin to /settings/:app/:slug
 * for a project they are not a member of — that page requires ownership, and
 * would 403. A link that refuses is worse than no link, so the console does the
 * job itself rather than pointing at a door it knows is locked.
 */
create function public.admin_members(p_workspace uuid)
returns table (
  user_id      uuid,
  display_name text,
  email        text,
  role         member_role,
  joined_at    timestamptz
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  return query
  select m.user_id, p.display_name, p.email::text, m.role, m.created_at
    from public.workspace_members m
    join public.profiles p on p.id = m.user_id
   where m.workspace_id = p_workspace
   order by m.role, p.display_name;
end $$;

revoke all on function public.admin_members(uuid) from public;
grant execute on function public.admin_members(uuid) to authenticated;
