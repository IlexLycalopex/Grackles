# Grackles

The front door at [grackles.co.uk](https://grackles.co.uk), and — as of this
branch — the app that the Listening Party, Reading List and Cedarhouse are
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
| ✅ | Album covers looked up on save — the build step the migration dropped, moved to the write |
| ✅ | AI governance — applied and live. See `docs/ai-architecture.md` and `supabase/README.md` |
| ✅ | The platform console at `/admin` — applied and live (same migrations) |
| ✅ | Ask the archive at `/search` — one question, across every project you can see |
| ⬜ | WBPR's map and veil pages — left behind in the migration, see below |
| ✅ | Custom SMTP — Supabase's own magic-link and confirmation emails go out through Resend, alongside the app's invitations |
| ✅ | DNS cutover — grackles.co.uk and www resolve to the Vercel project, and the GitHub Pages CNAME is gone |
| ✅ | Cedarhouse — the cigar lounge off Oxblood Foil and onto the shared paper tokens, with an editorial log page, facet chips and specimen plates |
| ✅ | Blackletter — the word game, at five, six and seven letters. Schema, dictionary and workspace are live on the project |
| ✅ | Cedarhouse's wishlist — a third cigar status, added straight from a lookup and moved off in one press. Migration applied 2026-08-17 |
| ✅ | The library — every book in one registry, read state derived from the reading list, the bookcase captured from photographs and deduplicated on the way in. **Applied 2026-09-01**: 265 readings became 260 books, 136 of them read |

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
/reading/:workspace/enrich         fill in missing details (editor+)

/cigars/:workspace                 Cedarhouse — the log
/cigars/:workspace/humidor         what is resting
/cigars/:workspace/wishlist        what is wanted, and the two moves off it
/cigars/:workspace/stats           ratings, brands, spend
/cigars/:workspace/cigar/:slug     one entry
/cigars/:workspace/new             add to the wishlist, the humidor or the log
/cigars/:workspace/edit/:slug      edit an entry
/cigars/:workspace/smoke/:slug     take one out of the humidor or off the wishlist
/cigars/:workspace/lookup          the reference desk — what is this cigar? (editors only)
/api/cigars/:workspace/lookup      the same question as JSON (cache first, then the model)

/blackletter/:workspace            Blackletter — today's puzzle (?n=5, 6 or 7)
/api/blackletter/:workspace/guess  one guess, marked

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

/settings/ai                       what AI has cost you, and what it was worth
/admin                             the platform console (platform admins; 404 otherwise)
/admin/ai                          AI controls (platform admins; 404 otherwise)
/api/ai/cancel                     stop a job
/api/ai/decide                     accept or discard a proposal
/api/ai/job/tick                   run one slice of a batch
/api/reading/:workspace/enrich     start an enrichment run
/api/ai/golden/curate              freeze a sitting as a golden case (admins)
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

## Filling a book in

Every cover on this list arrived with the migration. The old repo ran
`scripts/fetch-metadata.js` on every deploy: it swept the YAML for
`cover_url: ""`, asked Open Library and then Google Books, and committed what
came back. Nothing replaced it when the list moved here, so every book imported
has a cover and every book added since has a placeholder — which is how the gap
was noticed.

`lib/book-lookup.ts` is that script's knowledge moved to where a book is
actually entered — the same move `lib/artwork.ts` makes for a week's pick, and
for the same reason. `src/lib/book-lookup.test.mjs` pins it against fixture
responses (`node --experimental-strip-types src/lib/book-lookup.test.mjs`),
stubbing `fetch`; it never asks the real endpoints. **Fetch details** on the book form fills in whatever is still
blank — cover, ISBN, publisher, pages, genre, year, Open Library link — from the
title and author, or from an ISBN if there is one.

The setting changed, so two things about it did. A deploy hook sweeping a year
can afford half a second between calls and three retries; a person waiting on a
button cannot, so this makes at most two requests and gives up after six
seconds. And a sweep has to be right unattended, while this puts the values in
front of somebody before anything is written — which is the honest arrangement,
because these APIs index *works* and a work has many editions.

What was worth carrying across, all of it learned the hard way by the script
that ran first:

- **Ask for five results and prefer one that has a cover.** The first hit for a
  title is regularly a reprint or a study guide with no artwork.
- **Drop the volume number.** "Chew Vol 9 Chicken Tenders" is indexed as "Chew
  Chicken Tenders", and this list has a lot of graphic novels.
- **Use the first author only.** A joint credit — "A & B", "A and B", "A; B" —
  matches nothing as written.
- **Build the cover from the cover id, never from the ISBN.** The ISBN route
  answers with a *blank image* rather than a 404 unless told otherwise, which
  lands in the column as a cover that is not there. A cover id only exists when
  the picture does.
- **Fall back to Google Books, and only for a cover.** It is the one thing it is
  reliably better at, and it is why a few covers on this list are served by
  Google. `GOOGLE_BOOKS_API_KEY` is optional: the old script needed it because it
  swept every book on every deploy from a shared CI runner, and this asks once
  per button press.
- **Upgrade Google's thumbnail to https.** It still hands them out as `http://`,
  which a browser blocks as mixed content — a cover that silently fails to load.

Two rules hold the button together. **It only fills blanks**, so it is safe to
press twice and safe on a book that already exists — it tops up what is missing
rather than replacing the record with a stranger's idea of it. And **nothing is
written to the database**: a lookup edits the submitted `FormData` and
re-renders, arriving through the same door a rejected save does, and Save is
still a separate press.

Nobody has to press it, though, and a book saved without pressing it would land
with a placeholder and no way to notice — the original complaint, back again. So
`fillCover()` runs the same lookup on the save itself, exactly as `fillArtwork()`
does for a week's pick. That path carries two more rules, both borrowed from
there: **a lookup never fails a save**, and **a wrong cover is worse than none**
— nobody is reviewing that one, so the title that comes back has to look like the
title that was asked for. The button skips that check on purpose, because there a
person is looking at the result. Clearing a cover field is how a bad match gets
asked again.

The matcher those checks run on is `lib/title-match.ts`, shared with the artwork
lookup rather than copied into both — same reason as `json.ts`.

`description` is deliberately not fetched. The column exists and holds what the
old script put there, but nothing in this app renders it — filling it would add
another field that feeds nothing, which is the problem the target had.

## The library

Everything above this section is about *readings*. A row in `rl_books` is a
year, a position in it and a set of dates — the right shape for a log and the
wrong one for the several hundred books somebody owns and has not read yet,
which have no year, no position and no dates. That absence is exactly what
makes them the interesting ones.

So there is a second table, and one rule:

> **Every book exists in `rl_library`, always. Readings are drawn from it.**

`rl_books.library_id` is `not null`, there is no path that creates a reading
without a book, and the library is therefore a complete account of every book
this project has ever known about — read, unread, owned, borrowed, wanted or
gone.

Three things follow, and they are the point of the whole exercise. A re-read is
two log rows and one library row, so *Piranesi* read in 2021 and again in 2024
is one book read twice. Read and unread become properties of a book rather than
facts about a query. And the log goes on recording what you *read* — the 2019
reading keeps saying it was a battered Penguin paperback after the copy on the
shelf becomes a hardback — while the library records what you *have*.

### What counts as the same book

One fold, and four rules on top of it, because "is this the same book as that
one" is asked by four things: the unique index that makes one-row-per-book a
property of the database rather than a promise, the import's verdicts, the "you
already own this" warning in a bookshop, and the backfill.

    work_key = fold(title) [+ '#' + volume] + '|' + surname + first initial

**ISBN is not the key.** An ISBN identifies an edition, so the Penguin
paperback and the Everyman hardback would be two rows — which is exactly the
duplication being removed. It is stored, it is used to *find* a book, and it
never decides identity.

**The volume number stays in the key**, even though `cleanTitle()` in
`book-lookup.ts` strips it for lookups. That function is right: neither
catalogue indexes a graphic novel under its volume number. Folding it away here
would collapse an entire run of a series into one row.

**The author folds to a surname and a first initial**, so "Le Guin, Ursula K.",
"Ursula K. Le Guin" and "Ursula Le Guin" are one author, and "S. Clarke" and
"Susanna Clarke" are one person.

**The leading article is kept.** "The Trial" and "Trial" stay two keys. That is
the wrong way round for tidiness and the right way round for safety: a missed
merge is a visible duplicate on the library page, and a wrong merge is a book
that has quietly become a different book. The near-miss is caught by the
ambiguity check instead, where a person decides.

The fold exists twice — `app.rl_work_key()` and `workKey()` in `lib/library.ts`
— because the database has to be the authority and the application has to be
able to propose matches before writing. Both read
`supabase/tests/fixtures/work-keys.json`, so neither can be improved without the
other going red. The SQL accent map is generated from JavaScript's own NFD
rather than typed, after a hand-written one silently turned Susanna into
Cusanna: `translate()` maps position by position, and a stray ASCII letter in
the left-hand string is invisible.

### Read, and read anyway

A book is read when a reading of it finished. `date_finished is not null` is
already this app's own definition — `records/book.ts` refuses a book marked
`reading` that also carries a finish date on exactly that ground — so this is
lifted one level up rather than invented.

Five columns on `rl_library`, all maintained by one trigger: `times_read`,
`last_read_on`, `reading`, `read_override`, and `read`, which is
`coalesce(read_override, times_read > 0)`.

`read` is a maintained column and not a view, for three reasons of which the
third decides it: it is the primary filter on the library page, so it wants an
index; it is the column the archive search needs, and `runPlan` builds `.eq()`
against a real table; and **a book read before this app existed has no reading
to derive from**, so the value has to be writable.

Which makes the override half the feature rather than an escape hatch. The
reading list starts in a particular year; everything read before that is unread
as far as the log knows and read as far as you know. Setting it never touches
the log — `times_read` stays 0 and `last_read_on` stays null on a book read in
2003 and never recorded, which is honest: we know it was read, we do not know
when.

A reading with no finish date does *not* make a book read. Abandoned, still
going and finished-but-undated all look the same from here, and the first two
must not be counted. The third is what the override is for.

The trigger recounts the entry a reading came *from* as well as the one it went
to. Recounting only the new one is the obvious implementation, and the symptom
is a book that stays read after its only reading was moved away — quiet, wrong,
and invisible until somebody notices the unread shelf is short. There is a test
for exactly that.

### Ownership is a second axis

Once every book has an entry, "in the library" stops meaning "on the bookcase".
`ownership` is `owned`, `wanted`, `released` or `none` — four values rather than
a boolean because a released book must not be rediscovered as new by next year's
import, and a book never owned should not appear in *what happened to my copy*.

The two axes give four quadrants and each is a real page. Owned and unread is
the pile, and the default view.

### Importing a bookcase

Photographs go through OCR somewhere else and come back as a file.
`/reading/:workspace/import` takes a CSV, a TSV, JSON or JSONL, sniffs the
shape, and requires only a `title` column. Every other column is read under
whatever it is called, and **anything unrecognised is kept and shown rather than
dropped** — the file came from photographs that may not be taken again, and the
first real export is what tells you which alias to add.

Nothing lands in the library until a person has looked at it. Each row gets a
verdict:

| Verdict | Default |
| --- | --- |
| `new` — not in the library | add |
| `known` — already there | **confirm** |
| `ambiguous` — close, but not the same | none; a person decides |
| `duplicate_in_batch` — the same book earlier in the file | skip |
| `unreadable` — no title | skip |

`known` is the majority verdict and its default is the thing that makes this
import worth having. After the backfill every book ever read has an entry, so a
first import of a mostly-read bookcase matches almost everything — and each
match is *evidence of ownership*, which is a fact the library did not have.
Confirming sets `ownership` and attaches the photograph and **touches nothing
else**: not the title, not the genre, not the read state, nothing anybody has
edited. An import is allowed to say *this is on the bookcase*, and that is all.

Applying is one transaction. If two rows turn out to be the same book, nothing
at all is written and the review says which row — that is the two folds
disagreeing, and it is better caught than half-applied.

The photographs know what is on the bookcase; they do not know what you have
read. Three sources decide, in order: the log for rows already known, a `read`
column in the file if the extraction produced one, and a switch at the top of
the review. A row marked read gets an **override, never a fabricated reading** —
inventing one would file hundreds of books into years they were not read in and
break every count on the site.

### The backfill

`library_id not null` cannot be declared on a table whose every row violates it,
so one migration mints an entry per distinct work across the whole existing log,
links every reading, lets the read trigger fill in, and only then adds the
constraint. Until that last line a bug in the fold is a row to fix; after it, it
is a migration that will not apply.

`app.rl_backfill_report()` and `public.rl_near_duplicates()` live in the
*previous* migration, which is not a filing detail: a report you can only run
after the transformation it describes has happened is not a dry run.

Near-duplicates are surfaced and never merged. The backfill is the first moment
the whole reading history is visible as one set of works, so it is the first
moment a real duplicate can be seen — and the worst possible moment to act on
one automatically, having just met it.

### Searching, and the one press

Four surfaces, and the first three cost nothing.

**The library page** puts read/unread first, as three segments rather than a
facet in a panel, because in a library that is mostly read it is the only
question anybody arrives with. Filtering is a pass over what the page already
holds. A cover-wall toggle, because a wall is the only view of eight hundred
books a person can actually scan — and a missing cover is the visible signal
that enrichment failed on that row.

**The picker** on `/reading/:workspace/book/new` is now the only way onto a
year. Type three letters, see your own books, press one. Typing a title you
already own by hand joins that book rather than making a second copy, because
the fold decides and not the form. A book you have read already says so on the
row, so a re-read is a decision rather than a surprise.

**Add to the year**, from the library, in one press — which is what the
planning year has wanted since it was built.

**Ask the archive** gained a `library` source. `read` being a real column is
what reduces "which unread science fiction do I own" to one filter.

### Looking a book up

Four stages, cheapest first, stopping at the first that answers: your own
library, the shared cache, OpenLibrary and Google Books, then one call to M3.
Only the last spends anything, and it is a button that says so — never a
keystroke.

Stage zero never reaches the server, and on the stated problem it is the most
useful thing here: standing in a bookshop, the page answers *do I already own
this, and have I read it* from the library it already holds.

When the model is reached, the rule is narrower than the cigar desk's, because a
book makes the difference obvious — a cigar's dimensions are not in a free
catalogue and a book's are:

> **The model's answer is a better query, not a better record.**

It is asked which book is meant. The app then asks OpenLibrary again with that
answer, and every fact on the row comes from the catalogue.

#### What it is not asked for

**Never an ISBN.** M3 will produce a well-formed, checksum-valid, entirely
fictional one with no signal that it did, and that number would be written into
a field that looks authoritative, used to search a catalogue, and possibly typed
into a shop. The parser drops one if it arrives, there is no column for it to
land in, and a smuggled field fails the validator — so a prompt being ignored is
visible rather than merely harmless.

**Never a rating, a prize, a shortlisting, a sales figure or an attributed
opinion.** This is the argument that dropped the Cigar Aficionado score, in a
genre where it is worse: "shortlisted for the Booker in 2019" is a fabricated
citation to a real institution.

**Never a page count or a publisher.** The catalogue supplies those and is right
about them. If both catalogues miss entirely, the title and author are kept and
every other field stays blank rather than being invented.

Null is a correct answer and the prompt says so.

#### What it costs

Roughly 350 prompt tokens and 90 completion for an uncached lookup — under a
twentieth of a penny — and most lookups never reach it. A cache hit inserts
nothing and so does not count against the daily cap of 50 per project, which is
the right incentive.

Barcode scanning was built before the model path was leaned on, because it makes
that path rare: an ISBN off the back of a book is an exact catalogue lookup, and
pointing a phone at it is faster than typing. `BarcodeDetector` is not
everywhere, so the button appears only where it exists.

The cap is a `SECURITY DEFINER` function from the start rather than a subquery
in the policy on the table it counts. That is the cigar cap's lesson applied
before rather than after — see below.

### Filling the library in

`reading.enrich` now runs against `rl_library` as well as `rl_books`, and that
cost one branch in `enrichOne` and one in the item runner. The job envelope, the
ledger, the validator, the proposal review and the tick loop are not
feature-specific, which is what made this the cheapest step in the whole build.
Registering a second feature instead would have been a migration, a second
prompt version history, and two places where the cost of filling a book in is
recorded.

The library is the default target, because that is where a thin book is: an
imported bookcase arrives as several hundred entries carrying a title and an
author, and it is the entry that wants a cover and a page count, not any one
reading of it. Asking for a year still means the readings in that year.

The vocabulary spans both tables. Reading only `rl_books` would let the model
mint "Sci-Fi" beside a library full of "Science Fiction", because the genres on
several hundred unread imports would be invisible to it.

At roughly $0.00035 a book, a library of 800 lands near **$0.28** — inside the
$5 monthly default. That is an estimate; the ledger replaces it with
measurements, which is the point of it.

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

That much is per-sitting, which is the right amount of machinery for one feature
and the wrong amount for two. `docs/ai-architecture.md` specifies what replaces
it: a metered path to the model, per-person allowances in the shape `app_grants`
already uses, a spend ledger both the payer and the actor can read, and a
platform admin who can turn a feature — or all of them — off without a deploy.

The unit it governs is a *job* rather than a call, and every call belongs to one
even when there is only ever going to be a single call. A sitting at the desk is
already a job in everything but name; enriching a year of books is four hundred
calls that would each pass a per-call check on the way to spending a month's
allowance. One envelope, one call ceiling, one thing to cancel.

All of that is now built — `supabase/migrations/20260814*`, `src/lib/ai/`,
`/settings/ai` for a person, `/admin/ai` for the platform, and a panel on each
project's settings page. The migrations are applied: the prices in `ai_models`
were checked against MiniMax's published rates before they were, because every
limit downstream is computed from them and a wrong one does not fail loudly.

It also specifies the half that is not about money. The rules in the desk's
system prompt — never name a track, never invent a card — are checkable against
state this app is already holding, and checking them turns "the model
misbehaved" into a number that can regress. Whether a proposal was accepted,
edited or thrown away is the other free measurement, and cost per accepted
answer is the figure that decides whether a feature earns its tokens. None of it
is built.

## The platform console

`/admin` is the page for whoever runs the site rather than whoever owns a
project. It answers two questions nothing else did: what exists here, and what
has been granted to whom.

Every read goes through a `SECURITY DEFINER` function gated on
`app.is_platform_admin()`, never a widened policy. `workspaces_read` hiding a
private project from an admin who is not a member is *correct* for every other
page on this site; the console needs a different question asked by somebody
entitled to ask it, and that is what those functions are. The same reasoning as
`my_pending_invites()`, one privilege level up.

**It shows metadata and counts, never contents.** An admin can see that a
private Cigar Lounge holds forty entries, who owns it and who may read it. They
cannot read the entries. Being able to administer a project is not the same as
being able to read it, and collapsing the two would make every private project
on the site private only by courtesy.

Two things it refuses to do, because both leave a state only the service-role
key can recover from: remove the last platform admin, and leave a project with
no owner.

The four facts that decide what somebody may do here — platform admin, what
they may create, what they may spend, what they belong to — live in four tables
and had never been visible together. Handing them out one screen at a time is
how somebody ends up with an AI allowance and nothing to spend it on.

## Filling in a book's details

`/reading/:workspace/enrich` is the first feature that runs as a *batch*, and it
is the shape the rest should follow.

**The facts are not the model's.** OpenLibrary supplies the page count, the year,
the ISBN and the cover; the model is handed up to three candidate editions and
asked two questions only — which of them is the book on your shelf, and where it
sits in the genres, publishers and tags *you already use*. It is told not to
repeat a fact back, and if it does anyway the validator rejects the whole answer
by comparing every factual field to the edition it picked. A model asked for an
ISBN returns a plausible one.

**Nothing is written.** A run produces `ai_proposals`, and the page is where a
person ticks what to keep. That is what makes a wrong answer a row somebody
declines rather than a shelf somebody has to repair — and it is also free
telemetry: accepted, accepted-after-editing, discarded and never-decided are
four different facts about whether the feature is worth its tokens.

**The vocabulary is read once per run, not once per book.** It is the same for
all four hundred, and it is what stops the model minting "Science Fiction",
"Sci-Fi" and "SF" across one afternoon.

Execution is a browser pump: the page posts to `/api/ai/job/tick` until the job
reports done. No queue, no worker service, no new dependency. Close the tab and
the job stops ticking, the reaper returns the envelope, and every book already
looked up stays looked up — each item is committed as it lands. When something
genuinely unattended needs running, a cron drain calls the same endpoint for the
same jobs with the same worker.

## Album covers

A pick's cover is `lp_selections.artwork_url`, and nothing about it changed in
the migration — which is exactly how it broke. In the old repo a build step ran
on every commit and filled the field in for any entry naming an album and an
artist without one: iTunes first, the album's Wikipedia article when iTunes had
nothing. That is where all 32 imported covers came from. The field came across,
the form's *"left blank, this is filled in automatically"* came across, and the
step did not, so the first week added here was completed with an empty field and
stayed that way. It was never the deploy that made it work; it was a build
running on every commit, and there are no commits any more.

`lib/artwork.ts` moves the lookup to the write. Both pick routes call
`fillArtwork()` on the parsed values, so a week gets a cover on whichever save
first gives it an album and an artist — usually the one that marks it completed.
Two properties are the whole design:

- **A lookup never fails a save.** Every path returns `''` — a timeout, a 500, a
  refused host, no convincing match — and the row is written either way. Clearing
  the field is still the retry, exactly as it was in the YAML.
- **A wrong cover is worse than none.** iTunes answers every query with
  *something*, so a result is only taken when the artist and the album both look
  like what was asked for, after edition suffixes and accents are normalised
  away. Wikipedia is only consulted through the link already on the pick —
  searching it by title would find an article for anything, and the wrong
  article has a picture too.

`src/lib/artwork.test.mjs` pins that matcher against fixture responses
(`node --experimental-strip-types src/lib/artwork.test.mjs`). It stubs `fetch`;
it is not a check that Apple still answers.

## Ask the archive

`/search` is one box over everything you are allowed to read, and the design is
a single sentence: **the model says how to look, and the app looks.**

A question goes out with a description of the columns — never a row — and a
*plan* comes back: a table, some comparisons, an ordering. The plan is checked
against an allowlist and then run through the caller's own Supabase client, so
`workspaces_read` decides what comes back exactly as it does on every other
page. Nothing is generated as SQL and nothing is interpolated into a query.

Three things follow, and they are the reasons for the shape rather than
consequences of it:

- **No row reaches the model**, so `platform.search` is registered as sending
  nothing and needs no project's consent. That is also why results are
  *rendered* rather than narrated. A second call summarising the rows would read
  better and be a worse feature: it would put every project behind a consent
  gate, double the cost, and introduce the one thing this design otherwise has
  none of — a model asserting something about your records that you then have to
  check.
- **A wrong plan cannot widen.** It carries no workspace and cannot name a
  person, so the worst it can do is show you your own rows in a strange order.
- **A plan is a pure function of the question**, so it is cached. Asking the
  same thing twice costs once.

A plan that names a column which does not exist is refused whole rather than
repaired. A repaired plan answers a different question silently, and the results
look right, which is the worst way to be wrong. The plan is printed above the
results for the same reason: you can see that "unfinished" became
`date_finished is null`, and disagree.

It is also the first feature that is not a project's. Every other one acts on a
project's behalf and is billed to that project's owner; a sitewide question is
the asker's, and billing it to whichever project happened to be named would put
one owner on the hook for a search that ranged across nine. So a feature now has
a *scope*, and a platform-scope job carries no workspace, bills the actor, and
keeps every control that is not per-project — the master switch, admissions, the
rate limit, the breaker, the quality floor and the person's own allowance. It
may not send records, and that is a check constraint rather than a note.

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

Four places, and the separation between them is the point.

**The add form** carries the panel. It fills blank fields only, marks what it
filled until you touch it, and does not touch tasting notes — a profile "as
commonly described" is not your note, so copying it across is a separate press.

**The reference desk**, `/cigars/:workspace/lookup`, is the same endpoint with
nothing to fill: for checking a cigar you are not adding. A result becomes a
URL — `?reference=<id>` — so it can be kept or passed on, and starting an entry
from one carries only that id. The add page then reads the row and prefills
server-side, so what lands in the form is what the database holds rather than
whatever survived a query string.

**The wishlist** carries the same panel as the desk, and one more button under
the result: *add to the wishlist*. There is no form in between, and that is the
whole feature — see below.

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

## The wishlist

Cedarhouse recorded two things about a cigar — that it was resting, and that it
had been smoked — and the interesting third one happens before either: you read
about one, or somebody hands you a band, and you mean to find it. That was going
in a note somewhere outside the app, which is where it stopped being connected
to anything.

**A wishlist entry is a `cl_cigars` row with a third status.** Not a
`cl_wishlist` table, and the argument is not economy of tables. The thing being
recorded is a cigar — brand, vitola, wrapper, dimensions, the reference row a
lookup filled it from — and every one of those columns already exists. A
separate table would have been that column list twice, a second set of policies,
and a copy step on the one operation the whole feature exists for.

What the third status buys is that **moving is not copying**. "I have it now" is
an UPDATE of one column on one row; the entry keeps its id, its URL, its photo,
its notes and the lookup it came from, because none of them ever went anywhere.
A link somebody sent to a wishlist entry still resolves after it moves into the
humidor and again after it is smoked, and it is the same record throughout —
which is true of the humidor-to-log move too, and was the reason
`smoke_from_humidor` converts the last one in place rather than replacing it.

The cost is the honest one to state: `status` is read in a dozen places that
assumed it had two values. Every one of those was already a filter — the log and
the humidor have always been the same table — so it is a third filter rather
than a new concept, but the filters had to be found. The two that mattered were
not filters at all and are written up in `supabase/README.md`: a CHECK
constraint phrased as *the humidor has no smoked date*, which quietly stopped
covering the table the moment there was a status that was neither, and
`smoke_from_humidor`'s guard, which refused everything that was not in the
humidor with the message "that cigar has already been smoked".

### Getting one on, and getting it off

**On, in one press.** The reference desk and the wishlist page both carry the
lookup panel, and a result on either offers *add to the wishlist* as a button
rather than a link to a form. Adding to the humidor asks for a date, a quantity
and a price because those are facts you have at the till; wanting a cigar has no
facts attached beyond its name, so a form in the way would be a page that exists
to be submitted. Only the reference id is posted, and the row is read
server-side, so what gets written is what the database holds rather than what
survived a query string. Adding by hand is still there for a cigar that no
lookup finds.

**Off, in one press or one form.** *To humidor* is the one-column update, dated
today. *Smoke* is the form that already existed, because that move has facts
worth asking for — the date, where you were, a rating — and it is the same page
whether the cigar came off the wishlist or out of the humidor. You can want a
cigar, get hold of it and smoke it the same evening, and being made to file it in
the humidor first so you can immediately take it out again is exactly the
bookkeeping this app exists to end.

Both moves are offered on the card and on the entry page, so somebody who
followed a link to the record itself is not sent back to a list to press them.
The one-press move is a form rather than a link because it is a write; a `GET`
that changes the database is one prefetch away from a wishlist that empties
itself.

### What it does not do

No price alerts, no stock checking, no notifications — nothing that would need
this app to know about the world outside it. The one number it does show is what
the wishlist would cost, summed from the prices noted on the entries, and it is
the same `price_text` column doing the honest thing in both states: what it
sells for while you want it, what you paid once you have it.

A wishlist entry is excluded from every figure on the stats page except its own
count. Ratings, spend, brand counts and the rest are about cigars that exist in
your hands, and a want counted among them would be an average of things that
happened and things that did not. The count appears only once there is one to
count: a permanent zero beside three real figures reads as a feature nobody
uses rather than as a wishlist nobody has started.

## One write that is not a statement

Taking a cigar out of the humidor is the one write that is not a single
statement: smoking one of three has to add a log entry *and* leave two behind.
It is a database function (`smoke_from_humidor`) so the two cannot come apart,
`SECURITY INVOKER` so RLS still decides, and it converts the last one in place
rather than replacing it — the entry keeps its id and its URL.

Those two paths are not symmetric, and that asymmetry cost a photograph. The
in-place conversion is an `UPDATE` that names only the columns a smoke changes,
so everything describing the *cigar* — its picture, its dimensions, the
reference it was filled from — survives without anyone deciding it should.
Splitting one off a stack is an `INSERT` into a new row, and there every one of
those columns has to be named or it silently takes the column default.
`photo_path` and `reference_id` were not named, so a cigar smoked off a stack
of two produced a log entry with no image while the one left in the humidor
kept its own. `20260809120000_smoke_carries_photo` names them, and backfills the
entries the old version wrote.

The general shape is worth keeping in mind before adding a column to
`cl_cigars`: nothing fails when this list falls behind the table. Ask whether
the new column describes the cigar or the occasion. If it describes the cigar,
it belongs in the insert.

## Blackletter

The fifth app, and the first that is not a record-keeping app. There are no
forms, nothing to create or edit, and none of `lib/forms.ts`, `lib/records/` or
`ConfirmDelete` is involved. What there is instead is a secret, and that turns
out to change nearly every decision.

**The answer never leaves the database.** `bl_puzzles` holds it and carries no
grant to `anon` or `authenticated` — RLS enabled with no policy, and the DML
privileges revoked, so there are two independent refusals before a row could be
reached. `bl_words` is the same. Everything a player may know comes back from
four `SECURITY DEFINER` functions that do their own `app.can_read()` check,
which is `app.cigar_lookups_today()` again: stepping outside RLS is what lets a
function answer a question about a table nobody may read.

The spec this was built from assumed a static site — word lists in the bundle,
the answer derived in the browser from a day-index, `localStorage` for state.
That is the right design for a static host and the wrong one here, for a reason
that has nothing to do with security theatre: **the workspace is the point.**
The reason to put a word game on Grackles rather than on GitHub Pages is that
the people you compare grids with are already a project, and a scoreboard is
only worth looking at if the answer was actually hidden.

**Guessing is a function, not an insert.** Six attempts, one puzzle a day, a
real word, nothing after you have won — a client asked to enforce those on
itself is a client that can decline to. `blackletter_guess()` is the only way a
row reaches `bl_games`. The API route under `/api/blackletter/` adds one thing
only: a SQLSTATE turned into a sentence, the same division `lib/records/save.ts`
draws.

**A member may not read another member's game.** This is the first table here
where that is true — everywhere else membership *is* readability. A finished
game's `guesses` contain the answer, so the policy is own-rows-only and the
scoreboard is a function returning marks and never guesses. A row of squares
says how well a guess went without saying what it was, which is the same
asymmetry that makes a shared grid spoiler-free.

**Three lengths, not three apps.** Five, six and seven are one page in three
states at `?n=`, one row per length per day in `bl_puzzles`, and separate
streaks — folding them together would mean missing one day of sevens breaking
your five-letter run. `attempts` is a column on the puzzle rather than a
constant, so tuning it later cannot retroactively rewrite how hard a finished
game was.

**The schedule is a table, not arithmetic.** The spec derived the answer as
`dayIndex % solutions.length`, which needs the list order frozen for all time or
every player's history breaks. A row is written once on first demand and is then
true regardless, so the word list can be reordered, extended, or have a word
withdrawn without moving anyone's history. It also fixes something the modulo
gets wrong on its own: consecutive days over a sorted list hand out words
sharing a prefix.

Two things about the word lists are worth knowing before touching them. They are
generated by `supabase/seed/build-blackletter-words.py` and the output is
committed, because the spot-check for obscure and offensive entries is a code
review and a list nobody can diff is a list nobody has read. And ENABLE is an
American list while this is a British site, which is two different faults:
SOMBER as an *answer* reads as a misspelling, and SOMBRE as a *guess* was not in
the list at all. Both spellings are guessable; only the British one can be the
answer.

### What is live

All three migrations are applied to `ophmsvqtzffrjmyjyzza`, `bl_words` holds all
46,989 words, and the workspace exists at `/blackletter/words`, private, owned by
Jamie. Today's puzzles are minted at all three lengths.

The enum migration went out on its own, and has to: `ALTER TYPE ... ADD VALUE`
cannot be used in the transaction that uses the value.

Loading the dictionary was the awkward part and is worth writing down in case it
is ever done again. There is no direct Postgres route into the project from the
environment the migrations were run from, and 47,000 words is too much to push
through a management API by hand. What worked was to install `http` into the
`extensions` schema, have Postgres itself fetch the generated seed from a
**pinned commit SHA** of this repo, parse the word literals out of it in SQL, and
then drop the extension again. Outbound HTTP from the database is not a
capability this project should keep standing.

Two things about that parse, both learned the hard way. Postgres's regex engine
decides greediness per *branch* rather than per quantifier, so a non-greedy
`(.*?)` sitting next to a greedy `(\d+)` is not non-greedy at all — the first
attempt swallowed all six sections into one. And every section in the generated
file announces its own size, which is what made it possible to prove the parse
was right rather than assume it: a regex that quietly matched half a list would
otherwise have loaded a dictionary missing twenty thousand words, and nothing
would have looked wrong until somebody guessed one of them.

There is a spent `seed-blackletter` edge function on the project, stubbed out to
return 410 and behind JWT verification. It was an earlier attempt at the same
load, made unnecessary by the `http` route; the management API has no delete, so
it wants removing from the dashboard.

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
│   └── cigars/              Cedarhouse (the cigar lounge)
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
