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
| ✅ | All three apps' routes, with editing |
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
/lp/:workspace/pick/:id            edit a week

/reading/:workspace                Reading List — years overview
/reading/:workspace/:year          a year's books
/reading/:workspace/authors        grouped by author
/reading/:workspace/publishers     grouped by publisher (normalised)
/reading/:workspace/book/:id       edit a book

/cigars/:workspace                 Cigar Lounge — the log
/cigars/:workspace/humidor         what is resting
/cigars/:workspace/stats           ratings, brands, spend
/cigars/:workspace/cigar/:slug     one entry
/cigars/:workspace/edit/:slug      edit an entry
```

Each app keeps its own visual identity: its layout loads only its own
stylesheet, so there are no shared tokens underneath to fight in the cascade.
The three stylesheets are the originals, with the editing UI appended below a
marker comment in each.

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

- **Do not filter by user.** `select()` on `workspace_members` returns only the
  caller's memberships already. Adding `.eq('user_id', …)` duplicates a rule the
  database enforces, and the duplicate is the one that will drift.
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
