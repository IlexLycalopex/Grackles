-- The admin console's two questions, which RLS cannot express.
--
-- ai_jobs_read and ai_calls_read already let a platform admin see every row,
-- so spend is readable. Names are not: profiles_read is "me, or somebody I
-- share a workspace with", and workspaces_read excludes a private project the
-- admin is not a member of. An admin console that can show what was spent but
-- not by whom, on what, is not a console.
--
-- The answer is the one my_pending_invites() established: the policy is not
-- wrong — every other page needs exactly those clauses — so the page asks a
-- different question through a function scoped to the people allowed to ask it.

create function public.ai_admin_spend(p_period date default null)
returns table (
  payer_id     uuid,
  display_name text,
  email        text,
  limit_usd    numeric,
  committed_usd numeric,
  reserved_usd numeric,
  calls        bigint,
  failures     bigint,
  budget_enabled boolean
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_period date := coalesce(p_period, date_trunc('month', now())::date);
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  -- Every column qualified and every subquery alias renamed away from the OUT
  -- parameters. `payer_id`, `calls` and `failures` are all both — an unqualified
  -- reference resolves to the parameter and Postgres refuses the ambiguity at
  -- call time rather than at creation, so this looks fine until somebody uses it.
  return query
  select
    p.id,
    p.display_name,
    p.email::text,
    coalesce(b.monthly_usd, s.default_monthly_usd),
    coalesce(pe.committed_usd, 0),
    coalesce(pe.reserved_usd, 0),
    coalesce(c.n_calls, 0),
    coalesce(c.n_failures, 0),
    coalesce(b.enabled, false)
  from public.profiles p
  cross join public.ai_platform_settings s
  left join public.ai_budgets b on b.user_id = p.id
  left join public.ai_periods pe on pe.payer_id = p.id and pe.period = v_period
  left join lateral (
    select count(*) as n_calls,
           count(*) filter (where ac.status = 'failed') as n_failures
    from public.ai_calls ac
    where ac.payer_id = p.id
      and date_trunc('month', ac.created_at)::date = v_period
  ) c on true
  -- Everyone who has an allowance or has spent something. A directory of every
  -- account who has never touched AI is a different page.
  where b.user_id is not null or coalesce(pe.committed_usd, 0) > 0
  order by coalesce(pe.committed_usd, 0) desc;
end $$;

-- The queue: everything currently admitted and not finished, across every
-- workspace, with the names an admin needs in order to decide whether to stop
-- one of them.
create function public.ai_admin_queue()
returns table (
  id             uuid,
  feature        text,
  class          text,
  status         text,
  workspace_name text,
  app            app_slug,
  payer_name     text,
  actor_name     text,
  spent_usd      numeric,
  max_usd        numeric,
  calls_made     integer,
  items_done     integer,
  items_total    integer,
  heartbeat_at   timestamptz,
  created_at     timestamptz
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  return query
  select
    j.id, j.feature, j.class, j.status,
    w.name, w.app,
    payer.display_name,
    -- Null actor is either a stranger or the scheduler, and those are very
    -- different things to find in a queue at four in the morning.
    case when j.actor_kind = 'anon' then 'a visitor'
         when j.actor_kind = 'system' then 'the scheduler'
         else actor.display_name end,
    j.spent_usd, j.max_usd, j.calls_made, j.items_done, j.items_total,
    j.heartbeat_at, j.created_at
  from public.ai_jobs j
  left join public.workspaces w on w.id = j.workspace_id
  left join public.profiles payer on payer.id = j.payer_id
  left join public.profiles actor on actor.id = j.actor_id
  where j.status in ('queued', 'running')
  order by j.created_at;
end $$;

-- Granting and changing an allowance. A policy already permits the write, so
-- this exists for the upsert-or-insert case and to record who did it without
-- the page having to remember.
create function public.ai_set_budget(
  p_user uuid, p_monthly_usd numeric, p_enabled boolean default true
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  insert into public.ai_budgets (user_id, monthly_usd, enabled, granted_by)
  values (p_user, p_monthly_usd, p_enabled, auth.uid())
  on conflict (user_id) do update
    set monthly_usd = excluded.monthly_usd,
        enabled     = excluded.enabled,
        granted_by  = excluded.granted_by;
end $$;

revoke all on function public.ai_admin_spend(date) from public;
revoke all on function public.ai_admin_queue() from public;
revoke all on function public.ai_set_budget(uuid, numeric, boolean) from public;
grant execute on function public.ai_admin_spend(date) to authenticated;
grant execute on function public.ai_admin_queue() to authenticated;
grant execute on function public.ai_set_budget(uuid, numeric, boolean) to authenticated;
