import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { weekStart } from '../pod/podcasts';

type Db = SupabaseClient<Database>;
export type Activity = Database['public']['Tables']['lx_activities']['Row'];
export type Settings = Database['public']['Tables']['lx_settings']['Row'];
export type Token = Database['public']['Tables']['lx_capture_tokens']['Row'];

export const ACTIVITY_TYPES = [
  'lesson',
  'film',
  'series',
  'reading',
  'article',
  'music',
  'mate',
  'conversation',
  'note',
  'practice',
  'fishing',
] as const;

export interface Candidate {
  id: string;
  title: string;
  author: string;
  score: number;
}

export function candidatesOf(a: Activity): Candidate[] {
  return Array.isArray(a.candidates) ? (a.candidates as unknown as Candidate[]) : [];
}

export async function loadSettings(db: Db, ws: string): Promise<Settings | null> {
  const { data } = await db.from('lx_settings').select('*').eq('workspace_id', ws).maybeSingle();
  return data;
}

export async function loadRecent(db: Db, ws: string, limit = 30): Promise<Activity[]> {
  const { data } = await db
    .from('lx_activities')
    .select('*')
    .eq('workspace_id', ws)
    .order('occurred_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function loadToCheck(db: Db, ws: string): Promise<Activity[]> {
  const { data } = await db
    .from('lx_activities')
    .select('*')
    .eq('workspace_id', ws)
    .eq('check_state', 'to_check')
    .order('created_at', { ascending: false });
  return data ?? [];
}

export interface Total {
  /** Minutes captured here. */
  latam: number;
  /** Minutes from JPOD, when one is linked and readable. */
  podcasts: number;
}

/**
 * Minutes for one tag since a day: LatAm's own entries plus a linked JPOD's
 * listening carrying the same tag. Each half goes through its own project's
 * RLS, so a JPOD the viewer cannot see adds nothing rather than failing.
 */
export async function totalSince(
  db: Db,
  ws: string,
  settings: Settings | null,
  tag: string,
  from: string
): Promise<Total> {
  const [{ data: rows }, pod] = await Promise.all([
    db.from('lx_activities').select('minutes').eq('workspace_id', ws).gte('occurred_on', from).contains('tags', [tag]),
    settings?.jpod_workspace_id
      ? db.rpc('jp_seconds_since', { p_workspace: settings.jpod_workspace_id, p_from: from, p_tag: tag })
      : Promise.resolve({ data: 0 }),
  ]);
  return {
    latam: (rows ?? []).reduce((s, r) => s + r.minutes, 0),
    podcasts: Math.round(Number(pod.data ?? 0) / 60),
  };
}

export function periodStarts(now = new Date()): { week: string; year: string } {
  const year = now.toLocaleString('en-GB', { year: 'numeric', timeZone: 'Europe/London' });
  return { week: weekStart(now), year: `${year}-01-01` };
}

/** "4h 20m", "45m", "0m" — minutes, as the toast says them. */
export function minutes(n: number): string {
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export interface DuolingoStatus {
  snapshot: { course_xp: number; streak: number; taken_at: string } | null;
  run: { ok: boolean | null; message: string; started_at: string } | null;
}

/** The latest Duolingo snapshot and sync run, for the line under the totals. */
export async function loadDuolingo(db: Db, ws: string): Promise<DuolingoStatus> {
  const [{ data: snap }, { data: run }] = await Promise.all([
    db.from('lx_duolingo_snapshots').select('course_xp, streak, taken_at').eq('workspace_id', ws)
      .order('taken_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('lx_sync_runs').select('ok, message, started_at').eq('workspace_id', ws).eq('source', 'duolingo')
      .order('started_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  return { snapshot: snap, run };
}
