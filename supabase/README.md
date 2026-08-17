# Grackles — Supabase schema

The `grackles` project (`ophmsvqtzffrjmyjyzza`) backs the three apps in this
repository from one tenancy model: `listening-party`, `reading-list` and
`cigar-lounge`. A **workspace** is one instance of one app; membership,
content and visibility all hang off it.

## Migrations

Migrations `20260730145656` … `20260731103318` established the core tenancy
model and were applied directly to the project. They are not reproduced here.
The files in `migrations/` are the additions from 2026-08-05, in apply order:

| Migration | What it does |
| --- | --- |
| `20260805120000_creation_grants` | `app_grants` table, `app.can_create()`, backfill, and the new `workspaces_insert` policy |
| `20260805120100_platform_admin` | `profiles.is_platform_admin`, `app.is_platform_admin()`, column-grant hardening on `profiles` |
| `20260805120200_invites_carry_grants` | Nullable `workspace_id` + `grant_apps` on invites; rewritten invite policies; `nulls not distinct` on the pending-invite index |
| `20260805120300_accept_invite_grants` | `accept_invite` redeems membership and/or creation grants, returns `jsonb` |
| `20260805120400_create_workspace_rpc` | `create_workspace()` — entitlement check, slug handling, default seeding |
| `20260805120500_tighten_anon_grants` | Withdraws unused write privileges from `anon` (independent of the above) |
| `20260805120600_invite_lookup` | `invite_email_for_token()` — who an invitation is for, resolved before sign-in |
| `20260807120000_cigar_reference` | `cl_cigar_reference` — the shared cigar lookup cache — plus `cl_cigars.reference_id` |
| `20260807140000_cigar_lookup_cap` | `app.cigar_lookups_today()`, and the insert policy rewritten to use it — the cap as first written could not run |
| `20260807150000_cigar_reference_grants` | Withdraws the UPDATE/DELETE/TRUNCATE that Supabase's default privileges had already granted on the new table |
| `20260809120000_smoke_carries_photo` | `smoke_from_humidor` copies `photo_path` and `reference_id` when it splits one off a stack, plus a backfill for the entries the old version wrote |
| `20260813110000_blackletter_app_slug` | `blackletter` joins the `app_slug` enum — on its own, because `ALTER TYPE ... ADD VALUE` cannot be used in the transaction that uses it |
| `20260813120000_blackletter_schema` | `bl_words`, `bl_puzzles`, `bl_games`; `app.mark_guess()` and `app.blackletter_puzzle()` |
| `20260813120100_blackletter_rpcs` | The four functions that are the whole player-facing surface of the game |
| `20260817120000_cigar_wishlist` | `wishlist` joins the cigar statuses; the date rules restated for three of them; `smoke_from_humidor` accepts a wish as a source |

### What changed conceptually

Before: membership of a workspace was the only fact recorded about a person,
and workspace creation was ungated — any signed-in user could create unlimited
workspaces of any app. "Guest of my lounge" and "runs their own lounge" could
not be expressed separately.

After: creation is an explicit per-app entitlement with a quota, and an invite
can carry membership, creation rights, or both:

```sql
-- "Rob may view my cigar lounge, and run one of his own"
insert into workspace_invites (workspace_id, email, role, invited_by, grant_apps)
values ('<cigar lounge id>', 'rob@example.com', 'viewer', auth.uid(), '{cigar-lounge}');
```

Redeeming it returns what was granted, so the UI knows where to send them:

```jsonc
{ "workspace_id": "…", "role": "viewer", "granted_apps": ["cigar-lounge"] }
```

### Error codes

Custom SQLSTATEs, so callers branch on cause rather than message text:

| Code | Meaning |
| --- | --- |
| `GRK01` | Invite invalid, expired, or already used |
| `GRK02` | Invite belongs to a different email address |
| `GRK03` | No creation entitlement for this app, or quota exhausted |
| `GRK04` | That app/slug pair is taken |
| `GRK05` | Blackletter has used every solution of that length |
| `GRK06` | Not a word in the guess list |
| `GRK07` | That game is finished, or has no attempts left |
| `42501` | Not signed in |

### AI governance (2026-08-14)

