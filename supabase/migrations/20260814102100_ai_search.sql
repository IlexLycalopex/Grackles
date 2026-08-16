-- Asking the site a question, and the first feature that does not belong to a
-- project.
--
-- Every feature so far acts on one project's behalf, which is why a job carries
-- a workspace and why the bill goes to that workspace's owner. Search is the
-- first thing that is genuinely the *searcher's*: the question spans everything
-- they can see, the answer is theirs, and there is no one project whose owner
-- should reasonably pay for it. Hanging the job off an arbitrary workspace would
-- have made the ledger read as though one project had been charged for a
-- question that ranged across nine.
--
-- So a feature now has a scope. A 'workspace' feature is everything that exists
-- today and nothing about it changes. A 'platform' feature has no workspace at
-- all: the actor pays, `ai_workspace_features` does not apply because there is
-- no project to switch it off for, and the only controls are the platform ones —
-- the master switch, admissions, the rate limit, the breaker, the quality floor
-- and the person's own allowance.
--
-- That last list is the point. Losing the per-project controls is a real
-- reduction, and it is only acceptable because a platform feature cannot touch
-- a project's records: the check constraint below refuses to let one be created
-- with `sends_records`. There is no project to ask for consent, so a feature at
-- this scope may not be the kind of feature that would need it.

alter table public.ai_features
  add column scope text not null default 'workspace'
    check (scope in ('workspace', 'platform'));

comment on column public.ai_features.scope is
  'Whose work this is. A workspace feature acts for a project and is billed to its owner; a platform feature acts for the person and is billed to them.';

-- A platform feature has no project to ask, so it may not be the kind of
-- feature that would have to. Enforced rather than remembered.
alter table public.ai_features
  add constraint ai_features_platform_sends_nothing
    check (scope = 'workspace' or not sends_records);

-- `app` was not null because every feature until now belonged to one. Naming an
-- arbitrary app for a feature that spans all of them would put a wrong answer
-- in the registry and then in every report that groups by it.
alter table public.ai_features alter column app drop not null;

alter table public.ai_features
  add constraint ai_features_workspace_has_app
    check (scope = 'platform' or app is not null);

alter table public.ai_jobs alter column workspace_id drop not null;

comment on column public.ai_jobs.workspace_id is
  'Null for a platform-scope job, which is the person''s own work rather than a project''s. Everything else carries one, and the daily cap and per-project switch read it.';

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
  v_payer     uuid;
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
     where workspace_id is not distinct from p_workspace
       and feature = p_feature
       and idempotency_key = p_idempotency_key
       and created_at > now() - interval '1 hour';
    if found then return v_existing; end if;
  end if;

  select * into v_feature from public.ai_features where key = p_feature;
  if not found then
    raise exception 'no such feature' using errcode = 'GRK12';
  end if;

  -- A platform job answers to the person, so it needs one. There is no
  -- anonymous version of "search everything you can see".
  if v_feature.scope = 'platform' then
    if v_actor is null then
      raise exception 'not allowed here' using errcode = 'GRK13';
    end if;
    v_payer := v_actor;
    v_kind  := 'user';
  else
    if p_workspace is null then
      raise exception 'no such project' using errcode = 'GRK10';
    end if;
    select id, owner_id, visibility into v_ws from public.workspaces where id = p_workspace;
    if not found or not app.can_read(p_workspace) then
      raise exception 'no such project' using errcode = 'GRK10';
    end if;
    v_payer := v_ws.owner_id;
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

  -- Everything from here to the rate limit is about a project, and a platform
  -- job does not have one.
  if v_feature.scope = 'workspace' then
    select * into v_wsf from public.ai_workspace_features
     where workspace_id = p_workspace and feature = p_feature;
    if found and not v_wsf.enabled then
      raise exception 'that feature is off for this project' using errcode = 'GRK12';
    end if;
    if p_class = 'scheduled' and not coalesce(v_wsf.allow_scheduled, false) then
      raise exception 'unattended work is off for this project' using errcode = 'GRK12';
    end if;

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
     and v_max_usd > app.ai_remaining(v_payer) * v_platform.max_job_share then
    raise exception 'that job is too large for what is left this month'
      using errcode = 'GRK18';
  end if;

  if v_need > app.ai_remaining(v_payer) then
    raise exception 'this month''s allowance is spent' using errcode = 'GRK15';
  end if;

  -- Nested rather than `scope = 'workspace' and v_wsf.daily_usd is not null`,
  -- because plpgsql evaluates a condition as one SQL expression and will not
  -- promise to short-circuit past the second half. On the platform path v_wsf
  -- is never selected into, and reading a field of an unassigned record raises
  -- 55000 — which is how this was found rather than shipped.
  if v_feature.scope = 'workspace' then
    if v_wsf.daily_usd is not null then
      select coalesce(sum(cost_usd), 0) into v_today from public.ai_calls
       where workspace_id = p_workspace and created_at >= date_trunc('day', now());
      if v_today + v_need > v_wsf.daily_usd then
        raise exception 'this project has reached its daily limit' using errcode = 'GRK16';
      end if;
    end if;
  end if;

  insert into public.ai_jobs (
    id, feature, workspace_id, class, payer_id, actor_id, actor_kind,
    actor_fingerprint, root_job_id, depth, max_usd, max_calls,
    deadline, items_total, status, environment, idempotency_key
  ) values (
    v_id, p_feature, p_workspace, p_class, v_payer, v_actor, v_kind,
    p_fingerprint, v_id, 0, v_max_usd, v_max_calls,
    now() + case when p_class in ('batch', 'scheduled')
                 then interval '6 hours' else interval '2 hours' end,
    p_items_total, 'queued', p_environment, p_idempotency_key
  );

  if p_class in ('batch', 'scheduled') then
    perform app.ai_period_move(v_payer, v_max_usd, 0);
  end if;

  return v_id;
