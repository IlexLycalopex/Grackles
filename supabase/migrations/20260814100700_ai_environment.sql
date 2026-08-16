-- Which deployment spent it, and not spending it twice.
--
-- Two gaps the spec listed and the build left open, both cheap now and
-- expensive later: a column that becomes meaningful after a month of history is
-- a month of history that cannot answer for itself.
--
-- Preview deployments are the specific worry. Every pull request gets one, it
-- shares the production Supabase project, and nothing so far distinguished a
-- preview's spending from a person's — so a loop in a branch nobody merged
-- would come out of the same allowance and land in the same quality metrics.

alter table public.ai_jobs
  add column environment text not null default 'production'
    check (environment in ('production', 'preview', 'development')),

  -- Supplied by the caller for work that must not happen twice. Null for
  -- everything else, which is most things: a night at the desk is meant to be
  -- repeatable.
  add column idempotency_key text;

-- Partial, so the overwhelming majority of jobs — the ones with no key — do not
-- contend on it.
create unique index ai_jobs_idempotency_idx
  on public.ai_jobs (workspace_id, feature, idempotency_key)
  where idempotency_key is not null;

comment on column public.ai_jobs.environment is
  'Where the job ran. Preview is gated separately because it is the one that runs automatically, on a branch nobody has read yet.';

alter table public.ai_platform_settings
  -- Off by default. A preview deployment that can spend is a pull request that
  -- can spend, and the person who opened it is not the person who pays.
  add column preview_enabled boolean not null default false;

-- The signature changes, so the old one is dropped rather than left beside it:
-- two overloads reachable by named arguments is an ambiguity PostgREST resolves
-- by guessing.
drop function public.ai_begin_job(text, uuid, text, numeric, integer, uuid, text, integer);

create function public.ai_begin_job(
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
  -- 0. Already done. Checked before anything else so a retried request costs
  --    nothing at all — not a rate-limit slot, not a reservation, not a row.
  --    Bounded to an hour: the key protects a double-submitted form, not a
  --    decision somebody makes again next week.
  if p_idempotency_key is not null then
    select id into v_existing from public.ai_jobs
     where workspace_id = p_workspace
       and feature = p_feature
       and idempotency_key = p_idempotency_key
       and created_at > now() - interval '1 hour';
    if found then return v_existing; end if;
  end if;

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
      max_usd, max_calls, deadline, items_total, status, started_at, heartbeat_at,
      environment, idempotency_key
    ) values (
      v_id, p_feature, p_workspace, p_class, v_parent.payer_id, v_parent.actor_id,
      v_parent.actor_kind, v_parent.actor_fingerprint, p_parent, v_parent.root_job_id, v_depth,
      0, coalesce(p_max_calls, v_feature.default_max_calls), v_parent.deadline,
      p_items_total, 'running', now(), now(),
      -- Inherited, not passed. A child of a preview job is preview work
      -- whatever it says about itself.
      v_parent.environment, p_idempotency_key
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

  -- 2a. Preview deployments, which are the ones nobody is watching.
  if p_environment = 'preview' and not v_platform.preview_enabled then
    raise exception 'preview deployments may not spend' using errcode = 'GRK1D';
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
    deadline, items_total, status, environment, idempotency_key
  ) values (
    v_id, p_feature, p_workspace, p_class, v_ws.owner_id, v_actor, v_kind,
    p_fingerprint, v_id, 0, v_max_usd, v_max_calls,
    now() + case when p_class in ('batch', 'scheduled')
                 then interval '6 hours' else interval '2 hours' end,
    p_items_total, 'queued', p_environment, p_idempotency_key
  );

  -- The envelope, held for the life of the job.
  if p_class in ('batch', 'scheduled') then
    perform app.ai_period_move(v_ws.owner_id, v_max_usd, 0);
  end if;

  return v_id;
end $$;

revoke all on function public.ai_begin_job(text, uuid, text, numeric, integer, uuid, text, integer, text, text) from public;
grant execute on function public.ai_begin_job(text, uuid, text, numeric, integer, uuid, text, integer, text, text)
  to anon, authenticated;