| Migration | What it does |
| --- | --- |
| `20260814100000_ai_registry` | `ai_features`, `ai_platform_settings`, `ai_models`, `ai_prompt_versions`, `ai_register_prompt()`, and the desk seeded as it already behaves |
| `20260814100100_ai_budgets` | `ai_budgets` (the `app_grants` analogue), `ai_periods`, `ai_workspace_features`, and a backfill so existing owners keep working |
| `20260814100200_ai_jobs` | `ai_jobs`, `ai_calls`, `ai_job_items`, `ai_proposals`, and their policies |
| `20260814100300_ai_functions` | `ai_begin_job` / `ai_begin_call` / `ai_end_call` / `ai_end_job`, the item claim, both reapers, `my_ai_usage()` |
| `20260814100400_wbpr_metered` | `wbpr_agent_sessions.ai_job_id`, and the desk switched on for every WBPR project |
| `20260814100500_ai_admin` | `ai_admin_spend()`, `ai_admin_queue()`, `ai_set_budget()` |
| `20260814100600_ai_quality_floor` | `ai_enforce_quality_floors()`, and the reaper that calls it |
| `20260814100700_ai_environment` | `ai_jobs.environment` and `idempotency_key`; `ai_begin_job` rebuilt around both |
| `20260814100800_ai_cache` | `ai_cache`, `ai_calls.cache_hit`, and the take/put/sweep functions |
| `20260814100900_reading_enrich` | `ai_features.prompt_allowance_tokens`, and the `reading.enrich` feature |
| `20260814101000_ai_notices` | `ai_notices`, `ai_check_budgets()`, `ai_housekeeping()` and its admin-callable twin |
| `20260814101100_ai_golden` | `ai_golden_cases`, `ai_golden_runs`, `ai_golden_status()`, and the `platform.golden` feature |
| `20260814101200_ai_consent` | `ai_features.sends_records`, per-project consent, transcript retention, and `ai_begin_job` rebuilt around the new clause |
| `20260814101300_ai_fixes` | The root's call ceiling counting its children, and `ai_cache_take` returning the call it records |
| `20260814101400_ai_breaker` | `ai_provider_health`, and the breaker wired into `ai_begin_call` and `ai_end_call` |
| `20260814101500_ai_curate` | `ai_curate_desk_case()` — freezing a real sitting as a golden case |
| `20260814101600_ai_deletion` | `on delete set null` on every AI reference to `profiles`, so using a feature no longer makes an account undeletable |
| `20260814101700_ai_statements` | `ai_statements` and `ai_reconciliation()` — the ledger checked against the provider's own figure |
| `20260814101800_admin_console` | `admin_overview/projects/people/invites/members()` and the controls beside them — the platform console |
| `20260814101900_cigar_lookup` | Registers `cigars.lookup`, bringing the reference desk onto the metered path |
| `20260814102000_search_path` | Pins `search_path` on the four functions that did not, one of which this branch un-hardened by replacing production's `touch_updated_at` |
| `20260814102100_ai_search` | `ai_features.scope`, a nullable `ai_jobs.workspace_id`, and `platform.search` — the first feature that is a person's rather than a project's |
| `20260814102200_enrich_sends_records` | Marks `reading.enrich` as records-sending. It was registered before the column existed and had been exempt from the consent gate written for it |
| `20260814102300_budgets_for_everyone` | An `ai_budgets` row for every profile, and a trigger so every future one gets it. The original backfill covered workspace owners, which stopped being the right set the moment a feature was billed to the asker |

**Applied 2026-08-14**, as four migrations rather than twenty — the layer is not
meaningful in halves, so the files were bundled and applied as units that each
either land or do not. The applied SQL is the files with the prose stripped;
equivalence was checked by comparing a schema fingerprint (columns, defaults,
comment-normalised function bodies, policies, indexes, grants, constraints)
between a database built from the files and one built from the bundle, and then
again between that and production. 360 objects, same digest, across PostgreSQL
16 locally and 17 live.

Two things were settled before applying:

1. **The prices.** `ai_models` is seeded with $0.30/$1.20 per million tokens,
   checked against MiniMax's published rates rather than assumed. Two facts
   about them are on the migration: they are the standard tier for inputs up to
   512K, which is why one row is enough when the largest prompt allowance on the
   site is 12,000 tokens; and they are presented as a permanent 50% discount on
   a $0.60/$2.40 list, which is what `effective_from` exists to survive.
2. **The default allowance.** `ai_platform_settings.default_monthly_usd` is $5,
   and **every profile** now carries an `ai_budgets` row with a null
   `monthly_usd`, so that one figure is the ceiling for everybody who has not
   been given a specific one. A trigger on `profiles` grants a row to each new
   account, which is safe because `login.astro` sets `shouldCreateUser: false`:
   an account exists only because somebody was invited, and the invitation is
   the gate on who may spend. The row is a ceiling, not credit — an admin who
   wants somebody at zero sets it in `/admin`, and nothing here overwrites it.

