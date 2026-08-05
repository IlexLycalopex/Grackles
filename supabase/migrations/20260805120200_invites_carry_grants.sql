-- Invites can now carry creation rights as well as membership.
--
-- An invite becomes one of three things:
--   membership only  workspace_id set,  grant_apps empty
--   creation only    workspace_id null, grant_apps non-empty
--   both             workspace_id set,  grant_apps non-empty
--
-- "Rob can view my cigar lounge, and run one of his own" is the third case.

alter table public.workspace_invites
  alter column workspace_id drop not null,
  add column grant_apps app_slug[] not null default '{}';

alter table public.workspace_invites
  add constraint workspace_invites_purpose_ck
  check (workspace_id is not null or cardinality(grant_apps) > 0);

-- The security property here: a workspace owner who is not a platform admin
-- may invite people into their own workspace, but may NOT attach creation
-- grants to that invite. Otherwise every owner could mint new tenants.
drop policy invites_manage on public.workspace_invites;
create policy invites_manage on public.workspace_invites for all
  using (
    app.is_platform_admin()
    or (workspace_id is not null and app.is_owner(workspace_id))
  )
  with check (
    invited_by = auth.uid()
    and (
      app.is_platform_admin()
      or (
        workspace_id is not null
        and app.is_owner(workspace_id)
        and cardinality(grant_apps) = 0
      )
    )
  );

-- Invitees match on the JWT address rather than profiles.email, which is a
-- mirror of auth.users and should never be the thing that grants access to an
-- invite token.
drop policy invites_read on public.workspace_invites;
create policy invites_read on public.workspace_invites for select
  using (
    app.is_platform_admin()
    or (workspace_id is not null and app.is_owner(workspace_id))
    or email = (auth.jwt() ->> 'email')::citext
  );
