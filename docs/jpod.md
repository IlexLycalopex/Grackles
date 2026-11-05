# JPOD — the podcast log

JPOD records podcast listening from Pocket Casts: what was heard, when, and how
long it took. It is the first of the trackers that feed the LatAm project, and
its tags are how that project gets its own totals (`/pod/jamie?tag=argentina`).

JPOD is a working name. The app is stored as `podcasts` and routed at `/pod`;
renaming it is the `name` field in `src/lib/apps.ts` and nothing else.

## Where listening comes from

Two sources, one door. Both end in `jp_ingest()`, which is the only way a
show, an episode or a play gets into the database.

| | Source | Reach | Dates |
|---|---|---|---|
| **History import** | The Android app's *Export database* (Profile › Help & Feedback › ⋮) | Everything the phone has, back to October 2019 | Real, from `last_playback_interaction_date` |
| **Daily sync** | `POST api.pocketcasts.com/user/history`, the web player's own endpoint | The latest 100 episodes | None given: time is dated the day the sync saw it |

The web endpoint is undocumented. It is what the Pocket Casts web player calls
and what the community has reverse-engineered, so it can change without notice.
When it does, the sync fails loudly: the run is written to `jp_sync_runs` with
its reason, and the JPOD front page shows the last run's result.

### Why time is stored twice

Pocket Casts keeps one position per episode and nothing else. `jp_episodes`
holds that state; `jp_plays` holds the time each sync *added* to it, dated the
day it was seen. "This week" is then a sum, and a relisten or a scrub
backwards credits nothing. `jp_episodes.counted_s` is the running total that
makes the difference computable.

### The undated baseline

On 10, 11 and 17 October 2019 the app marked about 2,500 episodes played at
once: the library being set up, not listening. The import detects these by
count (any London day with more than 20 last-played stamps) and keeps them as
`baseline` episodes whose play has no date. They count towards show totals and
"all time", and towards nothing with a date on it.

## Tags

A tag is a lowercase word or hyphenated phrase. Three sources, never merged in
storage:

- **Show tags** (`jp_shows.tags`), set on a show's page. Every episode of the
  show carries them. *The Argentina Brief* → `argentina`.
- **Episode tags** (`jp_episodes.tags`). In the schema and the grants; no page
  sets them yet.
- **Keyword rules** (`jp_tag_rules`), a tag and a case-insensitive pattern
  matched against the episode title and its show's title. Adding or removing a
  rule rewrites `auto_tags` across all history at once. This is how the four
  episodes of *Real Dictators* on Videla count as Argentina without the rest of
  the show.

`jp_listen_log` is where the three meet, as `all_tags`.

## Applying it

Nothing here touches production until it is applied in this order.

1. **Migrations** `20261105120000` and `20261105120100`. Additive; no existing
   table is changed. Verified locally against `tests/baseline.sql` plus every
   migration in order: `tests/jpod.sh` (30 checks), with `test.sh`,
   `settings.sh` and `admin.sh` unchanged.
2. **Create the project** at `/new` (JPOD, address `jamie`). Nothing is seeded.
3. **Import history.** Export the database from the phone, unzip it, then:

   ```sh
   node --experimental-strip-types scripts/jpod-import.ts <unzipped dir> jamie
   ```

   This writes `.jpod/import.sql` (git-ignored: a listening history is
   personal and the repository is public). Read it, then run it in the SQL
   editor. It is idempotent: a second run adds nothing.
4. **Deploy the function** `supabase/functions/jpod-sync` with JWT
   verification **off**, and set its secrets:

   ```sh
   supabase secrets set POCKETCASTS_EMAIL=… POCKETCASTS_PASSWORD=… \
     JPOD_WORKSPACE_ID=<the project's id> JPOD_SYNC_SECRET=<long random string>
   ```

   A Pocket Casts password used nowhere else keeps the blast radius small.
5. **Dry run.** `POST …/functions/v1/jpod-sync?dry=1` with the
   `x-jpod-secret` header. It fetches and maps without writing, and returns the
   raw `playingStatus` beside the mapped status for the first five episodes.
   Check the mapping (web: 1 unplayed, 2 in progress, 3 played) before
   trusting a schedule with it.
6. **Vault secrets**, in the SQL editor:

   ```sql
   select vault.create_secret('https://ophmsvqtzffrjmyjyzza.supabase.co/functions/v1/jpod-sync', 'jpod_sync_url');
   select vault.create_secret('<the same string as JPOD_SYNC_SECRET>', 'jpod_sync_secret');
   ```

7. **Schedule**: migration `20261105120200`, which installs `pg_cron` and
   `pg_net` and runs the sync at 04:47 UTC daily.
8. **Read it back**: the advisors, `cron.job_run_details` after the first
   morning, and `jp_sync_runs`.

## Not yet

- Episode-level tags have no page.
- No per-episode delete or edit: the source of truth is Pocket Casts.
- Manual capture (lessons, films, reading) is the LatAm project's, not JPOD's.
  See the architecture write-up for how the two meet.
