# AI governance

The layer that has to exist before a second feature starts spending money.

**Status.** Phases 0–4 are built and **applied to the live project** as of
2026-08-14: `supabase/migrations/20260814*`, `src/lib/ai/`, `/settings/ai`,
`/admin/ai`, and the AI panel on a project's settings page. WBPR, the reading
enrichment run and the cigar lookup all run through it. The prices in
`ai_models` were checked against MiniMax's published rates before applying,
because every limit downstream is computed from them. Phase 5 (cron drain,
scheduled jobs) and phase 6 (anonymous features) are not built. What changed on the way is recorded under
*What the build changed*, near the end.

## Why now

There is one AI feature — the WBPR desk — and its governance is three integer
columns on `wbpr_agent_sessions` plus an owner-only RLS policy. That was the
right amount of machinery for one feature used by one person, and it stops
being right the moment there is a second.

What it cannot answer today:

- **What have I spent this month?** The counters are per sitting. Nothing adds
  them up, and nothing ever will while the shape is per-feature.
- **What happens when the answer is "too much"?** Nothing. There is no ceiling
  anywhere in the system. A loop in a page, a retry storm, or one long night
  spends whatever it spends and the first anyone knows is the invoice.
- **Who spent it?** `created_by` on the sitting, which is fine while the gate
  is owner-only. It stops being fine the first time an editor is allowed to
  press a button that costs money, because then the person spending and the
  person paying are different people.
- **Can it be turned off?** Only by unsetting `MINIMAX_API_KEY`, which is a
  deploy, and which turns off everything at once.
- **Is any of it any good?** Nothing records whether an answer was right, or
  whether it broke one of the rules its own prompt states, or what happened to
  it after it was shown to somebody. The desk's rules — never name a track,
  never invent a card — hold today because the model complies, and if it stops
  complying the only detector is Jamie noticing.

The rest of this document is the answer to those five questions, in the shape
this codebase already uses for the same class of problem: entitlements in the
database, checked by a `SECURITY DEFINER` function, defaulting to deny, with a
platform admin who may hand them out.

The first four are about money and the fifth is not, and the fifth is the one
that decides whether any of this was worth doing. Governing spend without
governing quality optimises for the wrong thing very efficiently.

## Principles

These come first because most of the design below is just them applied.

1. **The app decides facts, the model supplies prose.** Carried over from the
   desk. It is a governance principle as much as a correctness one: work the app
   can do itself is work nobody is billed for.
2. **Metered before the call, recorded after it.** A budget checked after
   spending is not a budget. Every call reserves its worst case first and
   settles for its actual afterwards.
3. **The owner pays, so the owner sees.** Spend is always attributed to a real
   person — the workspace owner — and that person can see every call made on
   their bill, including the ones somebody else ran.
4. **The person who ran it sees it too.** An editor spending the owner's budget
   must be able to see what they spent. Both directions, or one of them finds
   out from the other.
5. **Default deny, at the database.** No row in the budget table means no AI, in
   exactly the way no row in `app_grants` means no workspace creation. The
   database refuses; the page merely avoids offering.
6. **Tokens are the fact, money is derived.** The provider returns exact token
   counts. Prices change. Store the counts, snapshot the price that applied, and
   compute money at read time — so a price change does not silently rewrite last
   quarter's report.
7. **Refusing is free.** Every gate is a database check with no network call
   behind it. Being over budget costs nothing, which is what makes it safe to
   set the limit low.
8. **Checked where it can be checked, judged only where it cannot.** The same
   principle as the deck, applied to the answer rather than the question: most
   of what a model gets wrong here is wrong against something the app already
   holds. Verify that in code. Judgement is for the residue.
9. **A cheap wrong answer is the expensive one.** Every control below has a
   quality counterpart, and neither number means much without the other. The
   goal is the cheapest option that clears the bar, which is not the same
   instruction as "spend less".
10. **Every call belongs to a job.** There is no such thing as a loose call, not
    even a single one. It is the difference between a system that governs one
    call well and a system that governs the work a person actually asked for.

## Who pays, and who acts

Two different people, deliberately separated:

| | |
|---|---|
| **Payer** | `workspaces.owner_id`. Never the acting user. This is who the budget is spent against and who the report is addressed to. |
| **Actor** | `auth.uid()`, or null for an anonymous visitor on a public feature. Recorded on every call so the payer can see who ran what. |

For the desk as it stands these are the same person, because the gate is
owner-only. They come apart in three cases worth designing for now rather than
retrofitting: an editor running enrichment on a project they do not own, an
anonymous visitor calling the station on a public archive, and a scheduled job
with no interactive user at all.

An anonymous actor is identified by `actor_fingerprint` — a salted hash of the
IP, never the address itself — which is enough for a rate limit and not enough
for anything else.

## Four scopes of control

Most restrictive wins, and they are checked in this order because the order is
what stops an expensive check running for a request the cheap check would have
refused anyway:

| Scope | Where it lives | The question it answers |
|---|---|---|
| Platform | `ai_platform_settings` (one row) | Is AI on at all? Which models may be called? |
| Feature | `ai_features` | Is this particular capability enabled, and what does it cost at most? |
| Payer | `ai_budgets` | Does this person have an allowance, and is any of it left? |
| Workspace | `ai_workspace_features` | Has this project turned this feature on, and may strangers use it? |

The payer scope is the direct analogue of `app_grants`, and intentionally so: it
is the same problem — a per-person entitlement with a quota, handed out by a
platform admin, defaulting to nothing — and it should be the same shape so that
the second one is recognisable to anyone who has read the first.

There is a fifth scope, and it is the one the four above cannot express: the
job.

## The unit of work

A per-call gate governs one call well and the work somebody actually asked for
not at all. "Enrich this year's books" is four hundred calls, each of which
passes every check in the table above, four hundred times, and exhausts a
month's allowance without a single refusal. The gate did its job on every call
and the system still failed.

So the unit of control is not the call. It is the **job**: a bounded piece of
AI work with one envelope, one ceiling on how many calls it may make, one
lifecycle, and one thing that can be cancelled.

**Every call belongs to a job, including a job of one.** That is the
simplification the whole section rests on. A single tasting-note expansion
creates a job with `max_calls = 1`, runs it, and closes it — slightly more
machinery than it needs, in exchange for there being exactly one code path,
one ledger relationship, one reporting shape and no special case anywhere for
"the small kind". The alternative is a nullable `job_id` and two of everything,
which is how the per-call gate came to be the only gate in the first place.

`ai_sessions` from the earlier draft is deleted by this. A WBPR sitting was
already a job — bounded, resumable, with an envelope somebody was paying for —
and describing it as a different kind of thing was a mistake.

### Four shapes, one table

| Class | Example | N known up front? | Who waits |
|---|---|---|---|
| `single` | A tasting note, a blurb | Yes, and it is 1 | The person who pressed the button |
| `interactive` | The desk, ask-the-archive | No — the human decides when it ends | The person, turn by turn |
| `batch` | Enrich a year, embed the archive | Yes | Nobody; it is watched, not waited on |
| `scheduled` | Nightly embedding refresh | Yes | Nobody, and there is no actor at all |

They differ in defaults and in how they are driven, not in structure. One table,
one set of ceilings, one cancel.

### The ceilings a job carries

Five, and each exists because of a specific way the per-call gate fails:

