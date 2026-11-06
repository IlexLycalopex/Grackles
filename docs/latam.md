# LatAm — the Argentina project

LatAm is where learning Argentina is counted: Spanish lessons, films, reading,
articles, mate, notes. It owns only what has no other home. Podcasts stay in
JPOD and books in the Reading List, and the LatAm overview reads both beside its
own entries by tag. Phase one is Argentina; the focus tag is a setting, so a
second country is a tag, not a rebuild.

The fuller design is the Claude Doc *LatAm Project: Architecture and Manual
Capture*.

## Capture

A phone posts JSON to `POST /api/latam/:workspace/capture` with
`Authorization: Bearer lx_…`, and gets one line of plain text back for a toast.
The route is thin: everything that decides anything is `lx_capture()`, a
definer function that finds the token by its SHA-256 digest, checks that its
owner can still write to the project, rate-limits it (120 an hour), validates
the entry and writes it. Anon can call it; the token is the check.

The route does one thing the database should not: a reading entry that arrives
with a link is fetched (four seconds, two megabytes, public hosts only) and
reduced to three facts by `src/lib/latam/page.ts`: article or book, title, word
count.

| Entry | What happens |
|---|---|
| Any | Tagged with the project's focus tag; `lesson` and `conversation` also get `spanish`, `fishing` gets `fishing` |
| Same `id` twice | One row; the second answers "Already logged" |
| `reading` with a title | Matched against the linked Reading List by trigram similarity, books being read first. ≥ 0.6 links it; 0.35–0.6 saves it with three candidates on **To check**; below that, saved as not found |
| `reading` with a link to an article | Becomes `article`, titled from the page; more than three times the page's reading time (200 words a minute) goes to **To check** |
| `reading` with a link to a book site | Matched by the page's title |

Nothing is refused for being doubtful. It is saved and checked by hand on the
overview, where each candidate is one press.

Tokens are made on `/latam/:workspace/setup`, shown once, and revocable there.

## Duolingo

Duolingo's daily history needs a signed-in session; its public profile does
not, and gives each course's lifetime XP and the streak. So
`supabase/functions/latam-duolingo-sync` reads the profile hourly (pg_cron,
`7 * * * *`) for every project whose setup names a username, and
`lx_duolingo_ingest()` keeps a snapshot and rewrites that day's `duolingo`
entry from the growth in **Spanish** XP, at three XP a minute, tagged
`spanish`. Other courses are ignored.

- No back history: the first check is a starting line. The overview shows
  lifetime Spanish XP and the streak instead.
- XP earned in the last hour before midnight can land on the next day.
- Each run is a row in `lx_sync_runs`; a failure shows on the overview.
- It shares JPOD's `JPOD_SYNC_SECRET`; its address is Vault's
  `latam_duolingo_sync_url`.

## Places and themes

`/latam/:workspace/places` and `/themes`. A place or theme is a tag: its page
counts and lists whatever carries its slug, in LatAm, JPOD (by
`jp_seconds_since`) and the linked Reading List (`rl_library.tags`). Nothing
is copied. `lx_seed_argentina()` loads a starter set (61 places across seven
regions, ten themes with reading lists) and is safe to run again; it only adds
what is missing.

**Deep dive** (`latam.research`, one metered MiniMax call through `withJob`):
the model writes a briefing (overview, history, culture, what to notice, local
words, fishing) and proposes books, films and articles. `lib/latam/research.ts`
keeps a book only if OpenLibrary has that title by that author, and a film or
article only if English Wikipedia has the page (a film's page must describe a
film). The rest are dropped and counted. Only the place's name, kind and
province are sent (`sends_records = false`). Results are kept in
`lx_research`, never overwritten; a suggestion becomes an `lx_items` row when
kept, and a book can go straight to the Reading List as *wanted*, tagged with
the place.

Grounding: before the call, the app finds the place's English Wikipedia
article by search (it must mention Argentina) and sends up to 7,000
characters of it; the model writes from that, at temperature 0.2. Text in any
non-Latin script is stripped, and a local word containing any is dropped whole.
A film or article page Wikipedia reached by redirect to another subject is
rejected. Proposals no catalogue found are listed on the page.

## Instapaper

With `INSTAPAPER_USERNAME` and `INSTAPAPER_PASSWORD` set on the Vercel
project, an article kept from a deep dive is also saved to Instapaper (Simple
API), and listed articles get an Instapaper button. Owner only.

## Applying it

1. `20261105150000_latam_app_slug`, then `20261105150100_latam_schema`.
   Additive; it installs `pg_trgm` in `extensions`. Verified locally:
   `tests/latam.sh` (23 checks), with `jpod.sh`, `test.sh` and `settings.sh`
   unchanged.
2. Create the project, then link its Reading List and JPOD on the setup page.
3. Make a token for the phone and follow the HTTP Shortcuts steps on that page.

Books are tagged with the Reading List's own `tags` field on each library
entry, which already exists; LatAm reads it.

## Not yet

- The overview does not yet count books or reading time from the Reading List
  beyond what is logged here.
- Strava sync, and trips (dates, stops, readiness against Spanish hours).
