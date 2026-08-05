-- accept_invite redeems membership, creation grants, or both.
--
-- The return type changes (workspace_id can now be null, and the caller needs
-- to know what was granted in order to route), so this is a drop and recreate
-- rather than a replace. Nothing calls it in production yet.
--
-- Error codes are custom SQLSTATEs so the UI can branch on cause rather than
-- string-matching a message:
--   GRK01  invite invalid, expired, or already used
--   GRK02  invite belongs to a different email address

drop function if exists public.accept_invite(text);

-- `extensions` is in the search_path because citext lives there on Supabase,
-- and plpgsql resolves the types in DECLARE against the function's own path
-- when the body is validated. Without it this fails to create at all, with
-- "type citext does not exist" — a policy expression referring to citext gets
-- away with the session path, a function body does not.
create function public.accept_invite(invite_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  inv      public.workspace_invites;
  me       uuid := auth.uid();
  my_email citext;
begin
  if me is null then
    raise exception 'you must be signed in to accept an invite'
      using errcode = '42501';
  end if;

  -- auth.users is authoritative. profiles.email is a mirror written by
  -- handle_new_user, and matching an invite against a user-editable column
  -- would let anyone claim an invite addressed to someone else.
  select u.email into my_email from auth.users u where u.id = me;

  select * into inv from public.workspace_invites
  where token = invite_token and accepted_at is null and expires_at > now();

  if not found then
    raise exception 'that invite is invalid, expired, or already used'
      using errcode = 'GRK01';
  end if;

  if inv.email <> my_email then
    raise exception 'that invite was issued to %, but you are signed in as %',
                    inv.email, my_email
      using errcode = 'GRK02',
            hint    = 'sign in with the invited address, or ask the sender to reissue the invite';
  end if;

  if inv.workspace_id is not null then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (inv.workspace_id, me, inv.role)
    on conflict (workspace_id, user_id) do nothing;
  end if;

  if cardinality(inv.grant_apps) > 0 then
    insert into public.app_grants (user_id, app, max_workspaces, granted_by)
    select me, g, 1, inv.invited_by
    from unnest(inv.grant_apps) as g
    on conflict (user_id, app) do nothing;
  end if;

  update public.workspace_invites
     set accepted_at = now(), accepted_by = me
   where id = inv.id;

  return jsonb_build_object(
    'workspace_id', inv.workspace_id,
    'role',         case when inv.workspace_id is null then null else inv.role end,
    'granted_apps', to_jsonb(inv.grant_apps)
  );
end;
$$;

-- Grants do not survive the drop; this restores what 20260730151618 established.
revoke all on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated, service_role;
