-- Three things the build got wrong, found by reading it back.
--
-- All three are the same shape: a rule stated in a comment and not quite
-- delivered by the code under it, which is the failure mode this whole layer
-- was written to avoid one level up.

-- ── 1. The root's call ceiling did not count its children's calls ───────────
--
-- ai_begin_call says "the root's ceiling covers the whole tree, so a fan-out
-- cannot buy itself more calls by having children", and then incremented
-- calls_made on the root only when the root *was* the child — so the check
-- above it could never trip. The envelope still bounded the money, which is why
-- nothing looked wrong; the call ceiling simply did not apply to fan-out.
--
-- Each call now counts once against the root and, when they differ, once
-- against the job that made it.

create or replace function public.ai_begin_call(p_job uuid, p_prompt_version integer default null)
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

  -- Always the root. This is the fix.
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

-- ── 2. A cache hit had no call id to hang anything from ─────────────────────
--
-- ai_cache_take writes a ledger row and then threw away its id, so the caller
-- got content with no call to attach a proposal to. Enrichment quietly stopped
-- proposing anything for a book whose answer was already cached — which is
-- precisely the second run somebody does after discarding the first suggestion,
-- and it would have looked like the feature doing nothing at all.
--
-- It also missed the root, for the same reason as (1).

drop function public.ai_cache_take(uuid, text);

create function public.ai_cache_take(p_job uuid, p_key text)
returns table (content text, call_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_job     record;
  v_root    record;
  v_feature record;
  v_hit     record;
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

  select * into v_hit from public.ai_cache
   where workspace_id = v_job.workspace_id
     and feature = v_job.feature
     and key = p_key
     and expires_at > now()
     and model = v_feature.model;

  if not found then return; end if;

  update public.ai_cache set hits = hits + 1
   where workspace_id = v_job.workspace_id and feature = v_job.feature and key = p_key;

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

revoke all on function public.ai_cache_take(uuid, text) from public;
grant execute on function public.ai_cache_take(uuid, text) to anon, authenticated;
