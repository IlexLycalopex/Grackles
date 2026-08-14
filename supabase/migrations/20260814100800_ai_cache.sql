-- Not calling at all.
--
-- Every control so far bounds the damage; none of them reduces the bill. The
-- cheapest call is the one that does not happen, and for the features coming
-- next — enrichment, classification, normalisation — the same input recurs
-- constantly: the same book looked up twice, a batch re-run after a failure,
-- somebody pressing the button again because the first answer scrolled away.
--
-- A hit is still a ledger row. Without that, hit rate is invisible and a cheap
-- month is indistinguishable from a quiet one — which is the same failure as
-- not recording spend at all, one level up.

alter table public.ai_calls
  add column cache_hit boolean not null default false;

comment on column public.ai_calls.cache_hit is
  'A call that was answered from ai_cache. Costs nothing and is recorded anyway, so hit rate is a number rather than a hope.';

create table public.ai_cache (
  -- Scoped to a workspace by construction. Two projects enriching the same
  -- book pay twice, and that is the trade being made deliberately: a shared
  -- cache keyed only on the input would let a private project's answer be
  -- served to a stranger who happened to ask the same question.
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  feature      text not null references public.ai_features(key) on delete cascade,
  key          text not null,

  content      text not null,

  -- What produced it. A cached answer from a prompt that has since been
  -- replaced is a stale answer, and serving it would make a prompt change look
  -- like it did nothing.
  model          text not null,
  prompt_version integer references public.ai_prompt_versions(id),

  hits         integer not null default 0,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 days',

  primary key (workspace_id, feature, key)
);

create index ai_cache_expiry_idx on public.ai_cache (expires_at);

alter table public.ai_cache enable row level security;
revoke all on public.ai_cache from anon, authenticated;

-- No direct access at all. Everything goes through the two functions below,
-- which is what keeps the workspace scoping from being something a caller has
-- to remember.
create policy ai_cache_none on public.ai_cache for select using (false);

/**
 * Take an answer from the cache, recording the hit as a call.
 *
 * Returns null on a miss. On a hit it writes a zero-cost ai_calls row and
 * counts the call against the job's ceiling — a cache hit cannot exhaust a
 * budget, but a loop serving itself from cache is still a loop, and max_calls
 * is the thing that stops it.
 */
create function public.ai_cache_take(p_job uuid, p_key text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_job     record;
  v_feature record;
  v_hit     record;
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
     -- A model change invalidates as surely as a prompt change. Both are
     -- "the thing that produced this is not the thing that would produce it
     -- now", and serving the old answer would hide the difference.
     and model = v_feature.model;

  if not found then return null; end if;

  update public.ai_cache set hits = hits + 1
   where workspace_id = v_job.workspace_id and feature = v_job.feature and key = p_key;

  insert into public.ai_calls (
    job_id, feature, workspace_id, payer_id, actor_id, provider, model,
    prompt_version, status, reserved_usd, prompt_tokens, completion_tokens,
    prompt_usd_per_mtok, completion_usd_per_mtok, cache_hit, settled_at
  ) values (
    p_job, v_job.feature, v_job.workspace_id, v_job.payer_id, v_job.actor_id,
    v_feature.provider, v_feature.model, v_hit.prompt_version, 'ok', 0, 0, 0,
    0, 0, true, now()
  );

  update public.ai_jobs
     set calls_made = calls_made + 1, heartbeat_at = now(), status = 'running',
         started_at = coalesce(started_at, now())
   where id = p_job;

  return v_hit.content;
end $$;

/** Keep an answer. Overwrites an expired or superseded one at the same key. */
create function public.ai_cache_put(
  p_job uuid, p_key text, p_content text, p_prompt_version integer default null,
  p_ttl interval default interval '30 days'
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_job record; v_feature record;
begin
  select * into v_job from public.ai_jobs where id = p_job;
  if not found then return; end if;
  if v_job.actor_kind <> 'anon' and not app.ai_job_visible(p_job) then return; end if;

  select * into v_feature from public.ai_features where key = v_job.feature;

  insert into public.ai_cache
    (workspace_id, feature, key, content, model, prompt_version, expires_at)
  values
    (v_job.workspace_id, v_job.feature, p_key, p_content, v_feature.model,
     p_prompt_version, now() + p_ttl)
  on conflict (workspace_id, feature, key) do update
    set content = excluded.content,
        model = excluded.model,
        prompt_version = excluded.prompt_version,
        created_at = now(),
        expires_at = excluded.expires_at,
        hits = 0;
end $$;

/** Expired rows, swept alongside everything else cron already calls. */
create function public.ai_cache_sweep() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  delete from public.ai_cache where expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.ai_cache_take(uuid, text) from public;
revoke all on function public.ai_cache_put(uuid, text, text, integer, interval) from public;
revoke all on function public.ai_cache_sweep() from public;
grant execute on function public.ai_cache_take(uuid, text) to anon, authenticated;
grant execute on function public.ai_cache_put(uuid, text, text, integer, interval) to anon, authenticated;
grant execute on function public.ai_cache_sweep() to service_role;
