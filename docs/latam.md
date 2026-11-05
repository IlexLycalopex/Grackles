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
- Strava sync (step 3) and the trip panel (step 4).