Ordering matters within the set: `100300` alters the table `100000` creates and
depends on the jobs from `100200`. Apply in filename order.

New SQLSTATEs, continuing the GRK series:

| Code | Meaning |
| --- | --- |
| `GRK10` | No such project, or not visible — deliberately indistinguishable |
| `GRK11` | AI is switched off platform-wide |
| `GRK12` | Feature off, for the platform or for this project |
| `GRK13` | This actor may not run this feature here |
| `GRK14` | Rate limited |
| `GRK15` | The payer's monthly allowance is spent |
| `GRK16` | The project's daily ceiling is reached |
| `GRK17` | Fan-out went past `max_depth` |
| `GRK18` | The job is larger than its share of what is left |
| `GRK19` | The job has reached one of its own ceilings, or is finished |
| `GRK1A` | Too many prompt versions for one feature |
| `GRK1B` | Admissions are paused |
| `GRK1C` | No allowed price for that model |
| `GRK1D` | A preview deployment tried to spend |
| `GRK1E` | The project has not consented to its records being sent |
| `GRK1F` | The provider's breaker is open — nothing was sent |
| `GRK20` | That would remove the last platform admin |
| `GRK21` | That would leave a project with no owner |

### Housekeeping

`ai_housekeeping()` is the one thing that wants scheduling: it releases
reservations whose calls were never settled, reaps jobs whose worker stopped
ticking, sweeps expired cache entries, checks the quality floors and raises a
notice for anyone most of the way through their allowance.

It is granted to `service_role` only, because cron has no session and
`app.is_platform_admin()` is false without one. Until something schedules it,
`ai_housekeeping_now()` — the admin-callable twin, behind a button on
`/admin/ai` — is the only thing that runs it. **A stale reservation holds budget
until one of the two is called**, so this is not a nicety.

Scheduling it needs a service-role key, and this repo deliberately has none.
That is a decision to take deliberately rather than a gap to close quietly.

## Applied

All seven of the 2026-08-05 migrations are live on `ophmsvqtzffrjmyjyzza` as of that date. The
filenames here keep their original `1200xx` ordering; the versions in the database are the times they
actually ran.

The three 2026-08-07 migrations are live as of that date. They must go out together and in order:
`20260807120000` shipped a policy that could not run, and the two after it are the corrections.

`20260809120000` is live as of 2026-08-09. It is self-contained and depends only on
`20260807120000` having added `cl_cigars.reference_id`.

### A third status, and the two rules that were written for two

**`20260817120000` is not applied.** It ships with the app commit that uses it
and must go out with it or ahead of it: the wishlist pages write `status =
'wishlist'`, which the live constraint refuses. Nothing else in the app changes
behaviour if it is applied early — a status nobody writes is a status nobody
notices — so applying it first is the safe ordering.

It adds `wishlist` to `cl_cigars.status`. The wishlist is a state
of a cigar rather than a second kind of object, so it is a value in a column
rather than a table — see the migration's own preamble for the argument, and
`README.md` for what it buys the app.

Three things about it are worth carrying forward.

**The status constraint is dropped by column list, not by name and not by
wording.** It was an inline column check in a migration that predates this
repository, so its name is whatever Postgres generated. Searching
`pg_get_constraintdef` for the word `status` looked like the obvious
alternative and is a trap: four other checks on this table mention `status`, and
a definition search would have dropped all five and put one back. The
enumeration is the only check whose `conkey` is `{status}` alone — nothing but
that column — which identifies it exactly rather than approximately.

