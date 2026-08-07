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
| ✅ | WBPR migrated off GitHub Pages — nine sessions, five tables, editable in place |
| ✅ | The WBPR broadcast agent (MiniMax M3) — running; the one-click write-up is the last untested path |
| ✅ | Cigar Lounge search — a filter box on the log and the humidor, matching words, wrappers and sizes |
| ✅ | Cigar lookup — schema applied, the reference desk, the panel on the add form, and an entry showing what a lookup said about it |
| ⬜ | WBPR's map and veil pages — left behind in the migration, see below |
| ✅ | Custom SMTP — Supabase's own magic-link and confirmation emails go out through Resend, alongside the app's invitations |
| ✅ | DNS cutover — grackles.co.uk and www resolve to the Vercel project, and the GitHub Pages CNAME is gone |

The launcher at `/` is unchanged in appearance but no longer carries a list.
Its nav is whatever the visitor is a member of: signed out it offers one thing,
a way in.

A project's subtitle — `workspaces.description` — is editable from its
settings page. It is the line under the name on the dashboard, and on the
Listening Party it is also the page's meta description wherever a season has
not supplied its own. Capped at 200 characters by the form and by
`workspaces_description_length`, because both places it lands have a size past
which they stop working. That is the box the five external projects were left
empty for.

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
/settings/:app/:workspace          subtitle, members, roles, invites, visibility (owner only)

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
/cigars/:workspace/lookup          the reference desk — what is this cigar? (editors only)
/api/cigars/:workspace/lookup      the same question as JSON (cache first, then the model)

/wbpr/:workspace                   WBPR — the broadcast archive
/wbpr/:workspace/phenomena         everything seen, folded by key
/wbpr/:workspace/soundtrack        every track played, by artist
/wbpr/:workspace/:session          one night on air
/wbpr/:workspace/broadcast/new     log a broadcast
/wbpr/:workspace/broadcast/:id     its header, notes and phenomena log
/wbpr/:workspace/block/:id         one block — cards, playlist, the call
/wbpr/:workspace/run               the desk — run a broadcast with the model (owner only)
/api/wbpr/:workspace/chat          one turn at the desk
/api/wbpr/:workspace/log           write the sitting up as a broadcast
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

## Planning next year

A reading year is `planning`, `active` or `complete`. The third state is the new
one, and it exists because next year's list gets built while this year is still
being read.

Written as `active` it would be a *second* year in progress, and that breaks one
thing in particular: years come back newest-first, so every page that wants "the
year this list is on" would take the plan. Adding a book in November would file
it under a year that has not started. `currentYear()` is that question asked
once — the newest year still being read, skipping over anything being planned —
and `book/new` is what asks it. **The year under way stays the default
everywhere; a plan is only ever reached by asking for it by name.**

A year created ahead of the calendar opens as a plan, and a book added to one
opens with *coming up* ticked. Both are defaults on a form, not rules: the
status is a field and the checkbox is a checkbox.

The overview leaves plans out of its totals — books, pages, years, audio share.
Those numbers are claims about what happened, and twenty books chosen for next
year should not move any of them. They are counted separately, under *Planned*.
The authors and publishers pages do include them, on the same footing as any
book already marked *coming up*; those pages are a catalogue of the list rather
than a tally of it.

## The target

`rl_years.total_books` was collected by the form and read by nothing. It now
draws a bar in two places — the year's own page and its card on the overview —
and what it is measured against depends on what the year is:

| | |
|---|---|
| planning | books chosen against books wanted, and how many are still to choose |
| active | books read against the target, **and against the calendar** — the target spread evenly across the year, read at today's date, so the year is so many ahead of or behind pace |
| complete | met, beaten, or short by so many |

Two things decide what counts, and they differ on purpose. A year under way
counts only books that are not `coming_up`: counting intentions would let a
target be met by writing a list, which is the one thing a target exists to rule
out. A year being planned counts every book in it, because choosing them is the
whole activity and they are all `coming_up` by definition.

The pace is linear, and that is a choice rather than a simplification worth
fixing. Reading is not evenly paced — a fortnight off does more for the count
than a fortnight of work — but a target is a flat number, and the only pace that
can be checked against a flat number is a flat one. Anything cleverer would be a
model of a reading year, and it would be wrong about this one.

**A target of zero is refused by the form.** Blank means "not counting", which is
a different thing: zero is a target the year meets before it starts, and every
reading of it downstream is nonsense.

