-- Settling a call, closing a job and registering a prompt, each asked who is
-- asking.
--
-- Found by the site review of 24 Sep 2026. All three are SECURITY DEFINER and
-- executable by `authenticated` (the first two by `anon` as well), and none of
-- them checked the caller:
--
-- 1. ai_end_call settled any call whose id you held, with whatever token counts
--    and error you cared to name. ai_begin_call has always checked the job is
--    the caller's; its other half never did.
-- 2. ai_end_job closed any job whose id you held, signed in or not.
-- 3. ai_register_prompt accepted any feature name and any body, up to 200
--    versions a feature. Anybody signed in could spend a real feature's 200 on
--    junk, and the next prompt change would then fail to register.
--
-- There is also a problem the ownership check does not reach. The server
-- settles calls with the caller's own session, so a person can always settle
-- their *own* calls however they like — including five in a row "failed",
-- which opened the provider breaker for everybody. The breaker now needs that
-- streak to come from two different payers, or to be confirmed by a platform
-- admin's own call failing, before it opens. One account can no longer switch
-- AI off for the site; a real outage is still caught as soon as a second
-- person, or Jamie, runs into it.

-- ── The breaker: whose failures they were ───────────────────────────────────

alter table public.ai_provider_health
  add column failing_payers uuid[] not null default '{}';

comment on column public.ai_provider_health.failing_payers is
  'Distinct payers in the current failure streak. One payer alone cannot open the breaker unless they are a platform admin.';

-- ── ai_end_call ─────────────────────────────────────────────────────────────

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
  v_job_kind text;
  v_root record;
  v_cost numeric;
  v_settings record;
  v_failures integer;
  v_payers uuid[];
begin
  select * into v_call from public.ai_calls where id = p_call for update;
  if not found then
    raise exception 'no such call' using errcode = 'GRK10';
  end if;

  -- The same rule ai_begin_call applies, and the same answer for "not yours"
  -- as for "does not exist", so a call id cannot be probed for.
  select actor_kind into v_job_kind from public.ai_jobs where id = v_call.job_id;
  if v_job_kind <> 'anon' and not app.ai_job_visible(v_call.job_id) then
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

  insert into public.ai_provider_health (provider, model, consecutive_failures, last_error, failing_payers)
  values (
    v_call.provider, v_call.model,
    case when p_error is null then 0 else 1 end,
    p_error,
    case when p_error is null or v_call.payer_id is null then '{}'::uuid[]
         else array[v_call.payer_id] end
  )
  on conflict (provider, model) do update set
    consecutive_failures = case
      when p_error is null then 0
      else public.ai_provider_health.consecutive_failures + 1
    end,
    last_error = case when p_error is null then null else p_error end,
    failing_payers = case
      when p_error is null then '{}'::uuid[]
      when v_call.payer_id is null
        or v_call.payer_id = any(public.ai_provider_health.failing_payers)
        then public.ai_provider_health.failing_payers
      -- Bounded: only "one or more than one" is ever asked of it.
      else (public.ai_provider_health.failing_payers || v_call.payer_id)[1:10]
    end,
    updated_at = now()
  returning consecutive_failures, failing_payers into v_failures, v_payers;

  if p_error is not null
     and v_failures >= v_settings.breaker_threshold
     and (cardinality(v_payers) >= 2 or app.is_platform_admin()) then
    update public.ai_provider_health
       set opened_until = now() + make_interval(mins => v_settings.breaker_minutes),
           opened_count = opened_count + 1
     where provider = v_call.provider and model = v_call.model
       and coalesce(opened_until, now() - interval '1 second') <= now();
  end if;

  return v_cost;
end $$;

-- ── ai_end_job ──────────────────────────────────────────────────────────────

-- Checked only for a request arriving through the API as `anon` or
-- `authenticated`. ai_reap runs as the service role (or from cron, with no
-- role set) and has no auth.uid() to be visible to; it closes jobs whose
-- heartbeat stopped, which is its whole purpose. The `role` setting is what
-- PostgREST sets per request, and a SECURITY DEFINER call does not change it.
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
  if coalesce(current_setting('role', true), '') in ('anon', 'authenticated')
     and v_job.actor_kind <> 'anon'
     and not app.ai_job_visible(p_job) then
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

-- ── ai_register_prompt ──────────────────────────────────────────────────────

alter table public.ai_prompt_versions
  add column registered_by uuid references public.profiles(id) on delete set null;

-- A feature that exists, a per-person allowance so one account cannot spend a
-- feature's register, and automatic activation only for a platform admin. The
-- prompts every feature ships with were registered long ago; a new feature's
-- first version becomes active the first time Jamie uses it, or by hand.
create or replace function public.ai_register_prompt(p_feature text, p_body text)
returns integer
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_hash  text := md5(p_body);
  v_id    integer;
  v_next  integer;
  v_admin boolean := app.is_platform_admin();
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  if not exists (select 1 from public.ai_features where key = p_feature) then
    raise exception 'no such feature' using errcode = 'GRK10';
  end if;

  select id into v_id from public.ai_prompt_versions
   where feature = p_feature and hash = v_hash;
  if found then return v_id; end if;

  if not v_admin and (
    select count(*) from public.ai_prompt_versions
     where feature = p_feature and registered_by = auth.uid()
  ) >= 20 then
    raise exception 'too many prompt versions for %', p_feature using errcode = 'GRK1A';
  end if;

  select coalesce(max(version), 0) + 1 into v_next
    from public.ai_prompt_versions where feature = p_feature;

  if v_next > 1000 then
    raise exception 'too many prompt versions for %', p_feature using errcode = 'GRK1A';
  end if;

  insert into public.ai_prompt_versions (feature, version, hash, body, active, registered_by)
  values (
    p_feature, v_next, v_hash, p_body,
    v_admin and not exists (select 1 from public.ai_prompt_versions
                             where feature = p_feature and active),
    auth.uid()
  )
  returning id into v_id;

  return v_id;
end $$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE keeps the existing ACL, so these restate it rather than
-- change it. `anon` keeps both settling functions because anonymous jobs are
-- part of the design (actor_kind 'anon', every switch thrown deliberately),
-- and those are now the only jobs it can reach.

revoke all on function public.ai_end_call(uuid, integer, integer, text, jsonb, text) from public;
grant execute on function public.ai_end_call(uuid, integer, integer, text, jsonb, text) to anon, authenticated;

revoke all on function public.ai_end_job(uuid, text, text) from public;
grant execute on function public.ai_end_job(uuid, text, text) to anon, authenticated;

revoke all on function public.ai_register_prompt(text, text) from public, anon;
grant execute on function public.ai_register_prompt(text, text) to authenticated;