**A rule that names one status is not a rule about the other one.**
`cl_humidor_has_no_date` read `status <> 'humidor' or date_smoked is null`,
which was a complete statement of "nothing carries a smoked date until it has
been smoked" for exactly as long as there were two statuses. With three it says
nothing at all about a wishlist row, so one could carry a date smoked and sit in
the log's date ordering without being in the log. It is restated as `status =
'smoked' or date_smoked is null` — about the status that *has* the date rather
than the one that does not — and `cl_smoked_needs_date` is restated alongside it
for the same reason. Both keep their names, because `describeWriteError` maps
constraint names to sentences and a rename turns a sentence back into a dump.

The general form, for the next status anyone adds to anything here: a CHECK
phrased as "X does not have Y" silently stops covering the table the moment a
third X exists. Phrase it as "only Z has Y" and it keeps covering it.

**`smoke_from_humidor` takes a wish as a source.** Its guard was `status <>
'humidor'`, refusing with "that cigar has already been smoked" — true of the
only other status there was. You can want a cigar, get hold of it and smoke it
the same evening, and making somebody file it in the humidor first so they can
immediately take it out again is the bookkeeping the function exists to end. A
'smoked' source is still refused, with the same message. The stack path leaves
the remainder in the source's own status, so a wish for three with one smoked
off it leaves two still wanted.

Nothing about the policies changed. `cl_cigars_read` and its three siblings are
scoped to the workspace and have never looked at `status`, so the wishlist
inherits exactly the visibility the humidor has.

### What the test baseline was hiding

`tests/baseline.sql` reconstructed `cl_cigars` without any of the four CHECK
constraints production carries — the ones `src/lib/records/save.ts` maps to
sentences. The two this migration restates are now in the baseline, in their
**pre-wishlist form**, which is the same tactic `smoke_from_humidor` is
reproduced with: the assertion that a wishlist entry cannot carry a smoked date
fails against the old rule and passes against the new one, which is the only way
it is worth writing.

It also surfaced a test that had been writing a row production would reject.
`tests/admin.sh` inserted a cigar with the column defaults, which means status
'smoked' and no date smoked — refused by `cl_smoked_needs_date` on the real
database, and accepted by the harness only because the harness did not have it.
The insert now names both.

`cl_smoked_is_singular` and `cl_acquired_before_smoked` are still absent from
the baseline. Nothing in `migrations/` touches them, and a reconstruction
nobody has checked against the original is worse than a stated absence.

### A policy may not read its own table

`20260807120000` put the daily lookup cap directly in the insert policy, as a correlated subquery
counting `cl_cigar_reference` — the table the policy is *on*. Postgres answers that with `42P17`,
infinite recursion: evaluating the `WITH CHECK` reads the table, reading the table invokes its
policies, and round it goes.

The failure mode is worth naming because it is not the one you would guess. It was not a cap that
leaked; it was a table that **rejected every insert**, so no lookup could ever have been cached and
the feature would have been dead on arrival. It had been asserted to work in three places before
anybody ran it.

`20260807140000` fixes it with `app.cigar_lookups_today()` — `SECURITY DEFINER`, `STABLE`,
`search_path` pinned, exactly like `app.can_write()` and the seven other helpers. That is what steps
outside RLS long enough to answer a question about the table being guarded, and it is the pattern
this schema already had. The cap stops being a special case.

`app` is not an exposed schema, so the new function is reachable from the policy and not as an RPC.

### An insert that names its columns has to be kept in step

`smoke_from_humidor` takes one cigar out of the humidor. It has two paths, and only one of
them can have this fault.

When the last one goes, the humidor row *becomes* the log entry: an `UPDATE` naming the
columns a smoke changes, leaving everything else alone. When one comes off a stack of
several, the log entry is a **new row** — an `INSERT` naming its columns explicitly — and the
original is decremented. That insert named 23 columns of the 28 on `cl_cigars`. Three of the
five omissions are right (`id`, `created_at`, `updated_at` have defaults that mean it). Two
were not: `photo_path` and `reference_id`.

A named-column insert takes the column default for anything it leaves out, and both of those
default to empty. So a cigar smoked off a stack of two produced a log entry with no image and
no link back to the reference it had been filled from, sitting next to a humidor entry for the
same cigar that still had both.

Two things kept it hidden. The failure is silent — an empty `photo_path` is a legal value, not
an error — and it needs a stack to show up at all, so every single-cigar smoke, which is the
path exercised first and most, was fine.

The generalisation, because this will happen again: **nothing fails when this column list falls
behind the table.** Adding a column to `cl_cigars` does not break the function, does not break
a test, and does not warn. Before adding one, ask whether it describes the *cigar* or the
*occasion*. `wrapper` and `photo_path` describe the cigar and must be copied; `rating` and
`pairing` describe the occasion and must not be. Only the second kind may be left out.

`20260809120000` also backfills, matching a photo-less smoked entry against a humidor entry
for the same workspace, brand and name. It fills only entries that are empty, so nothing set
by hand is overwritten, and `having count(distinct …) = 1` declines to guess where siblings
disagree. It corrected one row in production.

### Naming grants does not withhold the rest

`20260807120000` also said `grant select, insert … to authenticated` and left it there, on the
assumption that naming two privileges withheld the others. Supabase's default privileges on `public`
had already granted `authenticated` the full set on the new table, so that GRANT was additive on top
of DELETE, UPDATE, TRUNCATE and REFERENCES.

Nothing was exposed — there is no update policy and no delete policy, so both resolve to false and a
tampering UPDATE silently touched zero rows. But it made RLS the sole barrier, which is the same
finding `20260805120500` was written about. `20260807150000` revokes them, and a tampering UPDATE now
fails with `42501` at the grant level before RLS is consulted.

The generalisation for anything added later: a new table in `public` starts with full DML granted to
`authenticated`, so a `GRANT` narrows nothing. Withholding takes a `REVOKE`.

### `search_path` and citext

`citext` lives in the `extensions` schema, not `public`. A `SECURITY DEFINER`
function whose `SET search_path` omits `extensions` cannot resolve the type
when plpgsql compiles its body, and fails with `42704: type "citext" does not
exist` — at *call* time, not creation time, so it looks fine until someone uses
it.

The previous `accept_invite` had exactly this fault and had therefore never
worked: the invitation pending since July was failing on it rather than merely
waiting. `20260805120300` fixes it, and `create_workspace` carries the same
path for the same reason.

A policy expression that mentions citext gets away with it, because it is
resolved against the session path when the policy is created. Only function
bodies are affected. `tests/baseline.sql` installs the extension into
`extensions` specifically so this asymmetry is reproduced rather than hidden.

### A table nobody may read

Every other table in this schema is governed by a policy: RLS decides which rows
you get. `bl_words` and `bl_puzzles` are governed by the absence of one. They
have RLS enabled and no policy at all, and the DML grants are revoked from both
`anon` and `authenticated`, so there are two independent refusals before a row
could be reached.

That is deliberate and it is not belt-and-braces for its own sake. `bl_puzzles`
holds the answer to today's puzzle. A policy that is right today can be widened
by a later migration written by somebody who has forgotten what the table is
for; a missing grant fails at the privilege check, before any policy is
consulted, and reads as obviously intentional to whoever reads it next.

Everything a player may know comes back from the four `public.blackletter_*`
functions, which are `SECURITY DEFINER` and do their own `app.can_read()` check
because RLS is not going to do it for them. The pattern is
`app.cigar_lookups_today()` again: stepping outside RLS is what lets a function
answer a question about a table nobody may read.

The consequence worth remembering when writing a test: a check running as
`authenticated` **cannot** look up the answer to assert against. Hoist that read
into a privileged connection outside the check, as `tests/blackletter.sh` does.
A test that can fetch its own answer is testing the opposite of the property.

## Applying

Ordering matters in one place: `20260805120000` backfills entitlements for
existing owners *before* installing the stricter insert policy. Both are in one
file and therefore one transaction — do not split them.

```sh
supabase db push          # or apply each file in filename order
```

Every migration is additive. The only signature change is `accept_invite`,
which is dropped and recreated because its return type changes — so it must go
out together with the app commit that updates its callers, not ahead of it. Its
grants are re-applied in the same file, since privileges do not survive a
`DROP FUNCTION`.

To roll back, the only change that alters existing behaviour is the insert
policy:

```sql
drop policy workspaces_insert on public.workspaces;
create policy workspaces_insert on public.workspaces for insert
  with check (owner_id = auth.uid());
