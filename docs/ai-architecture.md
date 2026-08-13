# AI governance

A specification, not a description: none of this is built yet. It is the layer
that has to exist before a second feature starts spending money.

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

The rest of this document is the answer to those four questions, in the shape
this codebase already uses for the same class of problem: entitlements in the
database, checked by a `SECURITY DEFINER` function, defaulting to deny, with a
platform admin who may hand them out.

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

  -- Optional grouping — one WBPR sitting, one enrichment batch. The successor
  -- to wbpr_agent_sessions' counters.
  session_id     uuid references public.ai_sessions(id) on delete set null,

  provider       text not null,
  model          text not null,

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

`ai_sessions` is `wbpr_agent_sessions` with the WBPR-specific columns removed:
workspace, feature, status, `state jsonb`, created_by, timestamps. WBPR keeps
its own table for the transcript and the night's state; what it gives up is the
three counters, which become a view over `ai_calls`.

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

## The two-phase call

Every AI call in the system goes through the same pair of functions. There is no
second path, and `lib/ai/` is the only place `minimax.ts` is imported from.

```sql
-- Phase one: may this call happen, and hold its worst case.
--
-- SECURITY DEFINER because it reads platform settings and other people's
-- budgets — questions RLS deliberately cannot express for the caller, the same
-- reasoning as my_pending_invites().
create function public.ai_begin_call(
  p_feature      text,
  p_workspace    uuid,
  p_fingerprint  text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
...
$$;

-- Phase two: settle it.
create function public.ai_end_call(
  p_call        uuid,
  p_prompt      integer,
  p_completion  integer,
  p_error       text default null
) returns void
```

### The order of the gates, and why it is fixed

`ai_begin_call` checks in this order. The order is load-bearing in the same way
`requireWrite()`'s is — it is what decides which failure a caller learns about,
and one of these must not be the first thing a stranger discovers.

| # | Check | Raises |
|---|---|---|
| 1 | The workspace exists and this caller may see it | `GRK10` — indistinguishable from not existing, because a private project must not announce itself by refusing an AI call differently from a missing one |
| 2 | Platform `enabled` | `GRK11` |
| 3 | Feature exists and is `enabled` | `GRK12` |
| 4 | Workspace has it enabled | `GRK12` — same code; the distinction is the admin's business, not the visitor's |
| 5 | Actor clears `min_role`, and `allow_anon` if anonymous | `GRK13` |
| 6 | Rate limit for this actor or fingerprint | `GRK14` |
| 7 | Payer's budget has room for the reservation | `GRK15` |
| 8 | Workspace's `daily_usd` has room | `GRK16` |

Check 1 first, always. Everything after it may reveal that a workspace exists.

Checks 7 and 8 last because they write, and the six before them are pure reads
that will refuse most bad requests without touching the counter row.

The reservation is `max_tokens × completion price`, plus a flat allowance for
the prompt — the worst case, not an estimate. A budget that can be exceeded by
one unusually long call is not a budget; the difference comes back on settle,
so the only cost of being pessimistic is briefly under-reporting the remaining
allowance.

### When phase two never happens

A crash between the two leaves a `reserved` row holding budget forever. A
sweeper releases anything still `reserved` after fifteen minutes:

```sql
update public.ai_calls set status = 'released', settled_at = now()
 where status = 'reserved' and created_at < now() - interval '15 minutes';
```

Fifteen because it must comfortably exceed the longest call the platform allows
and be short enough that a crash does not lock somebody out of their own budget
for an afternoon. Released rather than charged is a judgement call and worth
stating plainly: a call whose outcome we never saw *may* have been billed by the
provider, so this errs toward the user rather than toward the invoice. The rows
stay in the ledger marked `released`, so a discrepancy against the provider's own
statement is visible rather than invented.

## The application side

```
src/lib/ai/
├── provider.ts     the interface: one `complete(messages, opts)` per provider
├── minimax.ts      today's implementation, moved, otherwise unchanged
├── features.ts     the code-side mirror of ai_features — keys and their types
├── json.ts         ask for a shape, parse, validate, fail to a sentence
└── meter.ts        withMeter(): the only way to reach a provider
```

`meter.ts` is the whole of the application-side contract:

```ts
/**
 * The one door to a provider.
 *
 * Nothing in src/pages imports a provider directly. The reservation is taken
 * before the call and settled after it, including on failure — a call that
 * errored still spent tokens often enough that treating failure as free is how
 * a budget quietly stops working.
 */
export async function withMeter<T>(
  ctx: { supabase: SupabaseClient<Database>; feature: FeatureKey; workspaceId: string; fingerprint?: string },
  run: (chat: MeteredChat) => Promise<T>
): Promise<Metered<T>>
```

Callers get a `chat` that has already had its `max_tokens` clamped to the
feature's registered ceiling — the budget was reserved against that number, so
a caller who could pass a larger one would be spending money that was never
held.

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

`GRK15` is the owner's own allowance even when an editor triggered it, and the
sentence shown to the editor says so — "the owner's allowance for this month is
spent" — because otherwise they will read it as their own and be confused by a
limit they cannot see.

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

**The last fifty calls.** Feature, project, when, tokens, cost, and the error if
it failed. Failed calls are shown, with their cost — a page that hides them is a
page that cannot explain a bill.

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
change `min_role`. Disabling a feature is the surgical version of the kill
switch and should be the more common action.

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

1. `ai_sessions` gains a row per sitting; `wbpr_agent_sessions` gains a
   nullable `ai_session_id`.
2. `prompt_tokens`, `completion_tokens` and `calls` stop being written and are
   replaced by a view over `ai_calls`. They are kept, not dropped, until the
   view has been checked against them for a full night.
3. The chat and log routes wrap their `chat()` calls in `withMeter`. The
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

## Order of work

Each phase is useful on its own and none of them requires the next.

| Phase | What ships | Why this order |
|---|---|---|
| 0 | `ai_features`, `ai_models`, `ai_calls`, `ai_sessions`, `withMeter`, WBPR wrapped | Recording only — no gate, no budget, no behaviour change. A month of real data before anything starts refusing on the strength of it. |
| 1 | `ai_budgets`, `ai_periods`, `ai_begin_call`/`ai_end_call`, the sweeper | The ceilings, informed by what phase 0 actually measured rather than by a guess. |
| 2 | `/settings/ai`, the workspace panel | Reporting, once there is something to report. |
| 3 | `/admin/ai` | Platform controls. Last because until phase 1 exists there is nothing to control but the kill switch, which is a SQL update. |
| 4 | Anonymous features | Only after 1–3. A stranger spending an owner's money needs every part of this, and needs it proven. |

Phase 0 before phase 1 is the important ordering. Setting a limit before knowing
what a normal month costs produces a limit that is either meaningless or
constantly in the way, and the second one teaches people to ask for it to be
raised rather than to look at what they are spending.
