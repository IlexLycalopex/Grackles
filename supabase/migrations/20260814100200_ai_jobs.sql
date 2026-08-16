-- Jobs, calls, work items and proposals.
--
-- The unit of control is the job, not the call. A per-call gate governs one
-- call well and the work somebody actually asked for not at all: "enrich this
-- year" is four hundred calls, each of which passes every check, and the
-- allowance is gone without a single refusal.
--
-- Every call belongs to a job, including the single-call kind. A nullable
-- grouping is a grouping half the reports forget to account for, and one spare
-- row per tasting note is cheaper than two code paths.

create table public.ai_jobs (
  id            uuid primary key default gen_random_uuid(),

  feature       text not null references public.ai_features(key),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,

  class         text not null
                check (class in ('single', 'interactive', 'batch', 'scheduled')),

  -- Who pays: the workspace owner, denormalised deliberately. The workspace
  -- may be deleted or change hands, and neither should rewrite a past invoice.
  payer_id      uuid not null references public.profiles(id),

  -- Who ran it. Null for an anonymous visitor and for a scheduled job;
  -- actor_kind is what tells those two apart, and they are very different
  -- things to find in a report.
  actor_id      uuid references public.profiles(id),
  actor_kind    text not null default 'user'
                check (actor_kind in ('user', 'anon', 'system')),
  -- A salted hash of the address, never the address. Enough for a rate limit
  -- and not enough for anything else.
  actor_fingerprint text,

  -- Fan-out. The envelope lives on the root and every descendant draws from
  -- it; without that rule, envelopes multiply with the tree and every
  -- individual check still passes.
  parent_job_id uuid references public.ai_jobs(id) on delete cascade,
  root_job_id   uuid not null references public.ai_jobs(id),
  depth         integer not null default 0 check (depth >= 0),

  status        text not null default 'queued'
                check (status in ('queued','running','done','cancelled','failed','exhausted')),

  -- The ceilings, copied from the feature at admission rather than read
  -- through a join, so raising a default does not widen a job already running.
  max_usd         numeric(10,6) not null check (max_usd >= 0),
  max_calls       integer not null check (max_calls > 0),
  max_concurrency integer not null default 4 check (max_concurrency between 1 and 16),
  deadline        timestamptz not null,

  -- Drawn down as calls settle. held_usd is what this job's in-flight calls
  -- are holding; only a root job carries either, because only a root has an
  -- envelope.
  spent_usd     numeric(12,8) not null default 0 check (spent_usd >= 0),
  held_usd      numeric(12,8) not null default 0 check (held_usd >= 0),
  calls_made    integer not null default 0 check (calls_made >= 0),

  -- Progress, for a batch. Null elsewhere.
  items_total   integer,
  items_done    integer not null default 0,

  -- Set by every tick. A job whose heartbeat stopped is reaped and its
  -- envelope released; without it a crashed worker holds an envelope until the
  -- deadline, which for a nightly job is most of a day.
  heartbeat_at  timestamptz,

  cancel_requested boolean not null default false,
  error         text,

  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

comment on column public.ai_jobs.root_job_id is
  'Self-referencing on a root job, so "this job and everything it spawned" is one predicate rather than a recursive CTE, and the envelope check reads exactly one row.';

create index ai_jobs_workspace_idx on public.ai_jobs (workspace_id, created_at desc);
create index ai_jobs_payer_idx     on public.ai_jobs (payer_id, created_at desc);
create index ai_jobs_actor_idx     on public.ai_jobs (actor_id, created_at desc);
-- The queue: what a tick picks up, as cheap a read as it can be made.
create index ai_jobs_runnable_idx  on public.ai_jobs (status, created_at)
  where status in ('queued', 'running');

-- ── The ledger ──────────────────────────────────────────────────────────────

-- One row per provider call, append-only. This is the record; everything
-- reported anywhere is derived from it.
create table public.ai_calls (
  id             uuid primary key default gen_random_uuid(),

  job_id         uuid not null references public.ai_jobs(id) on delete cascade,
  feature        text not null references public.ai_features(key),
  workspace_id   uuid references public.workspaces(id) on delete set null,
  payer_id       uuid not null references public.profiles(id),
  actor_id       uuid references public.profiles(id),

  provider       text not null,
  model          text not null,

  -- Which prompt produced this. A report spanning a prompt change without it
  -- compares two different systems and says nothing about either.
  prompt_version integer references public.ai_prompt_versions(id),

  status         text not null default 'reserved'
                 check (status in ('reserved', 'ok', 'failed', 'released')),

  -- What was held before the call. Settled to actuals on commit, released on
  -- failure or on reaping.
  reserved_usd   numeric(12,8) not null check (reserved_usd >= 0),

  prompt_tokens     integer check (prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens >= 0),

  -- The prices that applied, snapshotted. A price change must not restate
  -- history, and joining a report to ai_models by time is a query nobody gets
  -- right twice.
  prompt_usd_per_mtok     numeric(10,4),
  completion_usd_per_mtok numeric(10,4),

  -- Generated, so it cannot disagree with the tokens and prices beside it.
  cost_usd numeric(14,10) generated always as (
      coalesce(prompt_tokens, 0)     * coalesce(prompt_usd_per_mtok, 0)     / 1000000
    + coalesce(completion_tokens, 0) * coalesce(completion_usd_per_mtok, 0) / 1000000
  ) stored,

  -- The validator's verdict, recorded on every call whatever the outcome. A
  -- rule that is only checked when somebody is looking is not a rule.
  validator_status   text check (validator_status in ('pass', 'warn', 'fail')),
  validator_findings jsonb,

  error          text,
  created_at     timestamptz not null default now(),
  settled_at     timestamptz
);

create index ai_calls_payer_idx     on public.ai_calls (payer_id, created_at desc);
create index ai_calls_workspace_idx on public.ai_calls (workspace_id, created_at desc);
create index ai_calls_actor_idx     on public.ai_calls (actor_id, created_at desc);
-- The job detail view, which is the one read that happens while somebody
-- watches a progress bar.
create index ai_calls_job_idx       on public.ai_calls (job_id, created_at);
create index ai_calls_open_idx      on public.ai_calls (created_at) where status = 'reserved';

-- ── Work items ──────────────────────────────────────────────────────────────

-- A batch's work list. Its existence is what makes a batch resumable, and its
-- primary key is what makes an item impossible to charge for twice: a retried
-- tick that reaches item 57 finds it already done and does nothing.
create table public.ai_job_items (
  job_id     uuid not null references public.ai_jobs(id) on delete cascade,
  position   integer not null,

  -- What the item is about — a book id, a broadcast id. Deliberately loose:
  -- the runner does not know what it is enriching.
  ref        jsonb not null,

  status     text not null default 'pending'
             check (status in ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts   integer not null default 0 check (attempts >= 0),
  call_id    uuid references public.ai_calls(id) on delete set null,
  error      text,
  updated_at timestamptz not null default now(),

  primary key (job_id, position)
);

create index ai_job_items_pending_idx on public.ai_job_items (job_id, position)
  where status = 'pending';

-- ── Proposals ───────────────────────────────────────────────────────────────

-- The quality ledger, and the mirror of ai_calls. One row per thing a model
-- offered a person, and what became of it. The propose-then-confirm discipline
-- was already earning this signal and throwing it away.
create table public.ai_proposals (
  id           uuid primary key default gen_random_uuid(),
  call_id      uuid not null references public.ai_calls(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  feature      text not null references public.ai_features(key),

  target_table text not null,
  target_id    uuid,

  proposed     jsonb not null,

  -- 'expired' is not a neutral outcome and is recorded as its own thing: a
  -- proposal nobody ever decided on usually means the feature interrupted
  -- somebody who did not want it.
  outcome      text check (outcome in ('accepted', 'edited', 'discarded', 'expired')),

  -- How much survived. An accepted proposal that was rewritten first is not
  -- the same event as one saved as offered.
  edit_distance integer check (edit_distance >= 0),

  decided_by   uuid references public.profiles(id),
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index ai_proposals_feature_idx on public.ai_proposals (feature, created_at desc);
create index ai_proposals_workspace_idx on public.ai_proposals (workspace_id, created_at desc);

-- ── Row-level security ──────────────────────────────────────────────────────

alter table public.ai_jobs      enable row level security;
alter table public.ai_calls     enable row level security;
alter table public.ai_job_items enable row level security;
alter table public.ai_proposals enable row level security;

revoke all on public.ai_jobs      from anon, authenticated;
revoke all on public.ai_calls     from anon, authenticated;
revoke all on public.ai_job_items from anon, authenticated;
revoke all on public.ai_proposals from anon, authenticated;

-- Both directions, deliberately. The payer needs to see what was spent on
-- their bill including by somebody else; the actor needs to see what they
-- spent on somebody else's. A policy carrying only the first clause is the
-- same failure the dashboard's invitations had — right for the table, wrong
-- for the page.
grant select on public.ai_jobs to authenticated;
create policy ai_jobs_read on public.ai_jobs for select using (
  payer_id = auth.uid() or actor_id = auth.uid() or app.is_platform_admin()
);

grant select on public.ai_calls to authenticated;
create policy ai_calls_read on public.ai_calls for select using (
  payer_id = auth.uid() or actor_id = auth.uid() or app.is_platform_admin()
);

-- Cancelling is the only write a client makes to a job, and it is one column.
-- Everything else moves through the SECURITY DEFINER functions or does not
-- move: a job that could be updated directly is a budget that can be edited.
grant update (cancel_requested) on public.ai_jobs to authenticated;
create policy ai_jobs_cancel on public.ai_jobs for update using (
  payer_id = auth.uid() or actor_id = auth.uid() or app.is_platform_admin()
) with check (
  payer_id = auth.uid() or actor_id = auth.uid() or app.is_platform_admin()
);

-- Items are visible when their job is. Routed through a definer helper rather
-- than a subquery on ai_jobs, so the policy is not evaluating another policy.
create function app.ai_job_visible(j uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.ai_jobs
    where id = j
      and (payer_id = auth.uid() or actor_id = auth.uid() or app.is_platform_admin())
  )
$$;

revoke all on function app.ai_job_visible(uuid) from public;
grant execute on function app.ai_job_visible(uuid) to authenticated;

grant select on public.ai_job_items to authenticated;
create policy ai_job_items_read on public.ai_job_items
  for select using (app.ai_job_visible(job_id));

-- Proposals are written by the route that made the offer and updated by
-- whoever decided on it, which is an ordinary editor action rather than an
-- owner one — an editor accepting an enrichment is the feature working.
grant select, insert, update on public.ai_proposals to authenticated;
create policy ai_proposals_read on public.ai_proposals
  for select using (app.can_write(workspace_id) or app.is_platform_admin());
create policy ai_proposals_insert on public.ai_proposals
  for insert with check (app.can_write(workspace_id));
create policy ai_proposals_update on public.ai_proposals
  for update using (app.can_write(workspace_id))
  with check (app.can_write(workspace_id));

create trigger touch_ai_job_items before update on public.ai_job_items
  for each row execute function public.touch_updated_at();