end $$;

-- The cache is keyed by workspace, and a platform job has none. Rather than
-- widen the key, a platform feature caches under the actor: two people asking
-- the same question is two lookups, which is right, because what a plan is
-- allowed to reach depends on who is asking and a shared cache would hand one
-- person's resolved question to another.
create or replace function public.ai_cache_take(p_job uuid, p_key text)
returns table (content text, call_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_job     record;
  v_root    record;
  v_feature record;
  v_hit     record;
  v_scope   uuid;
  v_call    uuid := gen_random_uuid();
begin
  select * into v_job from public.ai_jobs where id = p_job for update;
  if not found then
    raise exception 'no such job' using errcode = 'GRK10';
  end if;
  if v_job.actor_kind <> 'anon' and not app.ai_job_visible(p_job) then
    raise exception 'no such job' using errcode = 'GRK10';
  end if;
  if v_job.status not in ('queued', 'running') or v_job.cancel_requested then
    raise exception 'that job has finished' using errcode = 'GRK19';
  end if;
  if v_job.calls_made >= v_job.max_calls then
    raise exception 'that job has made all the calls it may' using errcode = 'GRK19';
  end if;

  select * into v_feature from public.ai_features where key = v_job.feature;
  v_scope := coalesce(v_job.workspace_id, v_job.payer_id);

  select * into v_hit from public.ai_cache
   where workspace_id = v_scope
     and feature = v_job.feature
     and key = p_key
     and expires_at > now()
     and model = v_feature.model;

  if not found then return; end if;

  update public.ai_cache set hits = hits + 1
   where workspace_id = v_scope and feature = v_job.feature and key = p_key;

  insert into public.ai_calls (
    id, job_id, feature, workspace_id, payer_id, actor_id, provider, model,
    prompt_version, status, reserved_usd, prompt_tokens, completion_tokens,
    prompt_usd_per_mtok, completion_usd_per_mtok, cache_hit, settled_at
  ) values (
    v_call, p_job, v_job.feature, v_job.workspace_id, v_job.payer_id, v_job.actor_id,
    v_feature.provider, v_feature.model, v_hit.prompt_version, 'ok', 0, 0, 0,
    0, 0, true, now()
  );

  select * into v_root from public.ai_jobs where id = v_job.root_job_id for update;
  update public.ai_jobs set calls_made = calls_made + 1 where id = v_root.id;
  if v_root.id <> v_job.id then
    update public.ai_jobs set calls_made = calls_made + 1 where id = v_job.id;
  end if;

  update public.ai_jobs
     set heartbeat_at = now(), status = 'running', started_at = coalesce(started_at, now())
   where id = p_job;

  content := v_hit.content;
  call_id := v_call;
  return next;
end $$;

create or replace function public.ai_cache_put(
  p_job uuid, p_key text, p_content text, p_prompt_version integer default null,
  p_ttl interval default interval '30 days'
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_job record; v_feature record; v_scope uuid;
begin
  select * into v_job from public.ai_jobs where id = p_job;
  if not found then return; end if;
  if v_job.actor_kind <> 'anon' and not app.ai_job_visible(p_job) then return; end if;

  select * into v_feature from public.ai_features where key = v_job.feature;
  v_scope := coalesce(v_job.workspace_id, v_job.payer_id);

  insert into public.ai_cache
    (workspace_id, feature, key, content, model, prompt_version, expires_at)
  values
    (v_scope, v_job.feature, p_key, p_content, v_feature.model,
     p_prompt_version, now() + p_ttl)
  on conflict (workspace_id, feature, key) do update
    set content = excluded.content,
        model = excluded.model,
        prompt_version = excluded.prompt_version,
        created_at = now(),
        expires_at = excluded.expires_at,
        hits = 0;
end $$;

-- `ai_cache.workspace_id` now holds a person's id for a platform feature, so it
-- can no longer point at `workspaces`. The column keeps its name because
-- renaming it would rewrite every workspace-scope reader for the sake of one
-- feature; the comment carries what it means.
alter table public.ai_cache drop constraint ai_cache_workspace_id_fkey;

comment on column public.ai_cache.workspace_id is
  'The project for a workspace-scope feature, the payer for a platform-scope one. Not a foreign key for that reason — the sweep and the 30-day expiry are what clear it.';

insert into public.ai_features
  (key, app, name, scope, max_tokens, min_role, provider, model,
   default_max_usd, default_max_calls, prompt_allowance_tokens,
   sends_records, quality_floor)
values
  ('platform.search', null, 'Ask the archive', 'platform',
   -- A plan is a small JSON object. This is generous for one.
   300,
   -- Not consulted at platform scope — there is no project to hold a role in —
   -- but the column is not null and 'viewer' is the honest answer to "what
   -- would this need if it were a project's".
   'viewer', 'minimax', 'minimax-m3',
   -- One call per question, and the question is cached, so a person asking the
   -- same thing twice pays once. Fifty distinct questions a month at the worst
   -- case is well inside a default allowance.
   0.020000, 1, 1600,
   -- False, and it is the whole design rather than a setting. What goes to the
   -- model is the question and a description of the columns — never a row. The
   -- model says *how to look*; the app looks, through the caller's own client,
   -- and RLS decides what comes back. Narrating the results would flip this to
   -- true and put every project behind a consent gate, which is why the rows
   -- are rendered rather than described.
   false,
   -- No floor. A plan either validates against the allowlist or is refused, and
   -- a refusal is already counted as a validator failure; there is no partial
   -- credit to average.
   null);
