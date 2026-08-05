-- create_workspace: the single entry point for making a new workspace.
--
-- Client-side inserts would leave slug validation, entitlement checks and
-- default seeding scattered across three frontends. A raw insert also produces
-- an empty shell — a reading list is not usable until it has a year.
--
-- Error codes:
--   GRK03  no creation entitlement for this app (or quota exhausted)
--   GRK04  that app/slug pair is taken

create function public.create_workspace(
  p_app        app_slug,
  p_slug       text,
  p_name       text,
  p_visibility visibility default 'private'
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me     uuid := auth.uid();
  new_id uuid;
begin
  if me is null then
    raise exception 'you must be signed in to create a workspace'
      using errcode = '42501';
  end if;

  -- SECURITY DEFINER bypasses RLS, so workspaces_insert never runs here.
  -- This check is the security boundary, not a convenience.
  if not app.can_create(p_app) then
    raise exception 'you do not have permission to create another % workspace', p_app
      using errcode = 'GRK03';
  end if;

  begin
    insert into public.workspaces (app, slug, name, owner_id, visibility)
    values (p_app, p_slug, p_name, me, coalesce(p_visibility, 'private'))
    returning id into new_id;
  exception when unique_violation then
    raise exception 'the address %/% is already taken', p_app, p_slug
      using errcode = 'GRK04';
  end;

  -- handle_new_workspace has already added the owner's membership row.

  if p_app = 'reading-list' then
    insert into public.rl_years (workspace_id, year, status)
    values (new_id, extract(year from now())::integer, 'active');

  elsif p_app = 'listening-party' then
    insert into public.lp_contributors (workspace_id, slug, name, color, user_id, sort_order)
    select new_id,
           coalesce(
             nullif(btrim(regexp_replace(lower(p.display_name), '[^a-z0-9]+', '-', 'g'), '-'), ''),
             'owner'
           ),
           coalesce(nullif(p.display_name, ''), 'Owner'),
           '#7c6f57',
           me,
           0
    from public.profiles p
    where p.id = me;
  end if;

  -- cigar-lounge needs no seed rows: humidor and smoked are statuses on
  -- cl_cigars, so an empty lounge is already coherent.

  return new_id;
end;
$$;

revoke all on function public.create_workspace(app_slug, text, text, visibility) from public, anon;
grant execute on function public.create_workspace(app_slug, text, text, visibility)
  to authenticated, service_role;