One thing to know about the imported data: on the years that came across from
the static site, `total_books` holds the number of books that year *ended up*
with, not a number set in advance. Every finished year therefore reads as
exactly met. That is what the column contained; setting real targets on them
retroactively is the only thing that would change it, and only 2026 onward has
a target that was a target.

## WBPR

The fourth app, and the first of the five outside sites to actually move in.
Its nine sessions were markdown with YAML frontmatter in a separate repo; they
are now five tables — `wbpr_broadcasts`, and `wbpr_blocks`, `wbpr_prompts`,
`wbpr_tracks`, `wbpr_phenomena` hanging off it. The JSON they were converted
through is kept at `supabase/seed/wbpr-sessions.json` with the script that
produced it, because an import you cannot re-run is one you cannot check.

Two things are deliberately derived rather than stored:

- **The caller count.** The markdown carried `callers: 2` in its frontmatter,
  which is exactly the field that goes stale the first time somebody corrects a
  die roll. The blocks are the record, so they are what gets counted.
- **The phenomena catalogue.** There is no standing table of phenomena. A
  sighting is logged against the night it was seen, and a phenomenon's current
  status is whatever the most recent broadcast said — so the catalogue is the
  log read newest-first and folded by key. Nothing can disagree with itself
  because there is only one copy.

`veil_status` is a plain text column with no CHECK, unlike `caller_type` beside
it. Session 1 says `Normal` and later ones say `Thin`; the vocabulary drifted
over nine broadcasts and will drift again, and a constraint that has to be
migrated before a night can be logged is a constraint in the way.

Moving the site in was one `update` clearing `external_url`, plus flipping
`hosted` in the registry. Those two have to ship together — a cleared column
with no routes behind it is a 404.

## What did not come across from WBPR

Two pages, and the reason is that I chose not to port them rather than that
anything blocked them. The migration was scoped to the log and its editing —
add a broadcast, correct one — and these are derived views over data that had
not moved yet:

- **The map.** 1,254 lines plotting caller locations and phenomena against
  Montana. Every coordinate it needs is imported and populated —
  `wbpr_broadcasts.lat/lon`, `wbpr_blocks.caller_lat/lon`,
  `wbpr_phenomena.lat/lon` — so this is a porting job, not a data one.
- **The veil chart.** 726 lines tracking veil intensity across sessions.
  `veil_status` and `veil_intensity` are both on the broadcast.

Nothing about either is harder now than it was; they are simply not done. The
standalone site is still the only place they exist.

## Duplicates the migration inherited

Two artists were spelled two ways across nine sessions — "Zac Bryant" for Zach
Bryan, and the Kilimanjaro Darkjazz Ensemble with and without its article. Both
split one artist into two entries on the soundtrack page. Found by looking for
one track title credited to more than one artist, which catches a typo where
comparing artist names to each other does not, and corrected in place.

Every block's prose also opened by restating what the columns beside it already
held:

    **Caller:** Yes (rolled 4 — standard)
    **Caller card:** Nine of Diamonds — *mundane life grinding them down*

That is the markdown showing through — in the old site the frontmatter was
invisible, so the body had to say it. Here it printed twice. The lines are gone,
but not before `caller_roll` was added and backfilled from them: they were the
only record of the die face, and of the difference between rolling a 1 and never
rolling at all. Deleting them first would have thrown the dice away.

## Running a broadcast with the model

`/wbpr/:workspace/run` is a desk: it opens a night, draws for each block, rolls
for callers, and writes the whole thing up into the five tables with one press.
It is owner-only, in the RLS policies and re-checked in the API route — a page
check protects the button, not the URL that spends money.

**The deck is in `lib/wbpr-deck.ts`, not in the prompt.** The rules carry four
tables of thirteen card meanings and four of caller topics: a little over 2,500
tokens of pure lookup. Sending them so the model can read a row out of them
means renting the rulebook on every turn, all night. Instead the app draws,
resolves the meaning, and sends one line — `Drawing: Seven of Clubs (something
that changed your taste), …`. For a four-block night that is roughly 3k tokens
of overhead rather than 16k, and the model cannot misread a table it never sees.

The die is the same argument with a sharper point. A model asked to roll d6
returns a *plausible* number, not a random one, and a broadcast is a record
somebody keeps. `crypto.getRandomValues` with rejection sampling, because a
modulus of a 32-bit draw biases the low faces.