| Ceiling | Stops |
|---|---|
| `max_usd` — the envelope | The four-hundred-call batch. This is the one that closes the hole. |
| `max_calls` | A loop whose calls are individually cheap. A budget alone does not catch this until it is spent. |
| `deadline` | A job that holds an envelope for a week because nothing ever finished it. |
| `max_depth` | Recursion. A step that can enqueue another step will, eventually, forever. |
| `max_concurrency` | A batch firing four hundred calls at a provider at once, which is a rate-limit ban rather than a bill. |

`max_depth` is the one most easily left out and the most expensive to retrofit,
because by the time it is needed the code that fans out has already been
written without a depth to pass down.

### The rule that makes fan-out safe

A job may spawn children — a planning step that enqueues per-item work is the
obvious case. **Children draw from the root job's envelope, not their own.**

Without that rule, envelopes multiply with the tree: a job with a £1 envelope
spawning ten children with £1 envelopes has spent £10, and every individual
check passed. The envelope belongs to the root, `parent_job_id` and `depth` are
carried down, and the platform caps depth outright.

### Reserving: fail fast, or drip

The per-call rule — reserve the worst case — does not survive contact with a
batch, because reserving four hundred worst cases at once will refuse jobs that
would comfortably have fitted. Two answers, and which applies is a property of
the class:

- **`batch` and `scheduled` reserve the whole envelope up front.** A batch that
  stops at item 180 because somebody else's spend landed first is worse than one
  that never started: the year is now half-enriched, and whoever asked has to
  work out which half. Refusing at the door is the honest failure.
- **`interactive` and `single` reserve per call, topping up as they go.** A
  conversation must not be refused at turn one for tokens it will probably never
  spend, and a sitting stopped part-way through is an ordinary ending — the desk
  already treats `abandoned` as a normal outcome.

One more rule on top: **a single job's envelope may not exceed half the payer's
remaining monthly allowance.** Otherwise the first big batch of the month locks
its owner out of their own account until it finishes, and the fix — cancelling
it — costs them everything it had already spent.

## Schema

### The feature registry

```sql
-- Features are rows rather than an enum because the platform control that
-- matters most is "turn this one off", and a deploy is not an incident
-- response. The code-side mirror in lib/ai/features.ts gives the app its
-- types, the same way APPS mirrors the app_slug enum.
create table public.ai_features (
  key            text primary key,          -- 'wbpr.desk', 'reading.enrich'
  app            app_slug not null,
  name           text not null,             -- 'The desk', shown in reports
  enabled        boolean not null default true,

  -- The worst case for one call of this feature, in completion tokens. This is
  -- what gets reserved against the budget before the call, so it is a cost
  -- control and not only a length one.
  max_tokens     integer not null check (max_tokens between 1 and 8000),

  -- The lowest role that may run it. 'anon' is allowed but means nothing until
  -- a workspace also sets allow_anon — two independent switches, because a
  -- feature that strangers may run is the one that needs two.
  min_role       text not null default 'owner'
                 check (min_role in ('anon','viewer','editor','owner')),

  -- Bound per feature rather than globally. Classification and prose have
  -- different requirements and should not be forced onto one model because the
  -- registry had only one column for it.
  provider       text not null default 'minimax',
  model          text not null default 'minimax-m3',

  -- The quality floor and its actuator. Null disables the check; a feature
  -- switched off by its own failure rate carries the timestamp, so it reports
  -- differently from one an admin turned off.
  quality_floor    numeric check (quality_floor between 0 and 1),
  auto_disabled_at timestamptz,

  created_at     timestamptz not null default now()
);
```

Seeded with `('wbpr.desk', 'wbpr', 'The desk', true, 700, 'owner')`, which is
exactly the behaviour that exists today, so installing this changes nothing.

### Platform settings

```sql
-- Single row, id fixed, so there is nothing to disambiguate and no way to end
-- up with two sets of platform settings disagreeing.
create table public.ai_platform_settings (
  id                     boolean primary key default true check (id),

  -- The kill switch. Refuses new calls; does not reach into a sitting already
  -- running, which will simply fail at its next turn with a sentence.
  enabled                boolean not null default true,

  -- Applied to a payer with a budget row that leaves them null. A default that
  -- lives here rather than in a column default can be changed for everyone at
  -- once.
  default_monthly_usd    numeric(10,4) not null default 5.0000,

  -- Calls per actor per minute, across everything. The blunt instrument that
  -- catches a loop in a page before any per-feature limit notices.
  actor_rate_per_minute  integer not null default 20,
  anon_rate_per_hour     integer not null default 6,

  updated_at             timestamptz not null default now()
);
```

### Models and prices

```sql
-- Prices are data, not constants, and they are versioned by effective_from
-- rather than updated in place: a report over August must value August's calls
-- at August's prices. The row that applied is snapshotted onto the call anyway
-- (see below) — this table is what a new call reads, and what the admin page
-- edits.
create table public.ai_models (
  provider           text not null,           -- 'minimax'
  model              text not null,           -- 'minimax-m3'
  prompt_usd_per_mtok      numeric(10,4) not null,
  completion_usd_per_mtok  numeric(10,4) not null,
  effective_from     timestamptz not null default now(),
  allowed            boolean not null default true,
  primary key (provider, model, effective_from)
);
```

The allowlist is here rather than in code because "stop calling the expensive
model" is a platform control with the same urgency as the kill switch.

### The budget

```sql
-- The app_grants analogue. No row means no AI: an absent entitlement is a
-- refusal, not an unlimited default.
create table public.ai_budgets (
  user_id        uuid primary key references public.profiles(id) on delete cascade,

  -- Null means "use ai_platform_settings.default_monthly_usd". Distinct from
  -- zero, which means "explicitly none" and is a useful thing to be able to say
  -- about somebody without deleting their row and losing who granted it.
  monthly_usd    numeric(10,4) check (monthly_usd >= 0),

  enabled        boolean not null default true,
  granted_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.ai_budgets enable row level security;
revoke all on public.ai_budgets from anon, authenticated;
grant select on public.ai_budgets to authenticated;

-- Readable by its owner, writable only by service_role and the admin RPC.
-- Exactly the app_grants posture, for exactly the app_grants reason: an
-- entitlement a user can edit is not an entitlement.
create policy ai_budgets_read on public.ai_budgets
  for select using (user_id = auth.uid() or app.is_platform_admin());
```

Platform admins are unmetered, mirroring `app.can_create()`, where the person
who hands out allowances does not have to raise their own before every use.
This is a deliberate hole and it is the smallest one available: the alternative
is an admin who cannot run the thing they are administering.

### Per-workspace switches

```sql
create table public.ai_workspace_features (
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  feature       text not null references public.ai_features(key),

  enabled       boolean not null default true,

  -- The owner's own ceiling, under the platform's. A project that should never
  -- cost more than a few pence a day says so here.
  daily_usd     numeric(10,4) check (daily_usd >= 0),

  -- Strangers. Off unless deliberately turned on, and meaningless unless the
  -- workspace is also public — checked, not assumed.
  allow_anon    boolean not null default false,

  primary key (workspace_id, feature)
);
```

An absent row means the feature's own default applies. That keeps enabling a new
feature from requiring a backfill across every workspace.

### Jobs

