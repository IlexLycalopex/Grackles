-- Adding a link to a site that is not served from here.
--
-- `create_workspace()` is the entry point for a project this site serves: it
-- checks the caller's entitlement, seeds the app's default rows, and has no
-- notion of a project that lives somewhere else. Everything outward-pointing
-- has therefore been an INSERT typed into the Supabase editor, which is how
-- the five GitHub Pages sites got here.
--
-- This is the other entry point, and the two stay separate on purpose. A link
-- has no records to seed and no entitlement to spend — there is nothing to run
-- and nothing to bill. What it needs instead is an admin, because a row on the
-- launcher that points off the site is a decision about the site rather than
-- about a project.
--
-- Error codes:
--   GRK04  that app/slug pair is taken (as create_workspace)
--   GRK23  a link has to say where it points

create function public.add_link(
  p_name         text,
  p_url          text,
  p_slug         text,
  p_app          app_slug default 'external',
  p_visibility   visibility default 'public'
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me     uuid := auth.uid();
  new_id uuid;
begin
  -- The boundary, not a courtesy: SECURITY DEFINER means RLS never runs here,
  -- so workspaces_insert is not going to catch anything.
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  -- An empty URL would be a project served from here, which is what
  -- create_workspace() is for and what this function must not become: it
  -- would be a way past the entitlement check.
  if coalesce(btrim(p_url), '') = '' then
    raise exception 'a link has to say where it points' using errcode = 'GRK23';
  end if;

  begin
    insert into public.workspaces (app, slug, name, owner_id, visibility, external_url)
    values (p_app, p_slug, p_name, me, coalesce(p_visibility, 'public'), btrim(p_url))
    returning id into new_id;
  exception when unique_violation then
    raise exception 'the address %/% is already taken', p_app, p_slug
      using errcode = 'GRK04';
  end;

  -- handle_new_workspace() has already added the owner's membership, which is
  -- the row the launcher is actually built from.

  return new_id;
end $$;

revoke all on function public.add_link(text, text, text, app_slug, visibility) from public, anon;
grant execute on function public.add_link(text, text, text, app_slug, visibility)
  to authenticated, service_role;