Three more things hold the cost down:

- `thinking: { type: 'disabled' }` on every call. M3 turns on adaptive thinking
  when the parameter is omitted on the OpenAI-compatible path, so leaving it out
  silently buys reasoning tokens for a DJ improvising over a card draw.
- `max_tokens` per kind of turn — a ceiling on cost, not just on length.
- The system prompt is identical every turn, so a provider-side prefix cache has
  something to hold onto.

**What the write-up asks for, and what it does not.** The cards drawn, the dice
rolled, the block numbers and the session number are all things this app decided
and has been holding in `wbpr_agent_sessions.state`. They are written from
there. The model supplies only what it alone knows — the prose, the atmosphere,
which phenomena the night touched. It is never asked for a card, because it
would comply: plausibly, sometimes wrongly, and the archive would carry a Seven
of Clubs that was never drawn.

Token counts are columns on the session rather than something inferred
afterwards. Protecting token usage is only a real property if somebody can see
what was spent.

## Photographs

There is no upload. A cigar's photo is a URL typed into the edit form, checked
there and by `cl_cigars_photo_path_shape` to be `http(s)://` — the bare-path
form the column once held resolved against the site root, which is how photos
worked when entries were markdown with the images committed beside them, and
resolves to nothing now.

The card shows it as a thumbnail beside the title and the entry shows it whole:
capped at `min(75vh, 42rem)` and `object-fit: contain`, because a cap that
crops is a cap that hides the band. Cropping is the card's job.

Adding real uploads later does not undo any of this — a Supabase storage public
URL is absolute, so it satisfies the same constraint and lands in the same
column.

## Searching a lounge, and looking a cigar up

The Cigar Lounge had no search of any kind, and adding a cigar meant typing
eleven fields. Both are the same question asked from two ends — *which cigar is
this* — so there is one matcher, one cache and one endpoint behind them.

A query goes through three stages and stops at the first that answers:

1. **The workspace's own entries.** Free. Both list pages already load every row
   in order to render at all, so `CigarFilter.astro` filters what is on the page
   rather than asking the server for a narrower set.
2. **The shared reference cache**, `cl_cigar_reference` — one select, holding
   every cigar anybody has ever looked up.
3. **One call to M3**, reached only on a genuine miss.

**Stages 1 and 2 run as you type; stage 3 is a button.** That is the whole cost
design and it is worth stating plainly, because the obvious implementation — a
debounced type-ahead against the endpoint — spends money answering queries
somebody is still halfway through writing.

The matcher lives in `lib/cigar-search.ts` and is imported by the browser script
and by the endpoint both. One definition means a query that finds a cigar in
your humidor finds the same cigar in the cache, which is what makes "answer for
free before answering for money" true rather than aspirational. Words are ANDed;
accents are folded, because nobody reaches for the compose key to find a Padrón
they already own; and `5x50` or `rg50` is matched against the measurements
rather than the text, since `4 7/8"` in one column and `50` in another contain
that string nowhere.

**The cache is global, not per workspace.** A Serie D No. 4's dimensions are a
fact about the world, so scoping them per lounge would mean paying for the same
answer once per member. Shared, the second person to look one up pays nothing.
`workspace_id` and `looked_up_by` record who asked and who paid — attribution,
not scope. The table is insert-only at the policy level: one member cannot
rewrite what another's lookup found, only add alongside it.

**The call is one system message and one user message.** No history — a lookup
is stateless, and unlike a night at the desk there is nothing to carry. The
schema and rules are in the system prompt, byte-identical every time, so they
cost the same tokens as putting them in the user turn and give a provider-side
prefix cache something to hold; the user turn is the query alone, under twenty
tokens. `max_tokens` 400, temperature 0.2 — recall rather than invention, which
also makes two people asking about one cigar likelier to mint one canonical key
instead of two rows.

`response_format` is not used, because M3 does not usefully support it on the
OpenAI-compatible path: the parameter documented for MiniMax-Text-01 is accepted
and ignored rather than rejected, which is the worst of the three possible
behaviours. The shape is asked for in the prompt and read back by
`parseJsonObject` in `lib/json.ts`, lifted out of the WBPR write-up so there is
one copy.

### What it is not asked for