```sql
-- The unit of work. Everything that reaches a provider hangs off one of these,
-- including the single-call kind, so there is no second path to govern.
create table public.ai_jobs (
  id            uuid primary key default gen_random_uuid(),

  feature       text not null references public.ai_features(key),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,

  class         text not null
                check (class in ('single','interactive','batch','scheduled')),

  payer_id      uuid not null references public.profiles(id),

  -- Null for a scheduled job, which has no actor. actor_kind distinguishes
  -- that from an anonymous visitor, who also has no actor_id but is a very
  -- different thing to find in a report.
  actor_id      uuid references public.profiles(id),
  actor_kind    text not null default 'user'
                check (actor_kind in ('user','anon','system')),
  actor_fingerprint text,

  -- Fan-out. The envelope lives on the root; descendants draw from it.
  parent_job_id uuid references public.ai_jobs(id) on delete cascade,
  root_job_id   uuid not null references public.ai_jobs(id),
  depth         integer not null default 0,

  status        text not null default 'queued'
                check (status in ('queued','running','done','cancelled','failed','exhausted')),

  -- The ceilings. Copied from the feature's defaults at creation rather than
  -- read through a join, so raising a default does not retroactively widen a
  -- job that is already running.
  max_usd       numeric(10,6) not null,
  max_calls     integer not null,
  max_depth     integer not null default 2,
  max_concurrency integer not null default 4,
  deadline      timestamptz not null,

  -- Drawn down as calls settle. The job is exhausted, not failed, when either
  -- runs out — a distinction that matters because one is a limit working
  -- correctly and the other is something broken.
  spent_usd     numeric(12,8) not null default 0,
  calls_made    integer not null default 0,

  -- Progress, for a batch. Null elsewhere.
  items_total   integer,
  items_done    integer,

  -- Set by every tick. A job whose heartbeat has stopped is reaped and its
  -- envelope released; without it a crashed worker holds an envelope until the
  -- deadline, which for a nightly job is most of a day.
  heartbeat_at  timestamptz,

  cancel_requested boolean not null default false,
  error         text,

  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

create index ai_jobs_workspace_idx on public.ai_jobs (workspace_id, created_at desc);
create index ai_jobs_payer_idx     on public.ai_jobs (payer_id, created_at desc);
-- The queue: what a tick picks up, cheapest possible read.
create index ai_jobs_runnable_idx  on public.ai_jobs (status, created_at)
  where status in ('queued','running');
```

`root_job_id` is `not null` and self-referencing for a root job, so every query
that means "this job and everything it spawned" is one predicate rather than a
recursive CTE. The envelope check reads the root row and only the root row.

```sql
-- A batch's work list. Its existence is what makes a batch resumable, and its
-- unique key is what makes an item impossible to charge for twice.
create table public.ai_job_items (
  job_id     uuid not null references public.ai_jobs(id) on delete cascade,
  position   integer not null,

  -- What this item is about: a book id, a broadcast id. Deliberately loose —
  -- the job runner does not know what it is enriching.
  ref        jsonb not null,

  status     text not null default 'pending'
             check (status in ('pending','running','done','failed','skipped')),
  attempts   integer not null default 0,
  call_id    uuid references public.ai_calls(id),
  error      text,

  primary key (job_id, position)
);

create index ai_job_items_pending_idx on public.ai_job_items (job_id, position)
  where status = 'pending';
```

The primary key is the idempotency key. A retried tick that re-processes item
57 finds it already `done` and does nothing, which is the whole of the
double-charging defence and costs a unique index.

### The ledger

```sql
-- One row per provider call, append-only. This is the record; everything
-- reported is derived from it.
create table public.ai_calls (
  id             uuid primary key default gen_random_uuid(),

  feature        text not null references public.ai_features(key),
  workspace_id   uuid references public.workspaces(id) on delete set null,

  -- Who pays. Denormalised from the workspace deliberately: the workspace may
  -- be deleted, or change hands, and neither should rewrite a past invoice.
  payer_id       uuid not null references public.profiles(id),

  -- Who ran it. Null for an anonymous visitor, who is identified only by the
  -- fingerprint beside it.
  actor_id       uuid references public.profiles(id),
  actor_fingerprint text,

  -- Not optional. Every call belongs to a job, including the single-call kind,
  -- because a nullable grouping is a grouping half the reports will forget to
  -- account for.
  job_id         uuid not null references public.ai_jobs(id),

  provider       text not null,
  model          text not null,

  -- Which prompt produced this. Without it, a report spanning a prompt change
  -- compares two different systems and says nothing about either.
  prompt_version integer references public.ai_prompt_versions(id),

  -- The validator's verdict on the response (see Quality, below). Recorded on
  -- every call, whatever the outcome — a rule that is only checked when
  -- somebody is looking is not a rule.
  validator_status   text check (validator_status in ('pass','warn','fail')),
  validator_findings jsonb,

  status         text not null default 'reserved'
                 check (status in ('reserved','ok','failed','released')),

  -- What was held against the budget before the call. Settled to actuals on
  -- commit; released on failure.
  reserved_usd   numeric(10,6) not null,

  prompt_tokens     integer,
  completion_tokens integer,

  -- The prices that applied, snapshotted. A price change must not restate
  -- history, and joining to ai_models by time is a report nobody will get
  -- right twice.
  prompt_usd_per_mtok     numeric(10,4),
  completion_usd_per_mtok numeric(10,4),

  -- Generated, so it cannot disagree with the tokens and prices beside it.
  cost_usd numeric(12,8) generated always as (
    coalesce(prompt_tokens,0)     * prompt_usd_per_mtok     / 1000000
  + coalesce(completion_tokens,0) * completion_usd_per_mtok / 1000000
  ) stored,

  error          text,
  created_at     timestamptz not null default now(),
  settled_at     timestamptz
);

create index ai_calls_payer_month_idx on public.ai_calls (payer_id, created_at desc);
create index ai_calls_workspace_idx   on public.ai_calls (workspace_id, created_at desc);
create index ai_calls_actor_rate_idx  on public.ai_calls (actor_id, created_at desc);
create index ai_calls_open_idx        on public.ai_calls (created_at) where status = 'reserved';
```

`ai_calls_job_idx on (job_id, created_at)` as well, because the job detail view
is the one read that happens while somebody is watching a progress bar.

WBPR keeps `wbpr_agent_sessions` for the transcript and the night's state — that
is the app's own business. What it gives up is the three counters, which become
a view over the calls belonging to the sitting's job.

### The period counter

The budget check happens on every call and must not scan the ledger. One row
per payer per month, updated in the same transaction as the reservation:

```sql
create table public.ai_periods (
  payer_id     uuid not null references public.profiles(id) on delete cascade,
  period       date not null,               -- first of the month, UTC
  committed_usd numeric(12,6) not null default 0,
  reserved_usd  numeric(12,6) not null default 0,
  primary key (payer_id, period)
);
```

`reserved_usd` is the in-flight total; `committed_usd` is settled spend. The
budget is checked against their sum, so two concurrent calls cannot both fit
into the last penny.

## Opening a job, and calls within it

Four functions, and no other route to a provider. `lib/ai/` is the only place
`minimax.ts` is imported from, and `withJob` is the only place these are called.

