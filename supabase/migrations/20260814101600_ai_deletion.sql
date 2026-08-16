-- Letting somebody leave.
--
-- Seven foreign keys from the AI tables to profiles were left at NO ACTION,
-- which is the default and, here, the wrong one. Deleting a workspace owner was
-- already refused by workspaces_owner_id_fkey and always has been — but an
-- *editor*, somebody who owns nothing and merely used a feature once, became
-- undeletable the moment ai_jobs recorded them as an actor.
--
-- That is a right somebody has, quietly removed by a governance layer, which is
-- close to the worst way for a governance layer to be wrong.
--
-- The ledger is a financial record and does not get erased along with them: the
-- same reasoning that denormalises payer_id off the workspace, so that a
-- project changing hands does not rewrite a past invoice. The row stays and
-- loses the name. `ai_admin_spend` joins from profiles, so a deleted person
-- drops out of the per-person view while their spending remains in the totals —
-- which is the honest arrangement, not an oversight.

-- payer_id has to become nullable to be settable to null. Every live path still
-- writes one; only deletion can produce a null, and only for history.
alter table public.ai_jobs  alter column payer_id drop not null;
alter table public.ai_calls alter column payer_id drop not null;

do $$
declare
  r record;
begin
  for r in
    select con.conname, con.conrelid::regclass::text as tbl, att.attname as col
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid = 'public.profiles'::regclass
       and con.confdeltype = 'a'                      -- NO ACTION
       and con.conrelid::regclass::text like 'ai\_%'
  loop
    execute format('alter table public.%I drop constraint %I', r.tbl, r.conname);
    execute format(
      'alter table public.%I add constraint %I foreign key (%I) references public.profiles(id) on delete set null',
      r.tbl, r.conname, r.col
    );
  end loop;
end $$;

comment on column public.ai_calls.payer_id is
  'Null only where the account has since been deleted. The spend stays in the ledger; the name does not.';

-- A call in flight when the account goes has no payer to credit, and
-- ai_periods.payer_id is not null. Settling has to notice rather than raise —
-- the tokens were spent either way, and losing the ledger row would be worse
-- than losing the attribution.
create or replace function public.ai_end_call(
  p_call               uuid,
  p_prompt             integer,
  p_completion         integer,
  p_validator_status   text default null,
  p_validator_findings jsonb default null,
  p_error              text default null
) returns numeric
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_call record;
  v_root record;
  v_cost numeric;
  v_settings record;
  v_failures integer;
begin
  select * into v_call from public.ai_calls where id = p_call for update;
  if not found then
    raise exception 'no such call' using errcode = 'GRK10';
  end if;
  if v_call.status <> 'reserved' then
    raise exception 'that call is already settled' using errcode = 'GRK19';
  end if;

  update public.ai_calls set
    prompt_tokens      = greatest(0, coalesce(p_prompt, 0)),
    completion_tokens  = greatest(0, coalesce(p_completion, 0)),
    status             = case when p_error is null then 'ok' else 'failed' end,
    validator_status   = p_validator_status,
    validator_findings = p_validator_findings,
    error              = p_error,
    settled_at         = now()
  where id = p_call;

  select cost_usd into v_cost from public.ai_calls where id = p_call;

  select r.* into v_root from public.ai_jobs j
    join public.ai_jobs r on r.id = j.root_job_id
   where j.id = v_call.job_id
     for update of r;

  update public.ai_jobs set
    held_usd     = greatest(0, held_usd - v_call.reserved_usd),
    spent_usd    = spent_usd + v_cost,
    heartbeat_at = now()
  where id = v_root.id;

  if v_root.class in ('single', 'interactive') and v_call.payer_id is not null then
    perform app.ai_period_move(v_call.payer_id, -v_call.reserved_usd, v_cost, v_call.created_at);
  end if;

  select * into v_settings from public.ai_platform_settings;

  insert into public.ai_provider_health (provider, model, consecutive_failures, last_error)
  values (
    v_call.provider, v_call.model,
    case when p_error is null then 0 else 1 end,
    p_error
  )
  on conflict (provider, model) do update set
    consecutive_failures = case
      when p_error is null then 0
      else public.ai_provider_health.consecutive_failures + 1
    end,
    last_error = case when p_error is null then null else p_error end,
    updated_at = now()
  returning consecutive_failures into v_failures;

  if p_error is not null and v_failures >= v_settings.breaker_threshold then
    update public.ai_provider_health
       set opened_until = now() + make_interval(mins => v_settings.breaker_minutes),
           opened_count = opened_count + 1
     where provider = v_call.provider and model = v_call.model
       and coalesce(opened_until, now() - interval '1 second') <= now();
  end if;

  return v_cost;
end $$;

-- The reaper has the same problem for the same reason.
create or replace function public.ai_reap() returns table (calls integer, jobs integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_call record; v_job record; v_calls integer := 0; v_jobs integer := 0;
begin
  for v_call in
    select c.*, r.class as root_class, r.id as root_id
      from public.ai_calls c
      join public.ai_jobs j on j.id = c.job_id
      join public.ai_jobs r on r.id = j.root_job_id
     where c.status = 'reserved'
       and c.created_at < now() - interval '15 minutes'
     for update of c
  loop
    update public.ai_calls
       set status = 'released', settled_at = now(), error = 'never settled'
     where id = v_call.id;

    update public.ai_jobs
       set held_usd = greatest(0, held_usd - v_call.reserved_usd)
     where id = v_call.root_id;

    if v_call.root_class in ('single', 'interactive') and v_call.payer_id is not null then
      perform app.ai_period_move(v_call.payer_id, -v_call.reserved_usd, 0, v_call.created_at);
    end if;

    v_calls := v_calls + 1;
  end loop;

  for v_job in
    select * from public.ai_jobs
     where status in ('queued', 'running')
       and coalesce(heartbeat_at, started_at, created_at) < now() - interval '10 minutes'
     for update
  loop
    perform public.ai_end_job(v_job.id, 'failed', 'heartbeat lost');
    v_jobs := v_jobs + 1;
  end loop;

  perform public.ai_enforce_quality_floors();

  return query select v_calls, v_jobs;
end $$;

-- And closing a batch, which credits the envelope back to a payer.
create or replace function public.ai_end_job(p_job uuid, p_status text, p_error text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_job record;
begin
  select * into v_job from public.ai_jobs where id = p_job for update;
  if not found then
    raise exception 'no such job' using errcode = 'GRK10';
  end if;
  if v_job.status in ('done', 'cancelled', 'failed', 'exhausted') then
    return;
  end if;
  if p_status not in ('done', 'cancelled', 'failed', 'exhausted') then
    raise exception 'not an ending' using errcode = 'GRK19';
  end if;

  update public.ai_jobs
     set status = p_status, error = p_error, finished_at = now()
   where id = p_job;

  if v_job.parent_job_id is null and v_job.class in ('batch', 'scheduled')
     and v_job.payer_id is not null then
    perform app.ai_period_move(v_job.payer_id, -v_job.max_usd, v_job.spent_usd, v_job.created_at);
  end if;
end $$;
