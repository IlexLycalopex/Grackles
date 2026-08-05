# Grackles — Supabase schema

The `grackles` project (`ophmsvqtzffrjmyjyzza`) backs three apps from one
tenancy model: `listening-party`, `reading-list` and `cigar-lounge`. A
**workspace** is one instance of one app; membership, content and visibility all
hang off it.

## Migrations

Migrations `20260730145656` … `20260731103318` established the core tenancy
model and were applied directly to the project. They are not reproduced here.
The files in `migrations/` are the additions from 2026-08-05, in apply order:

| Migration | What it does |
| --- | --- |
| `20260805120000_creation_grants` | `app_grants` table, `app.can_create()`, backfill, and the new `workspaces_insert` policy |
| `20260805120100_platform_admin` | `profiles.is_platform_admin`, `app.is_platform_admin()`, column-grant hardening on `profiles` |
| `20260805120200_invites_carry_grants` | Nullable `workspace_id` + `grant_apps` on invites; rewritten invite policies |
| `20260805120300_accept_invite_grants` | `accept_invite` redeems membership and/or creation grants, returns `jsonb` |
| `20260805120400_create_workspace_rpc` | `create_workspace()` — entitlement check, slug handling, default seeding |
| `20260805120500_tighten_anon_grants` | Withdraws unused write privileges from `anon` (independent of the above) |

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

## Applying

Ordering matters in one place: `20260805120000` backfills entitlements for
existing owners *before* installing the stricter insert policy. Both are in one
file and therefore one transaction — do not split them.

```sh
supabase db push          # or apply each file in filename order
```

Every migration is additive. The only signature change is `accept_invite`,
which is dropped and recreated because its return type changes; nothing calls it
in production yet. Its grants are re-applied in the same file, since privileges
do not survive a `DROP FUNCTION`.

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
pending invite) so the backfill is exercised against real shape. 30 assertions,
all passing as of `20260805120500`.

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

## Not included

This is the data layer only. Still outstanding before anyone can actually be
invited:

- **No invite email is sent.** Tokens are generated and sit in the table; there
  is one unaccepted invite in production for exactly this reason.
- **No frontend.** The three GitHub Pages apps are static Astro builds from
  committed YAML/markdown with no Supabase client, no auth, no invite-accept
  route, and no workspace switcher.
- **Storage is unaudited.** `cl_cigars.photo_path` implies a bucket; its
  policies are a separate RLS surface and were not reviewed. Check before a
  second tenant uploads anything.
- **Auth signup settings** are project config, not schema. With creation now
  gated, open signup is much less consequential, but it still decides who can
  reach the invite-acceptance step at all.