```sql
-- Admission. Everything expensive to decide happens here, once per job, rather
-- than once per call — which is what makes a four-hundred-item batch a single
-- decision instead of four hundred identical ones.
--
-- SECURITY DEFINER because it reads platform settings and other people's
-- budgets: questions RLS deliberately cannot express for the caller, the same
-- reasoning as my_pending_invites().
create function public.ai_begin_job(
  p_feature      text,
  p_workspace    uuid,
  p_class        text,
  p_max_usd      numeric,      -- the envelope asked for
  p_max_calls    integer,
  p_parent       uuid default null,
  p_fingerprint  text default null
) returns uuid

-- Draw one call from a job that is already admitted. Cheap: the expensive
-- gates were cleared at admission, so this checks the job's own ceilings, the
-- kill switch, and cancellation.
create function public.ai_begin_call(p_job uuid) returns uuid

-- Settle it. Moves the actual from the job's reservation into its spend, and
-- from the period's reserved into its committed.
create function public.ai_end_call(
  p_call uuid, p_prompt integer, p_completion integer, p_error text default null
) returns void

-- Close the job: release whatever the envelope did not spend.
create function public.ai_end_job(p_job uuid, p_status text, p_error text default null)
  returns void
```

### The order of the gates, and why it is fixed

`ai_begin_job` checks in this order. The order is load-bearing in the same way
`requireWrite()`'s is — it decides which failure a caller learns about, and one
of these must not be the first thing a stranger discovers.

| # | Check | Raises |
|---|---|---|
| 1 | The workspace exists and this caller may see it | `GRK10` — indistinguishable from not existing, because a private project must not announce itself by refusing an AI job differently from a missing one |
| 2 | Platform `enabled` | `GRK11` |
| 3 | Feature exists and is `enabled` | `GRK12` |
| 4 | Workspace has it enabled; `allow_scheduled` if this is a scheduled job | `GRK12` |
| 5 | Actor clears `min_role`, and `allow_anon` if anonymous | `GRK13` |
| 6 | Rate limit for this actor or fingerprint | `GRK14` |
| 7 | `depth < max_depth`, and this feature may fan out at all | `GRK17` |
| 8 | The envelope is within half the payer's remaining allowance | `GRK18` |
| 9 | Payer's budget has room for the envelope | `GRK15` |
| 10 | Workspace's `daily_usd` has room | `GRK16` |

Check 1 first, always. Everything after it may reveal that a workspace exists.

Checks 8–10 last because they write; the seven before them are pure reads that
will refuse most bad requests without touching a counter row.

A **child job skips 2 through 10 entirely** and inherits its root's admission.
Re-checking a budget the root already reserved would refuse children out of an
envelope that has money in it, which is the failure mode that makes fan-out
unusable. Only check 7 applies to a child, and it is the only one that has
anything left to say.

### What is reserved, and when

`ai_begin_call` reserves `max_tokens × completion price` plus a flat prompt
allowance — the worst case, not an estimate. A budget that can be exceeded by
one unusually long call is not a budget, and the difference comes back on
settle, so the only cost of pessimism is briefly under-reporting what is left.

Where that worst case is *held* is what differs by class:

- `batch` and `scheduled`: the whole envelope moves into `ai_periods.reserved_usd`
  at admission. Individual calls draw against the job, not the period, so a
  batch cannot be interrupted by someone else's spending.
- `single` and `interactive`: nothing is held at admission beyond one call's
  worth. Each call reserves against the period as it happens, and a job that
  ends early never held money it did not use.

### Every tick re-asks the cheap questions

`ai_begin_call` re-checks the platform kill switch, the job's `cancel_requested`
flag, its deadline, and its two ceilings. This is what fixes the gap the earlier
draft admitted to and left open: a kill switch that could not reach a running
sitting. It still does not interrupt a call in flight — that would abandon
tokens already being paid for — but it stops the next one, which for anything
longer than a single call is the difference between a control and a suggestion.

### When settlement never happens

Two reapers, because there are now two things that can be left holding money.

```sql
-- A call whose outcome we never saw.
update public.ai_calls set status = 'released', settled_at = now()
 where status = 'reserved' and created_at < now() - interval '15 minutes';

-- A job whose worker stopped ticking.
update public.ai_jobs set status = 'failed', error = 'heartbeat lost', finished_at = now()
 where status = 'running'
   and coalesce(heartbeat_at, started_at) < now() - interval '10 minutes';
```

Fifteen minutes for a call: comfortably longer than the longest call the
platform allows, short enough that a crash does not lock somebody out of their
own budget for an afternoon. Ten for a job, because a job is expected to tick
far more often than that and the envelope it holds is larger.

Released rather than charged is a judgement call worth stating plainly: a call
whose outcome we never saw *may* have been billed by the provider, so this errs
toward the user rather than the invoice. The rows stay in the ledger marked
`released`, so a discrepancy against the provider's own statement is visible
rather than invented.

## Running a job

Admission is a database question. Execution is not, and it is where the design
meets Vercel's function timeouts — a four-hundred-item batch cannot run inside
a request no matter how it is gated.

**One worker, three triggers.** `runTick(jobId)` claims a few pending items,
processes them under `max_concurrency`, updates the heartbeat and progress, and
returns whether there is more to do. It is identical in all three cases; only
what calls it differs.

| Trigger | For | Why |
|---|---|---|
| The request itself | `single`, `interactive` | One or two calls inside the handler. There is nothing to schedule. |
| The browser | `batch` started by a person | The page that started it POSTs `/api/ai/job/tick` until the job reports done, showing progress as it goes. No infrastructure, cancellable, and honest about the fact that something is running. |
| Cron | `scheduled`, and any batch left unattended | A Vercel cron hits a drain endpoint each minute; it picks up runnable jobs oldest first and ticks each once. Slow, unattended, needs nothing new. |

Starting with a browser pump for user-initiated batches is deliberate. It needs
no queue, no worker service and no new dependency — the same test `lib/email.ts`
and `lib/minimax.ts` were held to — and it degrades honestly: close the tab and
the job stops ticking, the reaper releases the envelope, and the work already
done stays done because every item was committed as it finished. When the first
genuinely unattended job appears, the cron drain picks up the same jobs with the
same worker, and nothing about the job's own definition changes.

Two properties that make this safe to leave running:

- **Claiming is atomic.** An item moves `pending → running` with
  `update … where status = 'pending' returning *`, so two ticks racing — a
  cron drain and an open tab — cannot both take item 57. The same
  RLS-shaped reasoning as every delete in this app: ask for the rows back and
  check you got them.
- **A poison item cannot stall a job.** Three attempts, then `failed`, and the
  job continues. A batch that dies on one malformed record, with 380 good ones
  behind it, is the failure this exists to prevent.

### Cancelling

Setting `cancel_requested` is all the UI does. The next tick sees it, marks the
job `cancelled`, and releases the envelope. Calls in flight finish and settle —
they are already paid for. Completed items stay completed, which is the point of
committing each one as it lands rather than at the end.

An admin cancelling somebody else's job uses the same flag through the same
function. There is no second cancel path with different semantics, because
during an incident is the worst possible time to discover that there was one.

## The application side

```
src/lib/ai/
├── provider.ts     the interface: one `complete(messages, opts)` per provider
├── minimax.ts      today's implementation, moved, otherwise unchanged
├── features.ts     the code-side mirror of ai_features — keys and their types
├── json.ts         ask for a shape, parse, validate, fail to a sentence
├── validators/     one per feature; see Quality
├── job.ts          withJob(): the only way to reach a provider
└── worker.ts       runTick(): the one worker, whatever triggered it
```

