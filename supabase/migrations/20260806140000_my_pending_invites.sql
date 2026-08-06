-- The invitations addressed to *you*, which is not what the dashboard was
-- asking for.
--
-- It selected from workspace_invites and let RLS decide. But invites_read is
-- deliberately three things at once:
--
--   app.is_platform_admin()  or  app.is_owner(workspace_id)  or  email = mine
--
-- The middle clause is what the settings page runs on — an owner has to see
-- the invitations they have sent in order to resend, revoke, or copy the link
-- by hand while custom SMTP is still outstanding. On the dashboard the same
-- rows came back as *your* invitations, so the owner of a project was shown an
-- invitation addressed to somebody else, described as "you have been invited
-- as editor", with an Accept button that accept_invite() can only ever refuse
-- with GRK02. There is one such row live right now.
--
-- The second fault was quieter. The dashboard read the project's name through
-- an embedded join, and workspaces_read is public/unlisted OR membership — an
-- invitee is not a member yet, so an invitation to a *private* project came
-- back with no workspace attached at all. The card fell through to its
-- creation-only branch and rendered the words "Start your own" followed by
-- nothing. Every invitation into a private project has read like that.
--
-- Hence a function rather than a filter in the app. It answers only for the
-- caller, and it answers past RLS, because holding an invitation is the
-- authorisation to know what you have been invited to — the same disclosure
-- invite_email_for_token() already makes to anyone holding the token.
--
-- Matching on auth.users.email rather than profiles.email is the same rule
-- accept_invite() applies, for the same reason: profiles is a mirror written
-- by handle_new_user, and this way the list and the button agree by
-- construction. Anything shown here can be accepted; anything acceptable is
-- shown here.

create function public.my_pending_invites()
returns table (
  token           text,
  role            public.member_role,
  workspace_name  text,
  app             public.app_slug,
  grant_apps      public.app_slug[],
  expires_at      timestamptz,
  invited_by_name text
)
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select i.token,
         -- Null on a creation-only invitation. The row still carries a role
         -- because the column is NOT NULL, and reporting that default as if
         -- it meant something is how the old card came to promise membership
         -- of a project that was never part of the invitation.
         case when i.workspace_id is null then null else i.role end,
         w.name,
         w.app,
         i.grant_apps,
         i.expires_at,
         -- Who it came from, which is the one thing that decides whether an
         -- invitation is expected or a surprise. profiles_read is self-or-
         -- shares-a-workspace, so an invitee cannot read this for themselves
         -- until after they have accepted — being definer is what makes it
         -- available at the moment it is actually needed.
         coalesce(nullif(p.display_name, ''), p.email::text)
  from public.workspace_invites i
  left join public.workspaces w on w.id = i.workspace_id
  left join public.profiles p on p.id = i.invited_by
  where i.accepted_at is null
    and i.expires_at > now()
    -- auth.uid() is null for an anonymous caller, so the subquery is null, so
    -- the comparison is null and no row qualifies. Fails closed without a
    -- signed-in check of its own.
    and i.email = (select u.email::citext from auth.users u where u.id = auth.uid())
  order by i.created_at;
$$;

-- anon would get nothing from it anyway; not granting says so on purpose.
revoke all on function public.my_pending_invites() from public, anon;
grant execute on function public.my_pending_invites() to authenticated, service_role;
