-- Admission, settlement, and the two reapers.
--
-- Four functions and no other route to a provider: ai_begin_job admits, and
-- ai_begin_call / ai_end_call / ai_end_job move the money. They are SECURITY
-- DEFINER because they read platform settings and other people's budgets —
-- questions RLS deliberately cannot express for the caller, the same reasoning
-- as my_pending_invites().
--
-- Everything expensive to decide happens once per job rather than once per
-- call, which is what makes a four-hundred-item batch a single decision
-- instead of four hundred identical ones.

-- A flat worst case for the prompt side of a call. The desk's transcript tops
-- out around 8k tokens for a four-block night; the headroom is deliberate,
-- because an under-reservation is a budget that can be exceeded.
alter table public.ai_platform_settings
  add column prompt_allowance_tokens integer not null default 12000
    check (prompt_allowance_tokens > 0);

-- ── Helpers ─────────────────────────────────────────────────────────────────

create function app.ai_role_rank(r text) returns integer
language sql immutable as $$
  select case r
    when 'owner'  then 3
    when 'editor' then 2
    when 'viewer' then 1
    else 0
  end
$$;

-- The price in force now for a model, or nothing if it is not allowed. Read at
-- admission and again per call, and snapshotted onto the call so that changing
-- a price never restates history.
create function app.ai_price(p_provider text, p_model text)
returns table (prompt_usd numeric, completion_usd numeric)
language sql stable as $$
  select prompt_usd_per_mtok, completion_usd_per_mtok
  from public.ai_models
  where provider = p_provider and model = p_model
    and allowed and effective_from <= now()
  order by effective_from desc
  limit 1
$$;

-- What one call of a feature costs at its very worst.
create function app.ai_worst_case(p_feature text)
returns numeric
language plpgsql stable as $$
declare
  v_f record; v_p record; v_allowance integer;
begin
  select * into v_f from public.ai_features where key = p_feature;
  if not found then
    raise exception 'no such feature: %', p_feature using errcode = 'GRK12';
  end if;

  select * into v_p from app.ai_price(v_f.provider, v_f.model);
  if not found then
    raise exception 'no allowed price for %/%', v_f.provider, v_f.model
      using errcode = 'GRK1C';
  end if;

  select prompt_allowance_tokens into v_allowance from public.ai_platform_settings;

  return (v_f.max_tokens::numeric * v_p.completion_usd / 1000000)
       + (v_allowance::numeric    * v_p.prompt_usd     / 1000000);
end $$;

-- What is left of a payer's allowance this month. Reserved and committed are
-- summed, so two concurrent calls cannot both fit into the last penny.
create function app.ai_remaining(p_payer uuid)
returns numeric
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_limit numeric; v_enabled boolean; v_default numeric; v_used numeric;
begin
  select default_monthly_usd into v_default from public.ai_platform_settings;

  select coalesce(b.monthly_usd, v_default), b.enabled
    into v_limit, v_enabled
    from public.ai_budgets b where b.user_id = p_payer;

  -- Default deny. No row is a refusal, not an unlimited default — the same
  -- rule as app_grants, and the one most likely to be lost to a coalesce.
  if not found or not v_enabled then return 0; end if;

  select coalesce(reserved_usd + committed_usd, 0) into v_used
    from public.ai_periods
   where payer_id = p_payer and period = date_trunc('month', now())::date;

  return greatest(0, v_limit - coalesce(v_used, 0));
end $$;

-- Move a payer's period counters. Upserts, because the first call of a month
-- has no row to update.
create function app.ai_period_move(p_payer uuid, p_reserved numeric, p_committed numeric, p_when timestamptz default now())
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.ai_periods (payer_id, period, reserved_usd, committed_usd)
  values (p_payer, date_trunc('month', p_when)::date, greatest(0, p_reserved), greatest(0, p_committed))
  on conflict (payer_id, period) do update set
    reserved_usd  = greatest(0, public.ai_periods.reserved_usd  + p_reserved),
    committed_usd = greatest(0, public.ai_periods.committed_usd + p_committed);
end $$;

-- ── Admission ───────────────────────────────────────────────────────────────