`job.ts` is the whole of the application-side contract:

```ts
/**
 * The one door to a provider.
 *
 * Nothing in src/pages imports a provider directly. The job is admitted before
 * anything is spent and closed afterwards whatever happened, including on
 * failure — a call that errored still spent tokens often enough that treating
 * failure as free is how a budget quietly stops working.
 *
 * A single-call feature uses this too, with a job of one. The overhead is a row;
 * the alternative is a second path, and a second path is how the per-call gate
 * became the only gate.
 */
export async function withJob<T>(
  ctx: {
    supabase: SupabaseClient<Database>;
    feature: FeatureKey;
    workspaceId: string;
    class?: JobClass;        // defaults to 'single'
    parentJobId?: string;    // set by a step that fans out; depth is derived
    fingerprint?: string;
  },
  run: (job: JobHandle) => Promise<T>
): Promise<Ran<T>>
```

A `JobHandle` offers `chat()` and, for a batch, `enqueue(items)` and
`claim(n)`. `chat()` has already had its `max_tokens` clamped to the feature's
registered ceiling — the reservation was taken against that number, so a caller
able to pass a larger one would be spending money that was never held. It throws
when the job is out of calls, out of envelope, cancelled or past its deadline,
and those are ordinary control flow rather than errors: for a batch they mean
"stop cleanly and report progress", not "fail".

```ts
/**
 * One slice of a batch. Called from a request, a browser pump or a cron drain
 * with no difference in behaviour — which is what lets the trigger change later
 * without the job's definition changing with it.
 */
export async function runTick(
  supabase: SupabaseClient<Database>, jobId: string
): Promise<{ done: boolean; itemsDone: number; itemsTotal: number; spentUsd: number }>
```

Refusals arrive as SQLSTATEs and become sentences the same way grant errors do,
extending `describeGrantError`'s table:

| Code | Sentence |
|---|---|
| `GRK11` | AI features are switched off across the site at the moment. |
| `GRK12` | That feature is not switched on for this project. |
| `GRK13` | You do not have permission to run that here. |
| `GRK14` | That is a lot of requests at once — give it a minute. |
| `GRK15` | This month's AI allowance is spent. |
| `GRK16` | This project has reached its daily AI limit. |
| `GRK17` | That went too many steps deep — nothing was run. |
| `GRK18` | That job is too large for what is left this month. Narrow it, or wait for the allowance to reset. |

`GRK18` is deliberately a different sentence from `GRK15`: the allowance is not
spent, the job simply will not fit inside half of what remains, and the useful
next action is to enrich one year rather than five. A single "no budget" message
for both would send somebody to ask for a limit rise they do not need.

`GRK15` is the owner's own allowance even when an editor triggered it, and the
sentence shown to the editor says so — "the owner's allowance for this month is
spent" — because otherwise they will read it as their own and be confused by a
limit they cannot see.

## Quality

Everything above governs what a call costs. None of it can tell a good answer
from a bad one, and a feature that is cheap and wrong is the worse failure —
token minimisation on its own is just minimising usefulness.

### "Good" means something different in each feature

| Feature | The failure that matters | How it is caught |
|---|---|---|
| Metadata enrichment | A wrong publisher, an invented ISBN | Checked against the source that supplied it |
| Duplicate proposals | Merging two artists who are genuinely different | Asymmetric — precision over recall, because a bad merge destroys data and a missed one costs nothing |
| Tasting notes, blurbs | Flavours the person never mentioned; wrong length or tone | No ground truth: acceptance, and the edit |
| The desk | Naming a track, inventing a card, contradicting the archive | The app holds the cards and the transcript, so both rules are checkable |
| The write-up | A track that never played, a block that did not happen | Checked against the sitting's own state |
| Ask the archive | A confident answer over zero rows | Checked against the rows the query actually returned |

Five of those six have a deterministic check available. That is the whole design
of this section: **validators, not judges.** If the app can decide, the app
decides — the same argument that moved the deck out of the prompt, applied to
the answer instead of the question.

### The validator

One per feature, run on every response before it reaches a person, its verdict
written to `ai_calls.validator_status` and `validator_findings`.

The desk is the clearest case. Its system prompt already carries hard rules —
*never name a track*, *never invent a card* — and today they hold because the
model complies. If it stops complying, Jamie notices or he does not, and nothing
records it either way. But the app knows exactly which cards are down and
exactly what the DJ typed, so both are a function of state it is already
holding:

```ts
// lib/ai/validators/wbpr.ts
//
// Not a check that the reply is good — a check that it is legal. The rules it
// enforces are the ones stated in the system prompt, which is the point: a rule
// worth writing into a prompt is worth verifying, or it is a wish.
export function validateDeskReply(reply: string, state: AgentState, said: string): Findings
```

What a `fail` does is per feature, not global. On the desk it is a warning shown
beside the reply, because the night should not stop for it. On the write-up it
blocks the save, because that is the path that writes to five tables. On
enrichment it drops the offending field and keeps the rest.

**Parse rate is the free one.** The write-up either returns valid JSON against
its shape or it does not, and that single number is the first thing to move when
a prompt or a model changes. It costs nothing to record and it is the cheapest
regression alarm in the system.

### The proposal ledger

The propose-then-confirm discipline already earns the best quality signal
available, and currently throws it away. What a person did with a proposal *is*
the evaluation:

```sql
-- The quality ledger, and the mirror of ai_calls. One row per thing a model
-- offered a person, and what became of it.
create table public.ai_proposals (
  id           uuid primary key default gen_random_uuid(),
  call_id      uuid not null references public.ai_calls(id),
  feature      text not null references public.ai_features(key),

  -- What it was offered against: 'rl_books', and the row if one existed.
  target_table text not null,
  target_id    uuid,

  proposed     jsonb not null,

  outcome      text check (outcome in ('accepted','edited','discarded','expired')),

  -- How much of it survived. Cheap to compute at save time, and the single
  -- most informative quality number here: an accepted proposal that was
  -- rewritten before saving is not the same event as one saved as offered.
  edit_distance integer,

  decided_by   uuid references public.profiles(id),
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
```

`expired` matters as much as the other three. A proposal nobody ever decided on
is not a neutral outcome — it usually means the feature interrupted somebody
who did not want it.

From this: accepted-verbatim rate, median edit distance, and **cost per accepted
proposal**, all per feature and per prompt version. The last of those is the
number that closes a feature down, and it cannot be computed from the cost
ledger alone.

### A prompt is a versioned artifact

```sql
create table public.ai_prompt_versions (
  id          integer generated always as identity primary key,
  feature     text not null references public.ai_features(key),
  version     integer not null,
  hash        text not null,          -- of the body, so a silent edit is visible
  body        text not null,
  active      boolean not null default false,
  notes       text,
  created_at  timestamptz not null default now(),
  unique (feature, version)
);
```

Three things this buys that a string in a `.ts` file does not:

- **Comparison.** Metrics are grouped by version, so "the acceptance rate fell"
  can be attributed rather than guessed at.
- **Rollback.** Flipping `active` is faster than a deploy, and the failure it
  undoes is usually noticed at an inconvenient hour.
