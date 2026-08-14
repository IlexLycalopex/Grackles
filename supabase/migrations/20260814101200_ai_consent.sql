-- What leaves the building.
--
-- Every feature so far sends a third party something small and deliberate: a
-- title and an author, or prose the owner typed a minute ago. The ones coming
-- next do not. "Ask your archive" sends the *contents of a project* to a
-- provider, and a private project's contents leaving on the strength of
-- somebody clicking a button they did not read is not a decision anybody made.
--
-- So the flag is on the feature, not on the platform: a feature that transmits
-- stored records has to say so, and a project has to have agreed before one
-- runs. Nothing today sets it, which is the point — this changes no behaviour
-- when it lands and refuses the first feature that would have needed asking.

alter table public.ai_features
  add column sends_records boolean not null default false;

comment on column public.ai_features.sends_records is
  'True when the feature transmits stored records rather than something the caller just typed. Requires the project to have consented, and is the difference between sending a book title and sending the shelf.';

alter table public.ai_workspace_features
  -- When the owner agreed, and who. Null is "never asked", which is a refusal
  -- for a records-sending feature and irrelevant for every other.
  add column consent_at timestamptz,
  add column consent_by uuid references public.profiles(id);

-- Retention on the desk's transcripts.
--
-- They are working material rather than the record — the broadcast is the
-- record — and they accumulate forever today. Null means keep them, and null
-- is the default deliberately: switching this on deletes somebody's
-- transcripts, and that is a decision for the person whose transcripts they
-- are, not a tidy-up to slip into a migration.
alter table public.ai_platform_settings
  add column transcript_retention_days integer
    check (transcript_retention_days is null or transcript_retention_days >= 7);

create function public.ai_sweep_transcripts() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_days integer; v_count integer := 0;
begin
  select transcript_retention_days into v_days from public.ai_platform_settings;
  if v_days is null then return 0; end if;

  -- Only finished sittings. A running one is somebody's night in progress,
  -- however long they have left it open.
  delete from public.wbpr_agent_messages m
   using public.wbpr_agent_sessions s
   where m.session_id = s.id
     and s.status in ('logged', 'abandoned')
     and s.updated_at < now() - make_interval(days => v_days);

  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- The gate. Everything else about admission is unchanged; this is one clause
-- between the feature check and the actor check, because a project that has
-- not agreed should be refused before anybody's role is considered.
create or replace function public.ai_begin_job(
  p_feature     text,
  p_workspace   uuid,
  p_class       text default 'single',
  p_max_usd     numeric default null,
  p_max_calls   integer default null,
  p_parent      uuid default null,
  p_fingerprint text default null,
  p_items_total integer default null,
  p_environment text default 'production',
  p_idempotency_key text default null
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
  v_depth     integer := 0;
  v_max_usd   numeric;
  v_max_calls integer;
  v_call_usd  numeric;
  v_need      numeric;
  v_rate      integer;
  v_today     numeric;
  v_existing  uuid;
begin
  if p_idempotency_key is not null then
    select id into v_existing from public.ai_jobs
     where workspace_id = p_workspace
       and feature = p_feature
       and idempotency_key = p_idempotency_key
       and created_at > now() - interval '1 hour';
    if found then return v_existing; end if;
  end if;

  select id, owner_id, visibility into v_ws from public.workspaces where id = p_workspace;
  if not found or not app.can_read(p_workspace) then
    raise exception 'no such project' using errcode = 'GRK10';
  end if;

  select * into v_feature from public.ai_features where key = p_feature;
  if not found then
    raise exception 'no such feature' using errcode = 'GRK12';
  end if;

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
      max_usd, max_calls, deadline, items_total, status, started_at, heartbeat_at,
      environment, idempotency_key
    ) values (
      v_id, p_feature, p_workspace, p_class, v_parent.payer_id, v_parent.actor_id,
      v_parent.actor_kind, v_parent.actor_fingerprint, p_parent, v_parent.root_job_id, v_depth,
      0, coalesce(p_max_calls, v_feature.default_max_calls), v_parent.deadline,
      p_items_total, 'running', now(), now(),
      v_parent.environment, p_idempotency_key
    );
    return v_id;
  end if;

  select * into v_platform from public.ai_platform_settings;
  if not v_platform.enabled then
    raise exception 'AI is switched off' using errcode = 'GRK11';
  end if;
  if not v_platform.admissions_open then
    raise exception 'no new AI work is being accepted' using errcode = 'GRK1B';
  end if;

  if p_environment = 'preview' and not v_platform.preview_enabled then
    raise exception 'preview deployments may not spend' using errcode = 'GRK1D';
  end if;

  if not v_feature.enabled or v_feature.auto_disabled_at is not null then
    raise exception 'that feature is switched off' using errcode = 'GRK12';
  end if;

  select * into v_wsf from public.ai_workspace_features
   where workspace_id = p_workspace and feature = p_feature;
  if found and not v_wsf.enabled then
    raise exception 'that feature is off for this project' using errcode = 'GRK12';
  end if;
  if p_class = 'scheduled' and not coalesce(v_wsf.allow_scheduled, false) then
    raise exception 'unattended work is off for this project' using errcode = 'GRK12';
  end if;

  -- 4a. Has this project agreed to its contents leaving?
  --     Before the role check on purpose: whether the records may go at all is
  --     a prior question to who is asking.
  if v_feature.sends_records and v_wsf.consent_at is null then
    raise exception 'this project has not agreed to send its records to a model'
      using errcode = 'GRK1E';
  end if;

  if v_actor is null then
    v_kind := 'anon';
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
  v_need := case when p_class in ('batch', 'scheduled') then v_max_usd else v_call_usd end;

  if p_class in ('batch', 'scheduled')
     and v_max_usd > app.ai_remaining(v_ws.owner_id) * v_platform.max_job_share then
    raise exception 'that job is too large for what is left this month'
      using errcode = 'GRK18';
  end if;

  if v_need > app.ai_remaining(v_ws.owner_id) then
    raise exception 'this month''s allowance is spent' using errcode = 'GRK15';
  end if;

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
    deadline, items_total, status, environment, idempotency_key
  ) values (
    v_id, p_feature, p_workspace, p_class, v_ws.owner_id, v_actor, v_kind,
    p_fingerprint, v_id, 0, v_max_usd, v_max_calls,
    now() + case when p_class in ('batch', 'scheduled')
                 then interval '6 hours' else interval '2 hours' end,
    p_items_total, 'queued', p_environment, p_idempotency_key
  );

  if p_class in ('batch', 'scheduled') then
    perform app.ai_period_move(v_ws.owner_id, v_max_usd, 0);
  end if;

  return v_id;
end $$;

-- Folded into housekeeping, which is already the one thing cron calls.
create or replace function public.ai_housekeeping()
returns table (calls_released integer, jobs_reaped integer, cache_swept integer, notices integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_reap record;
begin
  select * into v_reap from public.ai_reap();
  calls_released := v_reap.calls;
  jobs_reaped    := v_reap.jobs;
  cache_swept    := public.ai_cache_sweep() + public.ai_sweep_transcripts();
  notices        := public.ai_check_budgets();
  return next;
end $$;

revoke all on function public.ai_sweep_transcripts() from public;
grant execute on function public.ai_sweep_transcripts() to service_role;