```

## Verifying

`tests/` contains a reconstruction of the pre-migration schema plus Supabase
platform stubs (`auth.uid()`, `auth.jwt()`, the `anon`/`authenticated` roles),
and a behavioural suite covering entitlements, invite issuing and acceptance,
quota enforcement, privilege escalation, anonymous access, and taking a cigar
out of the humidor.

```sh
createdb grackles
psql -d grackles -f tests/baseline.sql
for f in migrations/*.sql; do psql -d grackles -v ON_ERROR_STOP=1 --single-transaction -f "$f"; done
psql -d grackles -f seed/blackletter-words.sql   # bl_words, for tests/blackletter.sh
tests/test.sh
tests/blackletter.sh
tests/ai.sh
tests/admin.sh
```

**All four suites want a fresh database, in that order.** `test.sh` writes rows
outside its rolled-back transactions — grants for Rob, a second lounge — so a
second run against the same cluster fails on its own leftovers. That is not new;
it simply had no neighbour before to make it visible.

`tests/harness.sh` holds `check()` and the role preambles, sourced by all four.

`tests/baseline.sql` previously had no `touch_updated_at()`, which meant every
migration from `20260806170000` onwards failed to apply against the harness —
the whole WBPR schema, its grants, the agent tables and the caller_roll
backfill. The suite passed throughout, because it only ever ran the seven invite
migrations. Anything added after them was untestable until this was noticed.

The baseline seeds current production data (one profile, three workspaces, one
pending invite) so the backfill is exercised against real shape. 41 assertions,
all passing as of `20260809120000`, plus 20 in `tests/blackletter.sh`.

The suites share a database and must not disturb each other. `test.sh`
asserts Jamie holds a grant for exactly three apps, so `blackletter.sh` inserts
its workspace directly rather than through `create_workspace()` — seeding a
fourth grant to get an entitlement broke that assertion, which is the sort of
coupling worth knowing about before adding a third suite.

Two gaps in the baseline were closed to get there, and both had been hiding
things rather than merely omitting them:

- **`cl_cigars` was abridged** to the handful of columns the invite and creation
  migrations touched. `smoke_from_humidor` could not be reproduced against it at
  all, which is precisely why a fault in that function's column list went
  unnoticed. It now carries the production shape, and the pre-fix function, so
  the four new checks fail against the old version and pass against the new.
- **`touch_updated_at` was missing.** It predates every migration here, so
  nothing in `migrations/` creates it — and the first migration that attaches an
  `updated_at` trigger (`20260806170000_wbpr_schema`) therefore aborted. The
  documented `for f in migrations/*.sql` run had been stopping there, leaving
  everything from WBPR onward unexercised.

## Two security fixes worth noting

Both pre-date this work and are corrected here:

1. **`profiles.email` was user-writable.** `authenticated` held table-level
   `UPDATE`, and `profiles_update_self` permits updating your own row — so a
   user could rewrite their profile email to a pending invitee's address and
   claim their invite. Fixed in two independent ways: the update grant is now
   column-scoped to `display_name, avatar_url`, and `accept_invite` matches
   against `auth.users` rather than `profiles`.

2. **`anon` held full DML on every table.** Nothing was exposed — every write
   policy resolves to false without an `auth.uid()` — but RLS was the sole
   barrier. `20260805120500` withdraws it.

## The app side

These migrations ship with the code that uses them:

- `src/lib/grants.ts` — what the signed-in user may create, and the SQLSTATEs
  as sentences.
- `src/pages/new.astro` — calls `create_workspace()`.
- `src/pages/invite/[token].astro` — calls `accept_invite()` and routes on what
  came back: into the project when it granted membership, to `/new` when it
  granted the right to make one. Signed out, it calls
  `invite_email_for_token()` and sends a magic link to that address.
- `src/pages/settings/[app]/[workspace].astro` — the `grant_apps` control,
  rendered only for platform admins because that is what the RLS policy allows.

### How someone with no account gets one

`/login` sends magic links with `shouldCreateUser: false`, so an address that
has never signed in cannot make itself an account — which is the point, since
creation is meant to be by invitation. But nothing turned an invitation *into*
an account, so every invitee hit `422 otp_disabled`, and the form reports that
as success to avoid confirming whether an address is registered. Two invitations
sat unredeemed with nobody able to see why.

The invitation link now carries the whole flow. `/invite/<token>` resolves the
token to its address and emails a link there with `shouldCreateUser: true`; the
callback returns to the same URL, now signed in, and the invitation is redeemed
on that request. The invitee never types their address.

Holding the token is the authorisation — 64 hex characters, only ever sent to
the invited address. Keying it on the token rather than an email is deliberate:
`has_pending_invite(email)` would let anyone with the publishable key test
whether an address had been invited.

`accept_invite`'s return type changed from `uuid` to `jsonb` in
`20260805120300`. Its callers changed in the same commit; anything else calling
it would break.

## Not included

- **Storage is unaudited.** `cl_cigars.photo_path` implies a bucket; its
  policies are a separate RLS surface and were not reviewed. Check before a
  second person uploads anything.
- **Auth signup settings** are project config, not schema. With creation now
  gated, open signup is much less consequential, but it still decides who can
  reach the invite-acceptance step at all.
- **`(select auth.uid())` in policies.** Supabase's linter flags every policy
  that calls `auth.uid()` directly, because it is re-evaluated per row. The
  policies here follow the existing pattern rather than fixing it; worth a
  sweep across old and new together.