- **Canary.** A new version served to a fraction of calls, promoted only if
  validator and acceptance rates hold. Cost per accepted proposal is the
  comparison that decides it.

The system prompt stays in code as the source it is edited in; the row is what
was actually sent, hashed. If those two disagree, the row is right.

### Golden cases

A small, deliberately curated set of frozen inputs with expectations, replayed
against any prompt or model change **before** it ships.

```sql
create table public.ai_golden_cases (
  id           uuid primary key default gen_random_uuid(),
  feature      text not null references public.ai_features(key),
  input        jsonb not null,
  expectations jsonb not null,   -- what must hold, not what must be said
  curated_from uuid references public.ai_calls(id),
  created_at   timestamptz not null default now()
);
```

For the desk, a case is a saved transcript replayed with the same cards, and the
expectation is that the *rules* hold — not that the prose matches. Prose that
matches last month's word for word would be the bug.

This also resolves the retention tension from the privacy section. Keeping every
prompt forever in case an evaluation needs one is the wrong trade; curating a
few dozen cases deliberately, with the workspace owner's agreement, is the same
capability with a fraction of the exposure.

**And it is the only defence against a model changing underneath you.**
`minimax-m3` is a name, not a fixed artifact — providers revise weights behind a
stable identifier without announcing it. Nothing else in this design would
detect that; a golden run on a schedule would, and the provider's request id and
any version string it returns should be recorded on the call so a step change
can be dated.

### Where a judge is appropriate, and its rules

For the residue — tone, whether a blurb reads like the person's own notes —
there is nothing to check against and judgement is the only option. Four
constraints on it:

1. **Sampled, never universal.** Judging every call doubles the bill to measure
   the bill.
2. **Billed to the platform, not the payer.** The user did not ask for the
   evaluation; charging them for it would be indefensible on a report they can
   read.
3. **Never gates a user-visible action.** It produces a trend line. A judge in
   the request path is a second thing that can be wrong, in series.
4. **Not the same model.** A judge shares its generator's blind spots, and will
   confidently approve exactly the failures nobody else caught.

### Quality needs an actuator too

A dashboard nobody acts on is not a control. The quality counterpart of the
budget refusal is a floor, enforced the same way:

> If a feature's validator failure rate over its last *N* calls exceeds its
> threshold, it disables itself — the same switch a platform admin has, thrown
> automatically, with the reason recorded.

`ai_features` gains `quality_floor numeric` and `auto_disabled_at timestamptz`,
and a disabled-by-quality feature reports differently from one an admin turned
off, because the two need different responses from whoever finds it.

`ai_enforce_quality_floors()` is what reads them, folded into the reaper so
there is one thing for cron to call — they run on the same cadence and for the
same reason, both being the system noticing something without waiting for a
person to look. Two numbers make it usable rather than infuriating: it looks at
the most recent **fifty** checked calls rather than all of them, so a feature
that was bad in March and has been fixed is not held down by March; and it
refuses to act on fewer than **twenty**, because below that a single bad night
switches off a working feature and the cure is worse than the fault.

This is the part that makes the section governance rather than instrumentation.
Everything before it produces numbers; this acts on them without waiting for
somebody to look.

### A batch fails fast on quality too

The floor above is a feature-level trailing average, which is the right
instrument for a slow drift and far too slow for a batch. Four hundred items
producing nonsense should stop at twenty, not at four hundred, and the trailing
average across the feature will not have moved enough to notice until most of
the money is gone.

So a job carries its own abort rule: **if the first *k* items validate as `fail`
at a rate above the feature's floor, the job stops itself as `exhausted` and
reports what it did.** Twenty items is a large enough sample to be sure and a
small enough one to be cheap, and the work already committed stays committed —
the failure mode this avoids is spending an afternoon's allowance discovering
something twenty items would have told you.

It is the same reasoning as reserving a batch's whole envelope up front, arriving
at the opposite behaviour for the opposite reason: refuse early when the problem
is predictable, stop early when it is not.

### Cost and quality are one frontier

The routing decision — a small model for classification, an expensive one for
prose — is only answerable with both halves. Cheapest model that clears the
validator suite and holds its acceptance rate, chosen per feature, re-run when
either the prices or the models change. `ai_models` therefore carries the
evidence alongside the price, and "which model does this feature use" is a
per-feature column rather than a global default.

## Reporting, at a user level

### `/settings/ai` — the person

Addressed to one signed-in user, showing both of the things they are: somebody
who pays, and somebody who spends.

**What I've spent this month.** Total against allowance, with the reset date.
Broken down by project, then by feature. Calls and tokens beside the money,
because tokens are the fact and money is the derivation — a report that shows
only the derived number cannot be checked.

**Who spent it.** For each project they own, the split by actor. This is the
half that does not exist today and cannot be retrofitted from the current
schema, which is why `actor_id` is on the ledger from the start.

**What I ran on someone else's bill.** The mirror image, listing calls where
`actor_id` is them and `payer_id` is not. Both directions are needed or the
information is only available to one of the two people who need it — the same
failure the dashboard's invitations had, where the policy was right for the
table and wrong for the page.

**What it was worth.** Beside every cost figure, and on the same row rather than
a separate page: accepted-verbatim rate, median edit distance, and validator
failures. The report has to be able to say *"the desk cost £2.40 this month and
you discarded three of the five write-ups it produced"*, because a spend figure
alone cannot distinguish a feature worth paying for from one that is merely
affordable. Cost per accepted proposal is the headline number per feature.

**Jobs, not calls, at the top level.** The list is what was asked for — "enrich
2024", "a night at the desk", "a tasting note" — with its cost, progress,
outcome and a cancel button while it is running. Calls are the detail underneath
one job. Nobody thinks in calls, and a report that leads with four hundred rows
is a report that gets closed.

**The last fifty calls,** underneath. Feature, project, when, tokens, cost,
prompt version, the validator's verdict, and the error if it failed. Failed
calls are shown, with their cost — a page that hides them is a page that cannot
explain a bill.

The natural RLS policy on `ai_calls` is `payer_id = auth.uid() or actor_id =
auth.uid() or app.is_platform_admin()`, and that is the right policy for the
table. The page still reads through a `SECURITY DEFINER` function,
`my_ai_usage(period date)`, for the same reason `my_pending_invites()` exists:
the page's question — "my spend, grouped, with names attached" — needs a join to
`workspaces` that RLS will narrow differently from `ai_calls`, and a project
that has since been made private would drop out of its own spend report.

### On `/settings/:app/:workspace` — the project

A panel under the existing sections: this project's spend this month, per
feature, per actor; the feature switches (`enabled`, `daily_usd`, `allow_anon`);
and the daily figure against the cap. Owner-only, like the rest of that page.

`allow_anon` renders disabled with an explanation when the workspace is not
public, rather than being hidden. A control that silently does nothing is worse
than one that says why it cannot.

## Controls, at a platform level

### `/admin/ai` — platform admins only

Gated on `is_platform_admin`, and the page 404s rather than 403s for everyone
else, matching how a private workspace behaves.

**The kill switch.** One toggle, taking effect on the next call. It does not
reach into a running sitting; that sitting fails at its next turn with `GRK11`
and the sentence explains it. Nothing is lost — the WBPR transcript is in the
database for exactly this reason.

**Features.** The registry as a table: enable, disable, change `max_tokens`,
change `min_role`, change the model it is bound to. Disabling a feature is the
surgical version of the kill switch and should be the more common action.