**No rating, no score, no price, and nothing attributed to a publication.** An
earlier draft of this carried a Cigar Aficionado score and it was cut before any
of it was built. A CA rating is a specific integer attributed to a real magazine
for a specific vitola in a specific issue, and a model asked for one returns a
*plausible* number with no signal that it invented it — the die-roll problem
from the WBPR desk, printed under somebody else's masthead. The prompt forbids
it in those terms, and says why, because "never give a score" alone invites a
model to comply with the letter of it.

What is left is what M3 is actually good for and is most of what makes filling a
form from a lookup worth doing: brand, line, vitola, dimensions, wrapper, binder,
filler, country, factory, strength and a flavour profile. Every field may come
back null, and the prompt says null is the right answer whenever it does not
specifically know — a field it omits is one you fill in, a field it guesses is a
wrong record you will not know to correct.

Range bounds do the rest, for free: no cigar is fourteen inches long or has a
ring gauge of 200, so a reply carrying one is wrong in a way that can be caught
without asking anybody. They are checked in `readLookup` and again as CHECK
constraints, the first as a courtesy and the second as the guarantee.

### Where a lookup shows up

Three places, and the separation between them is the point.

**The add form** carries the panel. It fills blank fields only, marks what it
filled until you touch it, and does not touch tasting notes — a profile "as
commonly described" is not your note, so copying it across is a separate press.

**The reference desk**, `/cigars/:workspace/lookup`, is the same endpoint with
nothing to fill: for checking a cigar you are not adding. A result becomes a
URL — `?reference=<id>` — so it can be kept or passed on, and starting an entry
from one carries only that id. The add page then reads the row and prefills
server-side, so what lands in the form is what the database holds rather than
whatever survived a query string.

**An entry** shows the row it was filled from, in a block that is deliberately
unlike the entry above it: bordered, left-aligned and mono-labelled, against a
centred serif masthead, so nobody reads the two as one document. It names the
model, the date and the words that were typed to get it.

That block is also where the two records are held against each other. Where the
entry and the lookup disagree on a field they both have an opinion about, both
are shown, yours first, and neither is changed — you had the cigar in front of
you and the model did not, so a difference is as likely to mean the lookup is
wrong. Fields blank on either side are absences rather than disagreements and
are not listed, or the two or three real ones would drown.

### The gate

`canWrite`, not owner-only — a departure from the WBPR desk and a deliberate
one. A night at the desk is an open-ended spend and the owner's bill; this is
one bounded call, and an editor who cannot use quick-add has been given a
feature that does not work for them.

The daily cap of 50 lookups per lounge is what makes the looser gate defensible,
and it is in the insert policy as well as in the route. The route's copy exists
to produce a sentence; the policy is what holds. Cache hits do not count against
it, because they do not insert.

The cap did not work as first written. It was a `count(*)` subquery inside the
policy over the very table the policy guards, which Postgres answers with
`42P17` — and not by leaking, but by refusing every insert, so nothing could
ever have been cached. It reads correctly, and it was asserted to work in three
places before anyone ran it. The fix is `app.cigar_lookups_today()`, a
`SECURITY DEFINER` helper alongside `app.can_write()` and the rest, because
stepping outside RLS is what lets a policy ask a question about its own table.
See `supabase/README.md` for that and for the second half of the same lesson,
which is that `GRANT select, insert` withholds nothing.

Token counts are columns on the row, as they are on `wbpr_agent_sessions`, and
for the same reason.

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
  The same mistake reached the dashboard's invitations, from both directions at
  once. `invites_read` is `platform admin OR owner of the workspace OR
  addressed to me`, and the middle clause is what the settings page runs on, so
  the dashboard was showing owners the invitations they had *sent* — described
  as received, with an Accept button `accept_invite()` could only refuse.
  Meanwhile the project's name came through an embedded join, and
  `workspaces_read` excludes a private project until you are a member, which an
  invitee is not yet: an invitation into a private project arrived with no
  project attached at all.
- **A policy that is right for the table can still be wrong for the page.**
  Both of those are fixed by `my_pending_invites()` rather than by narrowing
  the policy, because the policy is not what is wrong — the settings page needs
  every clause of it. A `SECURITY DEFINER` function is the honest way to ask a
  question RLS cannot express: this one is scoped to `auth.users.email`, the
  same rule `accept_invite()` enforces, so the list and the button agree by
  construction. Everything shown can be accepted, and everything acceptable is
  shown.
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
