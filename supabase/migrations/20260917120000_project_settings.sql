-- What an owner can change about a project, and what happens to the old address
-- when they do.
--
-- Until now the settings page could change a project's subtitle and who may see
-- it, and nothing else. A rename, a change of address, pointing a project at the
-- site that still serves it, and deleting one outright were all SQL typed into
-- the Supabase editor. That is the wrong way round: the two edits with a form
-- are the reversible ones, and the four without are the ones that break links or
-- destroy records.
--
-- Two things here, one of which is only needed because of the other:
--
--   * `workspace_slug_history`, so that changing an address does not break every
--     link to the old one. The address is the thing people have written down.
--   * `leave_workspace()`, because the launcher is built from what you are a
--     member of, and a member who is not an owner has had no way to take
--     something off their own front door. Asking the owner to remove you is not
--     a mechanism, it is a favour.
--
-- Error codes:
--   GRK21  that is the last owner of that project (as admin_remove_member)
--   GRK22  you are not a member of that project

-- ── Where a project used to live ────────────────────────────────────────────

create table public.workspace_slug_history (
  app          app_slug not null,
  slug         text not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  moved_at     timestamptz not null default now(),
  primary key (app, slug)
);

comment on table public.workspace_slug_history is
  'Addresses a project used to answer to. The middleware forwards to the current one.';

create index workspace_slug_history_workspace
  on public.workspace_slug_history (workspace_id);

/**
 * Keeps the forwarding table true as addresses move.
 *
 * SECURITY DEFINER because it writes a table the caller has no privilege on:
 * an owner renaming their project is not being handed the right to edit the
 * forwarding table by hand, and a trigger function runs as the caller unless it
 * says otherwise.
 *
 * The delete is the half that is easy to miss. A slug that is live again is not
 * a forwarding address — if `jamie` is renamed to `jamie-old` and a new project
 * then takes `jamie`, the live row has to win, or the middleware forwards
 * somebody away from a page that exists. The primary key on (app, slug) means
 * there is only ever one answer per address, and this is what decides it.
 */
create function public.remember_workspace_slug() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and (old.app, old.slug) is distinct from (new.app, new.slug) then
    -- `do update` rather than `do nothing`: an address can be given up twice,
    -- and the most recent project to have held it is the one to forward to.
    insert into public.workspace_slug_history (app, slug, workspace_id)
    values (old.app, old.slug, old.id)
    on conflict (app, slug)
      do update set workspace_id = excluded.workspace_id, moved_at = now();
  end if;

  delete from public.workspace_slug_history
   where app = new.app and slug = new.slug;

  return null;
end $$;

create trigger workspaces_remember_slug
  after insert or update of app, slug on public.workspaces
  for each row execute function public.remember_workspace_slug();

alter table public.workspace_slug_history enable row level security;

-- Deliberately a restatement of workspaces_read rather than an `exists` against
-- `workspaces` that would inherit it. The inherited version reads better and is
-- one rule instead of two, but it makes whether a private project's old address
-- leaks depend on RLS applying inside a policy's own subquery — true, and not
-- something the next person should have to be sure of to know this is safe.
create policy workspace_slug_history_read on public.workspace_slug_history for select
  using (exists (
    select 1 from public.workspaces w
     where w.id = workspace_id
       and (w.visibility in ('public', 'unlisted') or app.workspace_role(w.id) is not null)
  ));

-- Read-only to everybody, at the grant level as well as the policy level. The
-- trigger above is the only writer, and it is definer, so it needs none of
-- these. Named for anon too, which holds nothing here, for the reason
-- 20260807150000 gives: a revoke of something not held is free, and the next
-- person should not have to go and check.
grant select on public.workspace_slug_history to anon, authenticated;
revoke insert, update, delete, truncate, references
  on public.workspace_slug_history from anon, authenticated;

-- ── Taking yourself off a project ───────────────────────────────────────────

/**
 * Leave a project you are a member of.
 *
 * `members_manage` is `app.is_owner(workspace_id)` for ALL, so a viewer cannot
 * delete their own membership row — the launcher and the dashboard are built
 * from those rows, which made "take this off my front door" something only
 * somebody else could do for you.
 *
 * Definer rather than a widened policy for the usual reason: a self-delete
 * policy on workspace_members is a policy the next person has to read very
 * carefully, and the guard below is the whole point of the operation.
 *
 * What it deliberately does not do is move `workspaces.owner_id`. That column
 * is who created the project — it spends their creation quota and it is who
 * the AI spend is billed to — and handing both to whoever is left because
 * somebody walked away would be a transfer nobody agreed to. An owner who
 * wants to hand a project over makes somebody else an owner first.
 */
create function public.leave_workspace(p_workspace uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me      uuid := auth.uid();
  my_role member_role;
begin
  if me is null then
    raise exception 'you must be signed in to leave a project' using errcode = '42501';
  end if;

  select role into my_role
    from public.workspace_members
   where workspace_id = p_workspace and user_id = me;

  if my_role is null then
    raise exception 'you are not a member of that project' using errcode = 'GRK22';
  end if;

  if my_role = 'owner' and (
    select count(*) from public.workspace_members
     where workspace_id = p_workspace and role = 'owner' and user_id <> me
  ) = 0 then
    raise exception 'that is the last owner of that project' using errcode = 'GRK21';
  end if;

  delete from public.workspace_members
   where workspace_id = p_workspace and user_id = me;
end $$;

revoke all on function public.leave_workspace(uuid) from public, anon;
grant execute on function public.leave_workspace(uuid) to authenticated, service_role;
