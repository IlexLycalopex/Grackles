/**
 * JPOD's one-off history import: the Pocket Casts Android app's database export
 * turned into SQL that feeds jp_ingest().
 *
 *   node --experimental-strip-types scripts/jpod-import.ts <export dir> <workspace slug> [out.sql]
 *
 * <export dir> is the unzipped "Export database" file from Pocket Casts on
 * Android (Profile › Help & Feedback › ⋮ › Export database). It holds a SQLite
 * database named `pocketcasts` beside its -wal and -shm files, which must stay
 * together: the most recent listening may be in the WAL and not yet in the
 * main file.
 *
 * Writes SQL rather than calling the database, for two reasons. jp_ingest() is
 * the service role's alone, and a script holding that key is a script holding
 * the keys to everything. And the file can be read before it is run, which is
 * the point of an import that happens once.
 *
 * The export carries the whole library — subscriptions, playback settings, app
 * logs. Only the history leaves this script, and the output defaults to .jpod/,
 * which is git-ignored, because the repository is public and a listening
 * history is personal.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normaliseAndroidHistory, type AndroidEpisode } from '../supabase/functions/_shared/pocketcasts.ts';

const [dir, slug, out = join('.jpod', 'import.sql')] = process.argv.slice(2);
if (!dir || !slug || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
  console.error('usage: jpod-import.ts <export dir> <workspace slug> [out.sql]');
  process.exit(2);
}

const db = new DatabaseSync(join(dir, 'pocketcasts'), { readOnly: true });
const episodes = db
  .prepare(
    `select e.uuid, e.podcast_id, p.title as podcast_title, p.author as podcast_author,
            e.title, e.published_date, e.duration, e.played_up_to, e.playing_status,
            e.last_playback_interaction_date
       from podcast_episodes e
       left join podcasts p on p.uuid = e.podcast_id
      where e.last_playback_interaction_date > 0`
  )
  .all() as unknown as AndroidEpisode[];

const rows = normaliseAndroidHistory(episodes);

// jp_ingest takes an array; five hundred to a call keeps each statement small
// enough to read in an editor and to retry alone if one fails.
const CHUNK = 500;
const ws = `(select id from public.workspaces where app = 'podcasts' and slug = '${slug}')`;
const statements: string[] = [];
for (let i = 0; i < rows.length; i += CHUNK) {
  const json = JSON.stringify(rows.slice(i, i + CHUNK));
  if (json.includes('$jpod$')) throw new Error('an episode title contains the SQL quote marker');
  statements.push(`select public.jp_ingest(${ws}, $jpod$${json}$jpod$::jsonb, 'import');`);
}

const dated = rows.filter(r => !r.baseline);
const header = [
  `-- JPOD history import for /pod/${slug}, generated ${new Date().toISOString()}`,
  `-- ${rows.length} episodes: ${dated.length} with a listen date, ${rows.length - dated.length} undated baseline.`,
  `-- Idempotent: jp_ingest counts only time it has not counted before, so running`,
  `-- this twice adds nothing the second time.`,
  '',
];

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, [...header, ...statements, ''].join('\n'));

const days = dated.map(r => r.listened_at!).sort();
console.log(`${rows.length} episodes → ${out}`);
console.log(`  dated:    ${dated.length} (${days[0]?.slice(0, 10)} to ${days.at(-1)?.slice(0, 10)})`);
console.log(`  baseline: ${rows.length - dated.length}`);
