# Grackles

The front door at [grackles.co.uk](https://grackles.co.uk), and — as of this
branch — the app that the Listening Party, Reading List and Cigar Lounge are
moving into.

Those three used to be separate static Astro sites on GitHub Pages, each
storing its records as YAML or Markdown committed to the repo. Adding a record
meant editing a file and waiting for a deploy. They are becoming one
server-rendered app backed by Supabase, so records are created through a UI and
several people can share a project.

## Where things stand

| | |
|---|---|
| ✅ | Supabase schema, RLS, and the existing data imported (see the `listening-party` repo, `supabase/migrations/`) |
| ✅ | Astro 6 + Vercel adapter, `output: 'server'` |
| ✅ | Magic-link sign-in, session cookies, `/dashboard` |
| ✅ | All three apps' routes, with creating and editing |
| ✅ | Invites, member roles and per-workspace visibility |
| ✅ | The launcher reads from the database; all eight sites exist as workspaces |
| ⬜ | Custom SMTP — until then invite links must be copied by hand from settings |
| ✅ | DNS cutover — grackles.co.uk and www resolve to the Vercel project, and the GitHub Pages CNAME is gone |

The launcher at `/` is unchanged in appearance but no longer carries a list.
Its nav is whatever the visitor is a member of: signed out it offers one thing,
a way in.

That is why all eight sites now exist as workspaces, including the five still
served from GitHub Pages. Those carry a `workspaces.external_url` and the nav
links there instead of at an in-app route. Migrating one is then a one-column
update — clear `external_url` and the same workspace, with the same members at
the same address, starts being served from here.

`hosted` in the app registry is the other half of it: a project can *be* an
Atelier Obscura, but one cannot be *started*, because there is one site and it
is not served from this repo. Entitlements, `/new` and the invite grant picker
all work from `HOSTED_APPS` rather than `APPS`. The database would allow a
platform admin to create one — `app.can_create()` says yes to an admin for
every value of the enum — so this is the only thing stopping it being offered.

## Routes

```
/                                  launcher
/login  /auth/callback  /logout    magic-link auth
/dashboard                         your projects across all apps
/invite/:token                     accept an invitation
/settings/:app/:workspace          members, roles, invites, visibility (owner only)

/lp/:workspace                     Listening Party — current season
/lp/:workspace/:season             a season
/lp/:workspace/artists             every artist
/lp/:workspace/contributors/:slug  one person's picks
/lp/:workspace/pick/new            add a week's pick
/lp/:workspace/pick/:id            edit a week
/lp/:workspace/season/new          start a season
/lp/:workspace/season/:slug        season settings and roster
/lp/:workspace/contributor/new     add someone who picks
/lp/:workspace/contributor/:slug   rename, recolour or remove them

/reading/:workspace                Reading List — years overview
/reading/:workspace/:year          a year's books
/reading/:workspace/authors        grouped by author
/reading/:workspace/publishers     grouped by publisher (normalised)
/reading/:workspace/book/new       add a book
/reading/:workspace/book/:id       edit a book
/reading/:workspace/year/new       add a year
/reading/:workspace/year/:year     year status and target

/cigars/:workspace                 Cigar Lounge — the log
/cigars/:workspace/humidor         what is resting
/cigars/:workspace/stats           ratings, brands, spend
/cigars/:workspace/cigar/:slug     one entry
/cigars/:workspace/new             add to the humidor or the log
/cigars/:workspace/edit/:slug      edit an entry
/cigars/:workspace/smoke/:slug     take one out of the humidor
```

Static segments beat dynamic ones in Astro's routing, so `pick/new` wins over
`pick/[selection]`. That is load-bearing — do not give a create route a name a
record id could also match.

Every record's own page also answers `?delete=1`, which swaps the form for a
confirmation. There is no separate delete route.

Each app keeps its own visual identity: its layout loads only its own
stylesheet, so there are no shared tokens underneath to fight in the cascade.
The three stylesheets are the originals, with the editing UI appended below a
marker comment in each.

## Writing a record

Every write in all three apps goes through the same four pieces. Adding a field
to a record means touching two of them, and adding a new kind of record means
following the shape rather than inventing one.

| | |
|---|---|
| `lib/forms.ts` | reads a `FormData` — `str`, `int`, `date`, `bool`, `list`, `choice` — and decides what a field displays: the rejected submission, else what is stored, else a default |
| `lib/records/<thing>.ts` | one `read<Thing>(form)` per record type, returning either the row to write or one sentence to show. Every rule that mirrors a database constraint lives here, once |
| `components/<app>/<Thing>Fields.astro` | the fields themselves, rendered by both the create and the edit route |
| `lib/records/save.ts` | turns a rejected write or delete into a sentence and logs the original |
| `components/ConfirmDelete.astro` | the confirmation step, shared by all three apps |

The point of the third one is that **create and edit are the same form**. A page
passes `null` for the record and it is a create form; it passes the record and
it is an edit form. There is no second copy of the markup to keep in step, which
is what stopped the two drifting apart the moment a column was added.

The point of the second is that a rule is written once and enforced twice: the
form checks it so the answer is a sentence, and the database checks it because
that is what actually guarantees it. `save.ts` exists for the gap between them —
a race, or a constraint the form has not caught up with — and degrades to plain
English instead of `violates check constraint "rl_books_dates_ordered"`.

Two things are deliberate and easy to undo by accident:

- **A failed save re-renders what was typed, not what is stored.** Pages pass
  the submitted `FormData` into the fields component. Drop it and correcting one
  mistake silently discards every other change made in that sitting.
- **`requireWrite()` checks in a fixed order** — unreadable workspace 404s
  *before* the signed-out redirect, so a private project never announces itself
  by bouncing a stranger to the login page.

## Deleting a record

`?delete=1` on a record's own page swaps the form for a confirmation; the
button POSTs `intent=delete` back to the same URL. Both halves are deliberate.
A GET that deletes is one link prefetcher away from emptying the humidor, and a
`confirm()` dialog is not a confirmation on the day the script fails to load.

Two foreign keys cascade, so the confirmation counts what goes with the record:
deleting a season deletes its picks, and deleting a year deletes its books. A
third is `ON DELETE RESTRICT` — `lp_selections.contributor_id` — so the database
refuses to remove someone who has picks rather than taking their weeks with
them. Their picks are the record; the page says so before the button is pressed.

**Every delete asks for the removed rows back and checks it got one.** This is
not defensive habit, it is required: a delete blocked by row-level security does
not raise, it narrows the statement to zero rows and reports success. Without
the check, a viewer whose role changed mid-session would be told the record was
deleted while it sat there untouched.

## One write that is not a statement

Taking a cigar out of the humidor is the one write that is not a single
statement: smoking one of three has to add a log entry *and* leave two behind.
It is a database function (`smoke_from_humidor`) so the two cannot come apart,
`SECURITY INVOKER` so RLS still decides, and it converts the last one in place
rather than replacing it — the entry keeps its id and its URL.

## Running it

```bash
npm install
cp .env.example .env    # already points at the shared Supabase project
npm run dev             # http://localhost:4321
```

`npm run check` type-checks; `npm run build` produces the Vercel output.

## How authorisation works

There is no permission code in this app, and there should not be any. Every
query goes through a Supabase client carrying the user's session, and row-level
security decides what comes back. If a page can see a row, the database said so.

That has a few consequences worth knowing before adding a page:

- **RLS decides what you *may* see, not what you *want*.** Do not assume a
  policy narrows a query to one row. `workspace_members` is readable by every
  member of a workspace, by design, so a lookup of "my role" must still say
  `.eq('user_id', …)`. Getting this wrong once already shipped a bug: a public
  workspace reported `owner` to anonymous visitors, and the query would have
  started erroring outright as soon as a second member joined.
- **Anonymous visitors are a supported case,** not an error to guard against.
  They see workspaces marked `public` — which is how the Listening Party stays
  readable at a shareable URL.
- **Writes fail closed.** A `viewer` who POSTs anyway gets rejected by the
  database, so a missing UI check is a cosmetic bug rather than a hole.

`middleware.ts` puts `locals.supabase` and `locals.user` on every request. It
uses `getUser()` rather than `getSession()`: `getSession` only decodes a cookie
the client controls, while `getUser` verifies the token with the auth server.

## Layout

```
src/
├── lib/
│   ├── apps.ts              app registry — slug ↔ URL path, where a project lives
│   ├── database.types.ts    generated; regenerate after every migration
│   └── supabase/            server (cookie-bound) and browser clients
├── middleware.ts            session + locals
├── layouts/
│   ├── Base.astro           html shell, fonts, paper background
│   └── AppShell.astro       masthead + container for signed-in pages
├── pages/
│   ├── index.astro          the launcher
│   ├── login.astro          magic-link request form
│   ├── auth/callback.ts     exchanges the link's code for a session
│   ├── logout.ts            POST only
│   ├── invite/[token].ts    calls accept_invite()
│   ├── dashboard.astro      your workspaces across all three apps
│   ├── settings/            per-workspace members, roles, visibility
│   ├── lp/                  Listening Party
│   ├── reading/             Reading List
│   └── cigars/              Cigar Lounge
└── styles/
    ├── tokens.css           shared palette and type
    ├── launcher.css         the front door, scoped to body.launcher
    ├── app.css              chrome for the shell pages
    ├── listening-party.css  ┐
    ├── reading-list.css     ├ each app's original stylesheet
    └── cigar-lounge.css     ┘
```

`lib/workspace.ts` is the shared entry point for every app route:
`resolveWorkspace(supabase, app, slug)` returns the workspace plus the caller's
role, or null when it does not exist **or** may not be seen — the two are
deliberately indistinguishable, so a private project 404s rather than
announcing itself with a 403.

## Deployment notes

Two things are needed before this can serve real users:

1. **Custom SMTP.** Supabase's built-in sender is capped at a few messages an
   hour and is not for production — magic links and invites will silently fail
   without Resend (or similar) configured under Authentication → Settings.
2. **Redirect URLs.** `/auth/callback` must be listed under Authentication →
   URL Configuration for every origin used, including Vercel preview domains.

`shouldCreateUser: false` on the login form means signing in does not create an
account. People arrive by invitation, or not at all.
