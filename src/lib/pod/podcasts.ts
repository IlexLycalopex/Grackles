import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';

type Db = SupabaseClient<Database>;
export type ListenRow = Database['public']['Views']['jp_listen_log']['Row'];
export type ShowSummary = Database['public']['Functions']['jp_show_summary']['Returns'][number];
export type MonthTotal = Database['public']['Functions']['jp_monthly']['Returns'][number];
export type TagTotal = Database['public']['Functions']['jp_tag_summary']['Returns'][number];
export type SyncRun = Database['public']['Tables']['jp_sync_runs']['Row'];
export type TagRule = Database['public']['Tables']['jp_tag_rules']['Row'];

/** The same rule as app.jp_tags_ok(), so the form answers before the database refuses. */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_TAGS = 20;

/**
 * "4h 20m", "42m", "913h". Hours alone past a hundred, because "913h 12m" is
 * precision nobody reads, and minutes alone under an hour.
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (h >= 100 || m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export type TagParse = { ok: true; tags: string[] } | { ok: false; error: string };

/**
 * A comma-separated list as somebody types it — "Argentina, latin america" —
 * into the stored form: lower case, spaces as hyphens, each once, in order.
 */
export function parseTags(input: string): TagParse {
  const tags: string[] = [];
  for (const piece of input.split(',')) {
    const tag = piece.trim().toLowerCase().replace(/\s+/g, '-');
    if (!tag) continue;
    if (!TAG_PATTERN.test(tag)) {
      return { ok: false, error: `"${piece.trim()}" is not a tag: letters, numbers and hyphens, up to 40.` };
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) return { ok: false, error: `Twenty tags at most; that was ${tags.length}.` };
  return { ok: true, tags };
}

/** A ?tag= value worth querying with, or null. */
export function tagParam(url: URL): string | null {
  const t = url.searchParams.get('tag');
  return t && TAG_PATTERN.test(t) ? t : null;
}

/** First of a month, as jp_monthly returns it. */
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;

/**
 * The last `n` months ending with the one `today` is in, oldest first, each
 * with its total — zero where nothing was heard, so a quiet month shows as a
 * gap rather than disappearing from the chart.
 */
export function lastMonths(totals: MonthTotal[], n: number, today = new Date()): MonthTotal[] {
  const byMonth = new Map(totals.map(t => [t.month.slice(0, 10), t]));
  const out: MonthTotal[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = monthKey(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1)));
    out.push(byMonth.get(key) ?? { month: key, seconds: 0, episodes: 0 });
  }
  return out;
}

export function monthLabel(month: string): string {
  return new Date(`${month.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
}

export function dayLabel(iso: string | null): string {
  if (!iso) return 'Before tracking';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/London',
  });
}

/** Monday of the week `today` is in, as YYYY-MM-DD, in London. */
export function weekStart(today = new Date()): string {
  const london = new Date(today.toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const back = (london.getDay() + 6) % 7;
  london.setDate(london.getDate() - back);
  return `${london.getFullYear()}-${String(london.getMonth() + 1).padStart(2, '0')}-${String(london.getDate()).padStart(2, '0')}`;
}

// ── Queries ──────────────────────────────────────────────────────────

export async function loadMonthly(db: Db, ws: string, tag: string | null): Promise<MonthTotal[]> {
  const { data } = await db.rpc('jp_monthly', { p_workspace: ws, p_tag: tag });
  return data ?? [];
}

export async function loadShows(db: Db, ws: string, tag: string | null): Promise<ShowSummary[]> {
  const { data } = await db.rpc('jp_show_summary', { p_workspace: ws, p_tag: tag });
  return (data ?? []).sort((a, b) => b.seconds - a.seconds || a.title.localeCompare(b.title));
}

export async function loadTags(db: Db, ws: string): Promise<TagTotal[]> {
  const { data } = await db.rpc('jp_tag_summary', { p_workspace: ws });
  return data ?? [];
}

export async function loadLastRun(db: Db, ws: string): Promise<SyncRun | null> {
  const { data } = await db
    .from('jp_sync_runs')
    .select('*')
    .eq('workspace_id', ws)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

/** Seconds added on or after a London date, optionally for one tag. */
export async function secondsSince(db: Db, ws: string, from: string, tag: string | null): Promise<number> {
  const { data } = await db.rpc('jp_seconds_since', { p_workspace: ws, p_from: from, p_tag: tag });
  return Number(data ?? 0);
}

export const PAGE_SIZE = 50;

export interface LogFilter {
  tag?: string | null;
  showId?: string | null;
  page?: number;
}

/** Episodes most recently heard first, the undated baseline last. */
export async function loadLog(db: Db, ws: string, f: LogFilter = {}): Promise<{ rows: ListenRow[]; more: boolean }> {
  const page = Math.max(0, f.page ?? 0);
  let q = db
    .from('jp_listen_log')
    .select('*')
    .eq('workspace_id', ws)
    .gt('counted_s', 0)
    .order('last_listened_at', { ascending: false, nullsFirst: false })
    .order('title')
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  if (f.tag) q = q.contains('all_tags', [f.tag]);
  if (f.showId) q = q.eq('show_id', f.showId);
  const { data } = await q;
  const rows = data ?? [];
  return { rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE };
}