create function public.ai_begin_job(
  p_feature     text,
  p_workspace   uuid,
  p_class       text default 'single',
  p_max_usd     numeric default null,
  p_max_calls   integer default null,
  p_parent      uuid default null,
  p_fingerprint text default null,
  p_items_total integer default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id        uuid := gen_random_uuid();
  v_actor     uuid := auth.uid();
  v_kind      text;
  v_ws        record;
  v_platform  record;
  v_feature   record;
  v_wsf       record;
  v_parent    record;
  v_role      text;
  v_root      uuid;
  v_depth     integer := 0;
  v_max_usd   numeric;
  v_max_calls integer;
  v_call_usd  numeric;
  v_need      numeric;
  v_rate      integer;
  v_today     numeric;
begin
  -- 1. The workspace exists and this caller may see it. First, always:
  --    everything after this may reveal that it exists, and a private project
  --    must not announce itself by refusing an AI job differently from a
  --    missing one.
  select id, owner_id, visibility into v_ws from public.workspaces where id = p_workspace;
  if not found or not app.can_read(p_workspace) then
    raise exception 'no such project' using errcode = 'GRK10';
  end if;

  select * into v_feature from public.ai_features where key = p_feature;
  if not found then
    raise exception 'no such feature' using errcode = 'GRK12';
  end if;

  -- ── A child job inherits its root's admission ────────────────────────────
  -- Re-checking a budget the root already reserved would refuse children out
  -- of an envelope with money in it, which is the failure that makes fan-out
  -- unusable. Only the depth limit has anything left to say.
  if p_parent is not null then
    select * into v_parent from public.ai_jobs where id = p_parent;
    if not found or v_parent.status not in ('queued', 'running') then
      raise exception 'no such parent job' using errcode = 'GRK10';
    end if;

    v_depth := v_parent.depth + 1;
    if v_depth > v_feature.max_depth then
      raise exception 'too deep' using errcode = 'GRK17';
    end if;

    insert into public.ai_jobs (
      id, feature, workspace_id, class, payer_id, actor_id, actor_kind,
      actor_fingerprint, parent_job_id, root_job_id, depth,
      max_usd, max_calls, deadline, items_total, status, started_at, heartbeat_at
    ) values (
      v_id, p_feature, p_workspace, p_class, v_parent.payer_id, v_parent.actor_id,
      v_parent.actor_kind, v_parent.actor_fingerprint, p_parent, v_parent.root_job_id, v_depth,
      0, coalesce(p_max_calls, v_feature.default_max_calls), v_parent.deadline,
      p_items_total, 'running', now(), now()
    );
    return v_id;
  end if;

  -- 2. The platform is on.
  select * into v_platform from public.ai_platform_settings;
  if not v_platform.enabled then
    raise exception 'AI is switched off' using errcode = 'GRK11';
  end if;
  if not v_platform.admissions_open then
    raise exception 'no new AI work is being accepted' using errcode = 'GRK1B';
  end if;

  -- 3. The feature is on.
  if not v_feature.enabled or v_feature.auto_disabled_at is not null then
    raise exception 'that feature is switched off' using errcode = 'GRK12';
  end if;

  -- 4. The workspace has it on.
  select * into v_wsf from public.ai_workspace_features
   where workspace_id = p_workspace and feature = p_feature;
  if found and not v_wsf.enabled then
    raise exception 'that feature is off for this project' using errcode = 'GRK12';
  end if;
  if p_class = 'scheduled' and not coalesce(v_wsf.allow_scheduled, false) then
    raise exception 'unattended work is off for this project' using errcode = 'GRK12';
  end if;

  -- 5. The actor is allowed to run it.
  if v_actor is null then
    v_kind := 'anon';
    -- Three conditions, all required. Spending an owner's money without
    -- signing in is the one path that needs every switch thrown deliberately.
    if v_feature.min_role <> 'anon'
       or not coalesce(v_wsf.allow_anon, false)
       or v_ws.visibility <> 'public' then
      raise exception 'not allowed here' using errcode = 'GRK13';
    end if;
  else
    v_kind := 'user';
    v_role := coalesce(app.workspace_role(p_workspace)::text, 'anon');
    if app.ai_role_rank(v_role) < app.ai_role_rank(v_feature.min_role) then
      raise exception 'not allowed here' using errcode = 'GRK13';
    end if;
  end if;

  -- 6. Rate limit. The blunt instrument that catches a loop in a page before
  --    any per-feature ceiling notices.
  if v_kind = 'user' then
    select count(*) into v_rate from public.ai_jobs
     where actor_id = v_actor and created_at > now() - interval '1 minute';
    if v_rate >= v_platform.actor_rate_per_minute then
      raise exception 'too many requests' using errcode = 'GRK14';
    end if;
  else
    select count(*) into v_rate from public.ai_jobs
     where actor_fingerprint = p_fingerprint
       and actor_fingerprint is not null
       and created_at > now() - interval '1 hour';
    if v_rate >= v_platform.anon_rate_per_hour then
      raise exception 'too many requests' using errcode = 'GRK14';
    end if;
  end if;

  v_max_usd   := coalesce(p_max_usd, v_feature.default_max_usd);
  v_max_calls := coalesce(p_max_calls, v_feature.default_max_calls);
  v_call_usd  := app.ai_worst_case(p_feature);

  -- What has to fit right now. A batch holds its whole envelope at the door,
  -- because a year half-enriched is worse than one never started. A
  -- conversation holds one call, because being refused at turn one for tokens
  -- it will probably never spend is not a budget working.
  v_need := case when p_class in ('batch', 'scheduled') then v_max_usd else v_call_usd end;

  -- 8. No single job may take more than its share of what is left, so the
  --    first large batch of the month cannot lock its owner out of their own
  --    account until it finishes. Only batches: the others are not holding it.
  if p_class in ('batch', 'scheduled')
     and v_max_usd > app.ai_remaining(v_ws.owner_id) * v_platform.max_job_share then
    raise exception 'that job is too large for what is left this month'
      using errcode = 'GRK18';
  end if;

  -- 9. The payer's allowance.
  if v_need > app.ai_remaining(v_ws.owner_id) then
    raise exception 'this month''s allowance is spent' using errcode = 'GRK15';
  end if;

  -- 10. The project's own daily ceiling.
  if v_wsf.daily_usd is not null then
    select coalesce(sum(cost_usd), 0) into v_today from public.ai_calls
     where workspace_id = p_workspace and created_at >= date_trunc('day', now());
    if v_today + v_need > v_wsf.daily_usd then
      raise exception 'this project has reached its daily limit' using errcode = 'GRK16';
    end if;
  end if;

  insert into public.ai_jobs (
    id, feature, workspace_id, class, payer_id, actor_id, actor_kind,
    actor_fingerprint, root_job_id, depth, max_usd, max_calls,
    deadline, items_total, status
  ) values (
    v_id, p_feature, p_workspace, p_class, v_ws.owner_id, v_actor, v_kind,
    p_fingerprint, v_id, 0, v_max_usd, v_max_calls,
    now() + case when p_class in ('batch', 'scheduled')
                 then interval '6 hours' else interval '2 hours' end,
    p_items_total, 'queued'
  );

  -- The envelope, held for the life of the job.
  if p_class in ('batch', 'scheduled') then
    perform app.ai_period_move(v_ws.owner_id, v_max_usd, 0);
  end if;

  return v_id;
end $$;

-- ── One call within a job ───────────────────────────────────────────────────

create function public.ai_begin_call(p_job uuid, p_prompt_version integer default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_job     record;
  v_root    record;
  v_feature record;
  v_price   record;
  v_id      uuid := gen_random_uuid();
  v_reserve numeric;
begin
  select * into v_job from public.ai_jobs where id = p_job for update;
  if not found then
    raise exception 'no such job' using errcode = 'GRK10';
  end if;

  -- An anonymous job has no actor to match, so possession of its id is the
  -- capability. The id is a v4 uuid handed straight back to the browser that
  -- created it and stored nowhere else.
  if v_job.actor_kind <> 'anon' and not app.ai_job_visible(p_job) then
    raise exception 'no such job' using errcode = 'GRK10';
  end if;

  -- Every call re-asks the cheap questions. This is what makes the kill switch
  -- a control rather than a suggestion: it cannot interrupt a call in flight,
  -- because those tokens are already being paid for, but it stops the next one.
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

  if v_job.calls_made >= v_job.max_calls then
    raise exception 'that job has made all the calls it may' using errcode = 'GRK19';
  end if;

  select * into v_root from public.ai_jobs where id = v_job.root_job_id for update;

  -- The root's ceiling covers the whole tree, so a fan-out cannot buy itself
  -- more calls by having children.
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

  -- A batch's envelope is already held against the period; a conversation
  -- holds each call as it happens, so this is where it checks and takes it.
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
    calls_made = calls_made + case when v_root.id = v_job.id then 1 else 0 end
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

-- ── Settlement ──────────────────────────────────────────────────────────────

create function public.ai_end_call(
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
begin
  select * into v_call from public.ai_calls where id = p_call for update;
  if not found then
    raise exception 'no such call' using errcode = 'GRK10';
  end if;
  -- Settling twice would credit the reservation twice and charge the cost
  -- twice. Idempotent by refusal rather than by silence, so a caller that
  -- retries learns it did.
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

  -- cost_usd is generated, so it is read back rather than recomputed here:
  -- two expressions for one number is how they come to disagree.
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

  -- A batch's envelope stays held until the job ends; only a conversation
  -- settles per call, or the same money would be counted in both places.
  if v_root.class in ('single', 'interactive') then
    perform app.ai_period_move(v_call.payer_id, -v_call.reserved_usd, v_cost, v_call.created_at);
  end if;

  return v_cost;
end $$;

create function public.ai_end_job(p_job uuid, p_status text, p_error text default null)
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

  -- Release what the envelope did not spend, and commit what it did. Against
  -- the period the envelope was taken from, not today's — a batch that runs
  -- across midnight on the last of the month would otherwise credit one month
  -- and charge another.
  if v_job.parent_job_id is null and v_job.class in ('batch', 'scheduled') then
    perform app.ai_period_move(v_job.payer_id, -v_job.max_usd, v_job.spent_usd, v_job.created_at);
  end if;
end $$;

-- Cancelling is one flag and the next tick sees it. Calls in flight finish and
-- settle: they are already paid for.
create function public.ai_cancel_job(p_job uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.ai_job_visible(p_job) then
    raise exception 'no such job' using errcode = 'GRK10';
  end if;
  update public.ai_jobs set cancel_requested = true where id = p_job;
end $$;

-- ── Work items ──────────────────────────────────────────────────────────────

create function public.ai_enqueue_items(p_job uuid, p_refs jsonb)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  if not app.ai_job_visible(p_job) then
    raise exception 'no such job' using errcode = 'GRK10';
  end if;

  insert into public.ai_job_items (job_id, position, ref)
  select p_job, ordinality::integer, value
    from jsonb_array_elements(p_refs) with ordinality
  on conflict (job_id, position) do nothing;

  get diagnostics v_count = row_count;
  update public.ai_jobs set items_total = coalesce(items_total, 0) + v_count where id = p_job;
  return v_count;
end $$;

-- Claiming is atomic, and that is the whole defence against a cron drain and
-- an open tab both taking item 57. `for update skip locked` is what makes two
-- racing ticks divide the work rather than duplicate it.
create function public.ai_claim_items(p_job uuid, p_limit integer default 4)
returns setof public.ai_job_items
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.ai_job_visible(p_job) then
    raise exception 'no such job' using errcode = 'GRK10';
  end if;

  return query
  update public.ai_job_items i
     set status = 'running', attempts = attempts + 1
   where (i.job_id, i.position) in (
     select job_id, position from public.ai_job_items
      where job_id = p_job and status = 'pending'
      order by position
      limit greatest(1, p_limit)
      for update skip locked
   )
  returning i.*;
end $$;

-- Three attempts, then failed, and the job carries on. A batch that dies on
-- one malformed record with 380 good ones behind it is the failure this exists
-- to prevent.
create function public.ai_finish_item(
  p_job uuid, p_position integer, p_ok boolean, p_call uuid default null, p_error text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_attempts integer;
begin
  if not app.ai_job_visible(p_job) then
    raise exception 'no such job' using errcode = 'GRK10';
  end if;

  select attempts into v_attempts from public.ai_job_items
   where job_id = p_job and position = p_position;

  update public.ai_job_items set
    status  = case when p_ok then 'done'
                   when coalesce(v_attempts, 0) >= 3 then 'failed'
                   else 'pending' end,
    call_id = coalesce(p_call, call_id),
    error   = p_error
  where job_id = p_job and position = p_position;

  update public.ai_jobs set
    items_done = (select count(*) from public.ai_job_items
                   where job_id = p_job and status in ('done', 'failed', 'skipped')),
    heartbeat_at = now()
  where id = p_job;
end $$;

-- ── The reapers ─────────────────────────────────────────────────────────────

-- Two, because there are two things that can be left holding money.
--
-- Released rather than charged is a judgement call worth stating plainly: a
-- call whose outcome we never saw *may* have been billed by the provider, so
-- this errs toward the user rather than the invoice. The rows stay marked
-- 'released', so a discrepancy against the provider's own statement is visible
-- rather than invented.
create function public.ai_reap() returns table (calls integer, jobs integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_call record; v_job record; v_calls integer := 0; v_jobs integer := 0;
begin
  -- Fifteen minutes: comfortably longer than the longest call the platform
  -- allows, short enough that a crash does not lock somebody out of their own
  -- budget for an afternoon.
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

    if v_call.root_class in ('single', 'interactive') then
      perform app.ai_period_move(v_call.payer_id, -v_call.reserved_usd, 0, v_call.created_at);
    end if;

    v_calls := v_calls + 1;
  end loop;

  -- Ten for a job, because a job is expected to tick far more often than that
  -- and the envelope it holds is larger.
  for v_job in
    select * from public.ai_jobs
     where status in ('queued', 'running')
       and coalesce(heartbeat_at, started_at, created_at) < now() - interval '10 minutes'
     for update
  loop
    perform public.ai_end_job(v_job.id, 'failed', 'heartbeat lost');
    v_jobs := v_jobs + 1;
  end loop;

  return query select v_calls, v_jobs;
end $$;

-- ── Reporting ───────────────────────────────────────────────────────────────

-- The page's question is not the table's question. ai_calls_read is right for
-- the table — payer, actor, or admin — but a report needs project names, and
-- workspaces_read excludes a project that has since been made private, so a
-- month's spend would quietly drop out of its own report. The same reason
-- my_pending_invites() exists.
create function public.my_ai_usage(p_period date default null)
returns table (
  feature       text,
  feature_name  text,
  workspace_id  uuid,
  workspace_name text,
  app           app_slug,
  role          text,
  calls         bigint,
  prompt_tokens bigint,
  completion_tokens bigint,
  cost_usd      numeric,
  failures      bigint,
  validator_failures bigint
)
language sql stable security definer set search_path = public, pg_temp as $$
  with mine as (
    select
      c.feature,
      f.name as feature_name,
      c.workspace_id,
      w.name as workspace_name,
      w.app,
      -- Both directions, on the row rather than in two reports. Showing only
      -- what was spent on my bill leaves an editor unable to see their own
      -- spending; showing only what I ran leaves an owner unable to see
      -- anyone's.
      case when c.payer_id = auth.uid() and c.actor_id is not distinct from auth.uid()
             then 'mine'
           when c.payer_id = auth.uid() then 'on my bill'
           else 'on their bill' end as role,
      c.prompt_tokens, c.completion_tokens, c.cost_usd, c.status, c.validator_status
    from public.ai_calls c
    join public.ai_features f on f.key = c.feature
    left join public.workspaces w on w.id = c.workspace_id
    where (c.payer_id = auth.uid() or c.actor_id = auth.uid())
      and date_trunc('month', c.created_at)::date
          = coalesce(p_period, date_trunc('month', now())::date)
  )
  select
    feature, feature_name, workspace_id, workspace_name, app, role,
    count(*),
    sum(coalesce(prompt_tokens, 0)),
    sum(coalesce(completion_tokens, 0)),
    sum(coalesce(cost_usd, 0)),
    count(*) filter (where status = 'failed'),
    count(*) filter (where validator_status = 'fail')
  from mine
  group by feature, feature_name, workspace_id, workspace_name, app, role
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────

-- SECURITY DEFINER functions default to executable by public, which would let
-- anonymous callers reach every one of these. Withdrawn and re-granted.
revoke all on function app.ai_role_rank(text) from public;
revoke all on function app.ai_price(text, text) from public;
revoke all on function app.ai_worst_case(text) from public;
revoke all on function app.ai_remaining(uuid) from public;
revoke all on function app.ai_period_move(uuid, numeric, numeric, timestamptz) from public;
revoke all on function public.ai_begin_job(text, uuid, text, numeric, integer, uuid, text, integer) from public;
revoke all on function public.ai_begin_call(uuid, integer) from public;
revoke all on function public.ai_end_call(uuid, integer, integer, text, jsonb, text) from public;
revoke all on function public.ai_end_job(uuid, text, text) from public;
revoke all on function public.ai_cancel_job(uuid) from public;
revoke all on function public.ai_enqueue_items(uuid, jsonb) from public;
revoke all on function public.ai_claim_items(uuid, integer) from public;
revoke all on function public.ai_finish_item(uuid, integer, boolean, uuid, text) from public;
revoke all on function public.ai_reap() from public;
revoke all on function public.my_ai_usage(date) from public;

grant execute on function public.ai_begin_job(text, uuid, text, numeric, integer, uuid, text, integer) to anon, authenticated;
grant execute on function public.ai_begin_call(uuid, integer) to anon, authenticated;
grant execute on function public.ai_end_call(uuid, integer, integer, text, jsonb, text) to anon, authenticated;
grant execute on function public.ai_end_job(uuid, text, text) to anon, authenticated;
grant execute on function public.ai_cancel_job(uuid) to authenticated;
grant execute on function public.ai_enqueue_items(uuid, jsonb) to authenticated;
grant execute on function public.ai_claim_items(uuid, integer) to authenticated;
grant execute on function public.ai_finish_item(uuid, integer, boolean, uuid, text) to authenticated;
grant execute on function public.my_ai_usage(date) to authenticated;

-- anon reaches ai_begin_job and its settlement pair because an anonymous
-- feature is a supported case; it does not reach cancel, the queue, or the
-- reaper. ai_reap() is service_role only — it is cron's, not a user's.
grant execute on function public.ai_reap() to service_role;
