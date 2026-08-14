-- When the provider is the thing that is broken.
--
-- Every failure path so far assumes the call was worth making. A provider
-- returning 429 or 500 to everything makes each of four hundred batch items
-- reserve its worst case, wait for a timeout, settle at zero and move on — an
-- afternoon of doing nothing slowly, with the reservations released fifteen
-- minutes behind and the job's items burning their three attempts on the way.
--
-- A breaker is a governance control rather than a resilience one: the decision
-- it makes is "stop spending against this", which is the same kind of decision
-- as a budget refusal and belongs in the same place.

create table public.ai_provider_health (
  provider  text not null,
  model     text not null,

  -- Consecutive, not total. A provider that fails one call in fifty is a
  -- provider working normally; five in a row is a provider that is down.
  consecutive_failures integer not null default 0,

  -- While this is in the future, calls are refused without being attempted.
  opened_until timestamptz,
  last_error   text,
  -- Kept across closings, so the admin page can say "this is the fourth time
  -- today" rather than only "it is open now".
  opened_count integer not null default 0,

  updated_at timestamptz not null default now(),
  primary key (provider, model)
);

alter table public.ai_provider_health enable row level security;
revoke all on public.ai_provider_health from anon, authenticated;

-- Readable by anyone signed in: a page that wants to explain why a button is
-- refusing needs to be able to say "the model is not answering" rather than
-- inventing a reason.
grant select on public.ai_provider_health to authenticated;
create policy ai_provider_health_read on public.ai_provider_health for select using (true);

-- Closing it by hand is an admin action, and the only write offered.
grant update (opened_until, consecutive_failures) on public.ai_provider_health to authenticated;
create policy ai_provider_health_write on public.ai_provider_health
  for update using (app.is_platform_admin()) with check (app.is_platform_admin());

alter table public.ai_platform_settings
  add column breaker_threshold integer not null default 5
    check (breaker_threshold > 0),
  add column breaker_minutes integer not null default 5
    check (breaker_minutes > 0);

-- ── Settlement now moves the breaker ────────────────────────────────────────
--
-- On the settle rather than on the call, because a call that is still in flight
-- has not failed yet — and this is the one place that already knows how it
-- turned out.

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

  if v_root.class in ('single', 'interactive') then
    perform app.ai_period_move(v_call.payer_id, -v_call.reserved_usd, v_cost, v_call.created_at);
  end if;

  -- ── The breaker ──────────────────────────────────────────────────────
  -- A validator failure is not a provider failure: the model answered, and
  -- answered badly. That is the quality floor's business, and counting it here
  -- would trip the breaker on a bad prompt.
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
       -- Not re-opened while already open: a batch settling twenty failures
       -- into an open breaker would push its closing time out by an hour.
       and coalesce(opened_until, now() - interval '1 second') <= now();
  end if;

  return v_cost;
end $$;

-- ── Admission now asks whether the provider is answering ────────────────────

create or replace function public.ai_begin_call(p_job uuid, p_prompt_version integer default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_job     record;
  v_root    record;
  v_feature record;
  v_price   record;
  v_health  record;
  v_id      uuid := gen_random_uuid();
  v_reserve numeric;
begin
  select * into v_job from public.ai_jobs where id = p_job for update;
  if not found then
    raise exception 'no such job' using errcode = 'GRK10';
  end if;

  if v_job.actor_kind <> 'anon' and not app.ai_job_visible(p_job) then
    raise exception 'no such job' using errcode = 'GRK10';
  end if;

  if not (select enabled from public.ai_platform_settings) then
    raise exception 'AI is switched off' using errcode = 'GRK11';
  end if;

  if v_job.status not in ('queued', 'running') then
    raise exception 'that job has finished' using errcode = 'GRK19';
  end if;
  if v_job.cancel_requested then
    raise exception 'that job was cancelled' using errcode = 'GRK19';
  end if;
  if now() > v_job.deadline then
    raise exception 'that job is past its deadline' using errcode = 'GRK19';
  end if;

  select * into v_feature from public.ai_features where key = v_job.feature;
  if not v_feature.enabled or v_feature.auto_disabled_at is not null then
    raise exception 'that feature is switched off' using errcode = 'GRK12';
  end if;

  -- Before the ceilings, because a call that cannot succeed should not consume
  -- one of the job's attempts on the way to finding out.
  select * into v_health from public.ai_provider_health
   where provider = v_feature.provider and model = v_feature.model;

  if found and v_health.opened_until is not null and v_health.opened_until > now() then
    raise exception 'the model is not answering' using errcode = 'GRK1F';
  end if;

  if v_job.calls_made >= v_job.max_calls then
    raise exception 'that job has made all the calls it may' using errcode = 'GRK19';
  end if;

  select * into v_root from public.ai_jobs where id = v_job.root_job_id for update;

  if v_root.id <> v_job.id and v_root.calls_made >= v_root.max_calls then
    raise exception 'that job has made all the calls it may' using errcode = 'GRK19';
  end if;

  select * into v_price from app.ai_price(v_feature.provider, v_feature.model);
  if not found then
    raise exception 'no allowed price for that model' using errcode = 'GRK1C';
  end if;

  v_reserve := app.ai_worst_case(v_job.feature);

  if v_root.spent_usd + v_root.held_usd + v_reserve > v_root.max_usd then
    raise exception 'that job has spent its envelope' using errcode = 'GRK19';
  end if;

  if v_root.class in ('single', 'interactive') then
    if v_reserve > app.ai_remaining(v_root.payer_id) then
      raise exception 'this month''s allowance is spent' using errcode = 'GRK15';
    end if;
    perform app.ai_period_move(v_root.payer_id, v_reserve, 0);
  end if;

  insert into public.ai_calls (
    id, job_id, feature, workspace_id, payer_id, actor_id,
    provider, model, prompt_version, reserved_usd,
    prompt_usd_per_mtok, completion_usd_per_mtok
  ) values (
    v_id, p_job, v_job.feature, v_job.workspace_id, v_job.payer_id, v_job.actor_id,
    v_feature.provider, v_feature.model, p_prompt_version, v_reserve,
    v_price.prompt_usd, v_price.completion_usd
  );

  update public.ai_jobs set
    held_usd   = held_usd + v_reserve,
    calls_made = calls_made + 1
  where id = v_root.id;

  if v_root.id <> v_job.id then
    update public.ai_jobs set calls_made = calls_made + 1 where id = v_job.id;
  end if;

  update public.ai_jobs set
    status       = 'running',
    started_at   = coalesce(started_at, now()),
    heartbeat_at = now()
  where id = p_job;

  return v_id;
end $$;