**Prompts.** Every feature's versions, which is active, and the metrics for each
— validator failure rate, acceptance rate, cost per accepted proposal. Promote,
roll back, or start a canary from here. A feature that disabled itself on its
quality floor surfaces here rather than in the switches above, with the findings
that tripped it, because the useful next action is a rollback and not a
re-enable.

**Golden runs.** The last replay per feature, what changed since the previous
one, and a button to run them now. Scheduled weekly regardless, because the
change being watched for is one nobody deploys.

**The queue.** Every job currently `queued` or `running`, across all workspaces:
whose it is, what it is spending, how far through, when it last ticked. Cancel
any of them, and a global pause that stops new jobs being admitted while letting
running ones finish. Pause and the kill switch are different instruments — one
drains, the other stops — and an incident wants whichever fits, not an argument
about which one it has.

The queue view is also where the reapers report. A job that lost its heartbeat
and a job somebody cancelled look identical in the totals and mean entirely
different things, so they are labelled apart here rather than in a log.

**Models and prices.** The allowlist, and the prices new calls will snapshot.
Editing a price inserts a new `effective_from` row rather than updating one, so
past calls keep the price they were valued at.

**Budgets.** The `app_grants` screen, for AI: grant an allowance, change it,
disable it, see it spent. Same table shape, same admin, same page conventions —
a person granted a Cigar Lounge and an AI allowance in one sitting should not
feel like they used two systems.

**Spend.** Everyone, this month and last, sorted by cost, with the ability to
open one person's detail. Plus the platform total against whatever the account's
actual provider spend is, which is the one number that proves the ledger is
telling the truth.

**Anomalies.** A short list rather than a dashboard: reservations released by
the sweeper, calls that failed, actors who hit a rate limit, and any workspace
whose daily spend has tripled week on week. These are the four things that mean
something is wrong, and they are cheap queries over an indexed ledger.

### What is deliberately not a platform control

- **No per-call approval.** Nothing here asks a human to approve spending a
  penny; that is a workflow nobody sustains, and it would make the desk unusable.
  The controls are all ceilings and switches, set in advance.
- **No automatic budget increase.** Running out is a refusal, not an upsell. The
  system never spends more than it was told it could because it judged the
  request important.
- **No provider key in the browser, under any circumstance.** Already true, and
  it stays an invariant rather than a preference: every feature here is
  server-side, and a client-side call would be unmeterable by construction.

## What this does to WBPR

The desk keeps `wbpr_agent_sessions` — the transcript, the state, the block
number are all WBPR's business and belong to it. What changes:

1. **A sitting becomes an `interactive` job.** `wbpr_agent_sessions` gains a
   nullable `ai_job_id`. This is a smaller change than it sounds: a sitting
   already has a lifecycle, an owner, a `running`/`logged`/`abandoned` status
   and an implicit ceiling of four blocks. It was a job with the governance
   left out.
2. `prompt_tokens`, `completion_tokens` and `calls` stop being written and are
   replaced by a view over `ai_calls`. They are kept, not dropped, until the
   view has been checked against them for a full night.
3. The chat and log routes wrap their `chat()` calls in `withJob`. The
   owner-only check stays where it is — `min_role: 'owner'` on the feature row
   is the same rule expressed in the new place, and both holding is not
   redundancy worth removing.

**The backfill is honest or it is nothing.** Existing sittings have totals but
no per-call detail, so they cannot become `ai_calls` rows without inventing the
calls. One synthetic row per historic sitting, marked `status = 'ok'` with
`feature = 'wbpr.desk'` and a note that it is a reconciliation, keeps the
lifetime totals correct without pretending to a granularity that was never
recorded.

## Testing

`supabase/tests/test.sh` already has the right shape for this — role-switching
via `request.jwt.claims`, expected SQLSTATEs, everything in a rolled-back
transaction. The cases that matter:

- A user with no `ai_budgets` row is refused (`GRK15`), because default-deny is
  the property most likely to be lost to a well-meaning `coalesce`.
- A user at their limit is refused; the same user one cent under is allowed.
- Two concurrent reservations cannot both fit the last cent — the second is
  refused. This is the test that proves `ai_periods` is doing its job rather
  than being decorative.
- An editor's call reserves against the *owner's* budget, not their own.
- An anonymous caller is refused when `allow_anon` is false, and when the
  workspace is not public even if it is true.
- The kill switch refuses a call from a platform admin too. Admins are unmetered,
  not exempt from the switch — those are different properties and it is easy to
  implement the second by accident.
- A settled call moves money from `reserved_usd` to `committed_usd` and does not
  double count.
- The sweeper releases a stale reservation and leaves a fresh one alone.

The job cases are the ones that would have caught the hole this section exists
to close, and none of them is expressible against a single call:

- A batch of 400 whose envelope exceeds the remaining allowance is refused at
  admission (`GRK18`) and makes **no** calls. The old design's failure was that
  it made 400 successful ones.
- A job at `max_calls` refuses the next call while its envelope still has money
  in it — the two ceilings are independent and it is easy to implement one and
  believe you have both.
- A child job draws from the root's envelope. Ten children of a £1 root spend at
  most £1 between them, not £10.
- A job at `max_depth` is refused (`GRK17`); its parent continues.
- Two ticks racing for the same pending item: exactly one gets it. Run it as two
  concurrent transactions, not two sequential ones, or it proves nothing.
- An item that fails three times is marked `failed` and the job carries on to
  the next.
- A tick after `cancel_requested` makes no call, marks the job `cancelled`, and
  releases the envelope; the items already `done` stay `done`.
- The job reaper releases the envelope of a job whose heartbeat stopped, and
  leaves one that ticked a minute ago alone.
- A batch whose first twenty items fail validation stops itself at twenty.
- The kill switch thrown mid-batch stops the next tick. This is the one that
  distinguishes a control from a suggestion, and the earlier draft could not
  have passed it.

The quality half is not a database test and belongs beside the code it checks —
`npm run check`'s neighbour rather than `tests/test.sh`'s:

- Each validator against a fixture of known-bad output: a desk reply naming a
  track, a write-up citing a card that was never drawn, an enrichment result
  with an ISBN whose check digit fails, an archive answer citing a row id that
  was not in the result set. A validator with no failing fixture has never been
  shown to detect anything.
- The write-up's parser against a fenced response, a truncated one, and one with
  prose before the JSON. These are the three ways it will actually fail.
- A feature crossing its quality floor disables itself, and an admin re-enabling
  it clears `auto_disabled_at` rather than leaving a stale timestamp that makes
  the next incident unreadable.

## Order of work

Each phase is useful on its own and none of them requires the next.

