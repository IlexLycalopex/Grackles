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
| ⬜ | Custom SMTP — until then invite links must be copied by hand from settings |
| ⬜ | DNS cutover from GitHub Pages to Vercel |

The launcher at `/` is unchanged in appearance. Its nav still links out to the
five sites that have not moved; the three that have now point at in-app routes.

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
| `lib/records/save.ts` | turns a rejected write into a sentence and logs the original |

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
│   ├── apps.ts              app registry — slug ↔ URL path, launcher links
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
