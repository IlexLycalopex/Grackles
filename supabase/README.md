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
| `20260807120000_cigar_reference` | `cl_cigar_reference` — the shared cigar lookup cache — plus `cl_cigars.reference_id`. **Not yet applied.** |

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
| `42501` | Not signed in |

## Applied

All seven of the 2026-08-05 migrations are live on `ophmsvqtzffrjmyjyzza` as of that date. The
filenames here keep their original `1200xx` ordering; the versions in the database are the times they
actually ran.

`20260807120000_cigar_reference` is **not applied**. It is additive — one new table, one new nullable
column — so it can go out whenever, but it has to go out before anything calls
`/api/cigars/:workspace/lookup`, which selects from a table that does not exist yet. Its one
dependency is `app.can_write()`, which has been there since the core tenancy model.

Its insert policy contains a `count(*)` subquery over the table it guards — the daily cap. That is
unusual enough to be worth knowing about before someone reads it and assumes it is a mistake: the cap
is a property of the database rather than a courtesy of the route, on the same reasoning that puts
every other write rule in RLS. It costs a scan of one workspace's rows for the last day, which the
`(workspace_id, created_at desc)` index serves and which is bounded at fifty by the thing it is
counting.

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
quota enforcement, privilege escalation and anonymous access.

```sh
createdb grackles
psql -d grackles -f tests/baseline.sql
for f in migrations/*.sql; do psql -d grackles -v ON_ERROR_STOP=1 --single-transaction -f "$f"; done
tests/test.sh
```

The baseline seeds current production data (one profile, three workspaces, one
pending invite) so the backfill is exercised against real shape. 37 assertions,
all passing as of `20260805120600`.

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