| Phase | What ships | Why this order |
|---|---|---|
| 0 | `ai_features`, `ai_models`, `ai_jobs`, `ai_calls`, `ai_prompt_versions`, `ai_proposals`, `withJob`, the desk's validator, WBPR wrapped | Recording only — no gate, no floor, no behaviour change. Jobs exist and every call has one, but nothing is refused yet. A month of real data before anything starts refusing on the strength of it. |
| 1 | `ai_budgets`, `ai_periods`, the four functions enforcing, both reapers, the quality floor | Both sets of ceilings, informed by what phase 0 measured rather than by a guess. |
| 2 | `ai_job_items`, `runTick`, the browser pump, cancel | Batch execution, once there is something safe to run it inside. The first real batch feature can land here. |
| 3 | `/settings/ai`, the workspace panel | Reporting — jobs at the top, cost and quality on the same rows, once there is something to report. |
| 4 | `/admin/ai`, the queue view, golden cases and their scheduled run | Platform controls. Late because until phase 1 exists there is nothing to control but the kill switch, which is a SQL update. |
| 5 | Cron drain, scheduled jobs, the system actor | Unattended work. It needs the queue view above it, because a job nobody is watching needs somewhere to be looked at. |
| 6 | Anonymous features | Last. A stranger spending an owner's money needs every part of this, and needs it proven. |

**Phase 0 ships the job tables even though nothing enforces them yet.** That is
the whole point of doing this now rather than later: `job_id` is `not null` on
the ledger, and a column that becomes mandatory after a month of history is a
backfill of invented parents. The shape is cheap to lay down and expensive to
retrofit, which is the same argument as `actor_id`.

**Phase 2 before any batch feature exists** is deliberate too. The temptation is
to build enrichment first and discover the batch machinery it needs on the way,
which is exactly how the per-call gate came to be the only gate — the first
feature was interactive, so a per-call unit looked sufficient, and it was, right
up until it was not.

Phase 0 before phase 1 is the important ordering, and it applies to both halves.
Setting a spend limit before knowing what a normal month costs produces a limit
that is either meaningless or constantly in the way, and the second teaches
people to ask for it to be raised rather than to look at what they are spending.
A quality floor set before knowing the normal failure rate does the same thing
faster: a feature that disables itself every Tuesday will be switched off
permanently by the third Tuesday, and the floor will be blamed rather than the
thing it was detecting.

The validators are the exception to "measure first" and ship in phase 0 with the
meter. They are not a threshold to be calibrated — they enforce rules the
prompts already state, and a rule stated but unverified is a wish. Their
*consequences* are what waits for phase 1.

## What the build changed

Five things the specification got wrong or left implicit, found by writing it.
They are here rather than edited silently into the text above, because a spec
that always agreed with its implementation would be one nobody checked.

- **`ai_jobs` needed a `held_usd` column.** The envelope check has to know what
  this job's in-flight calls are already holding, and summing reserved calls per
  call would be a scan on the hot path. Spend and hold are two numbers, not one.
- **Only batches get the share rule.** `GRK18` refuses a job larger than half of
  what is left, which is right for a batch holding an envelope and wrong for a
  single call: a `single` job at the end of a lean month would have been refused
  for a ceiling it was never going to reach. Interactive and single jobs check
  one call's worth instead.
- **The per-turn budgets survived.** The spec implied `ai_features.max_tokens`
  replaced the desk's per-turn ceilings. It does not — the reservation is taken
  against the feature's maximum either way, so a close-down asking for 320
  tokens costs a fifth of what a call costs and reserves the same. `maxTokens`
  on a turn is clamped down to the registered ceiling, never up.
- **A child job needs no admission.** Re-running gates 2–10 for a child would
  refuse it out of an envelope with money in it. Only the depth check applies.
- **The desk keeps its counters for now.** The spec said they stop being written
  and become a view. They are dual-written instead: taking them away first would
  mean discovering a discrepancy with nothing left to compare against.
- **The prompt allowance had to become per-feature.** A flat 12,000 tokens was
  sized for the desk, where a four-block transcript really can reach eight
  thousand. An enrichment turn is about nine hundred, so the same allowance
  reserved four times what a four-hundred-book batch could possibly spend — and
  the envelope check then refused jobs that fit comfortably. A worst case that
  is wildly pessimistic is not a safe worst case, it is a limit in the wrong
  place.

## What reading it back found

Four bugs. Three are the same shape: a rule stated in a comment and not quite
delivered by the code beneath it — which is the failure this whole layer exists
to catch one level up, so they are recorded rather than quietly fixed.

- **The root's call ceiling did not count its children's calls.**
  `ai_begin_call` incremented the root's counter only when the root *was* the
  caller, so the check above it could never trip. The envelope still bounded the
  money, which is why nothing looked wrong; a fan-out simply had as many calls
  as it liked.
- **A cache hit threw away the call it had just recorded.** The caller got
  content and nothing to attach a proposal to, so enrichment stopped proposing
  anything for a book whose answer was already cached — exactly the second run
  somebody does after discarding the first suggestion, and it would have looked
  like the feature doing nothing at all.
- **Unticking every field saved every field.** The review form treated "nothing
  ticked" as "no preference expressed" and wrote the lot. An unchecked checkbox
  submits nothing; that is the whole of the ambiguity, and the form always
  renders them.

The fourth is a different and worse shape, because nothing in the design said
anything about it at all:

- **Using a feature made an account undeletable.** Seven foreign keys to
  `profiles` were left at the default `NO ACTION`. A workspace owner was already
  undeletable and always has been — but an editor who owns nothing and ran one
  enrichment became undeletable the moment `ai_jobs` recorded them as an actor.
  A right somebody has, removed silently by a governance layer, which is close
  to the worst way for a governance layer to be wrong. Found by asking what the
  new foreign keys did on delete, not by anything failing.

## Still outstanding

Named so they are not mistaken for decisions already taken. Each is a real gap,
not a refinement:

- **Not calling at all.** Result caching keyed on an input hash, and recording a
  cache hit as a zero-cost row so hit rate is visible. Cheaper than every limit
  here combined, and unmodelled. This is now the largest gap.
- **The scheduler has no identity.** `actor_kind = 'system'` exists in the
  schema and nothing can produce one: a scheduled job has no `auth.uid()`, and
  giving the cron drain a way to say who it is without handing it service_role
  is phase 5's first problem, not an afterthought.
- **Only the desk can be curated from.** Its transcript is in the database
  already; enrichment's input is not stored anywhere, so freezing one of those
  would mean either retaining every prompt or rebuilding the input at curation
  time from a book that may since have changed. Neither is obviously right.
- **Idempotency outside a batch.** `ai_job_items`' primary key covers the batch
  case completely. A double-submitted form on a `single` job is still two jobs,
  and needs a client-supplied key at admission.
- **Environment.** Preview deployments spend production budget and pollute
  production quality metrics. The ledger needs to know which is which.
- **Backoff inside a tick.** The breaker stops a batch hammering a dead
  provider, but there is no wait-and-retry on a single 429: the call fails, the
  item burns an attempt, and the next tick tries again immediately. `Retry-After`
  is read and reported and not yet acted on.
- **Sending the notices.** They are raised as rows and nothing drains them.
  Doing so needs either a scheduled job with a service-role key — which this
  repo has deliberately never had — or somebody pressing the button on
  `/admin/ai`. The rows are there and readable meanwhile, which is better than
  the silence, and worse than an email.
- **Pulling the statement automatically.** It is entered by hand, which is a
  monthly job and honest, but it does mean reconciliation only happens when
  somebody does it. An integration maintained for twelve numbers a year is
  probably worse; a reminder is probably better than either.
- **Provider-side retention.** A deleted account's rows here lose their name,
  but whatever the provider kept of those prompts is not ours to delete, and
  saying otherwise on a privacy page would be a lie.
- **A moderation queue,** for the first feature whose output is published
  rather than proposed. None exists yet, and none should until it does.
