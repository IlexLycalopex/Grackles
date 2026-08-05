-- Per-app workspace creation entitlements.
--
-- Until now, membership of a workspace was the only fact recorded about a
-- person. Whether someone could create a workspace of their own was not
-- modelled at all: workspaces_insert checked only `owner_id = auth.uid()`, so
-- any signed-in user could create unlimited workspaces of any app type.
--
-- This makes "guest of someone else's workspace" and "runs their own" into
-- independent facts, so an invite can grant either, both, or neither.
--
-- ORDERING: the backfill must land before the new insert policy, otherwise
-- existing owners immediately lose the ability to create workspaces. Both are
-- in this one migration and therefore one transaction.

create table public.app_grants (
  user_id        uuid        not null references public.profiles (id) on delete cascade,
  app            app_slug    not null,
  max_workspaces integer     not null default 1 check (max_workspaces > 0),
  granted_by     uuid        references public.profiles (id),
  created_at     timestamptz not null default now(),
  primary key (user_id, app)
);

alter table public.app_grants enable row level security;

-- Supabase's default privileges hand new tables full DML to anon and
-- authenticated. Entitlements are not user-writable: they are written by
-- accept_invite (security definer) or by service_role.
revoke all on public.app_grants from anon, authenticated;
grant select on public.app_grants to authenticated;

create policy app_grants_read on public.app_grants
  for select using (user_id = auth.uid());

-- Quota counts workspaces the user *created* (workspaces.owner_id) rather than
-- ones where they hold the 'owner' role, so being invited as a co-owner of
-- someone else's workspace does not consume their own allowance.
create function app.can_create(a app_slug) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
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

revoke all on function app.can_create(app_slug) from public;
grant execute on function app.can_create(app_slug) to anon, authenticated;

-- Backfill: everyone who already owns a workspace keeps the ability to create
-- them, for every app, with at least as much headroom as they currently use.
insert into public.app_grants (user_id, app, max_workspaces)
select owners.id,
       apps.app,
       greatest(1, count(w.id))
from (select distinct owner_id as id from public.workspaces) owners
cross join (select unnest(enum_range(null::app_slug)) as app) apps
left join public.workspaces w
       on w.owner_id = owners.id and w.app = apps.app
group by owners.id, apps.app
on conflict (user_id, app) do nothing;

-- `app` is both a schema name and a column on this table, so the argument is
-- qualified explicitly: bare `app.can_create(app)` is ambiguous to read and a
-- future rename would resolve it the wrong way silently.
drop policy workspaces_insert on public.workspaces;
create policy workspaces_insert on public.workspaces for insert
  with check (owner_id = auth.uid() and app.can_create(workspaces.app));
