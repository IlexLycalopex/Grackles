/**
 * Pocket Casts, turned into the rows jp_ingest() takes.
 *
 * Shared by the daily sync (an Edge Function, under Deno) and the one-off
 * history import (a Node script reading the Android app's database export),
 * and tested from src/lib/pod/pocketcasts.test.ts. It therefore uses nothing
 * but the language: no Deno, no Node, no imports.
 *
 * The two sources number an episode's status differently, which is the whole
 * reason this file exists rather than two inline mappings:
 *
 *   Android database (podcast_episodes.playing_status): 0 unplayed, 1 in progress, 2 played
 *   Web API (/user/history, playingStatus):             1 unplayed, 2 in progress, 3 played
 *
 * The web numbering is the community's reverse-engineered reading, not a
 * published contract, so it is not trusted alone: an episode within the last
 * thirty seconds of its end is played whatever the number says, and the sync's
 * dry run (?dry=1) shows the raw values next to the mapped ones so the first
 * run can be checked by eye.
 */

export type Status = 'unplayed' | 'in_progress' | 'played';

export interface IngestRow {
  show_uuid: string;
  show_title: string;
  show_author: string;
  uuid: string;
  title: string;
  published_at: string | null;
  duration_s: number;
  position_s: number;
  status: Status;
  /** ISO timestamp. Set by the import only; the sync dates time by the day it ran. */
  listened_at?: string | null;
  baseline?: boolean;
}

/** Thirty seconds from the end is the end: outros, ads, a closing sting. */
const FINISHED_WITHIN_S = 30;

const whole = (n: unknown): number => {
  const v = typeof n === 'string' ? Number(n) : typeof n === 'number' ? n : NaN;
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
};

function nearlyFinished(position: number, duration: number): boolean {
  return duration > 0 && position > 0 && duration - position <= FINISHED_WITHIN_S;
}

export function statusFromWeb(code: unknown, position: number, duration: number): Status {
  if (nearlyFinished(position, duration)) return 'played';
  switch (Number(code)) {
    case 3:
      return 'played';
    case 2:
      return 'in_progress';
    default:
      return position > 0 ? 'in_progress' : 'unplayed';
  }
}

export function statusFromAndroid(code: unknown, position: number, duration: number): Status {
  if (nearlyFinished(position, duration)) return 'played';
  switch (Number(code)) {
    case 2:
      return 'played';
    case 1:
      return 'in_progress';
    default:
      return position > 0 ? 'in_progress' : 'unplayed';
  }
}

/** An ISO string, or null for anything that is not a real date. */
export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1990 ? null : d.toISOString();
}

/**
 * One episode from POST /user/history. Returns null for anything without the
 * two ids every row is keyed on — a malformed entry is skipped, not guessed at.
 */
export function normaliseWebEpisode(raw: Record<string, unknown>): IngestRow | null {
  const uuid = typeof raw.uuid === 'string' ? raw.uuid : '';
  const showUuid = typeof raw.podcastUuid === 'string' ? raw.podcastUuid : '';
  if (!uuid || !showUuid) return null;

  const duration = whole(raw.duration);
  const position = whole(raw.playedUpTo);

  return {
    show_uuid: showUuid,
    show_title: String(raw.podcastTitle ?? '').trim(),
    show_author: String(raw.author ?? '').trim(),
    uuid,
    title: String(raw.title ?? '').trim(),
    published_at: isoOrNull(raw.published),
    duration_s: duration,
    position_s: position,
    status: statusFromWeb(raw.playingStatus, position, duration),
  };
}

/**
 * The days the Android app marked whole libraries played at once. Found by
 * count rather than listed by date: any London day carrying more than this
 * many last-played stamps was a bulk action, not listening. Real days top out
 * near twenty; the October 2019 set-up days carry hundreds.
 */
export const BULK_DAY_THRESHOLD = 20;

export interface AndroidEpisode {
  uuid: string;
  podcast_id: string;
  podcast_title: string | null;
  podcast_author: string | null;
  title: string | null;
  published_date: number | string | null;
  duration: number | null;
  played_up_to: number | null;
  playing_status: number | null;
  last_playback_interaction_date: number | null;
}

/** The London calendar day of a millisecond timestamp, as YYYY-MM-DD. */
export function londonDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(ms));
}

/**
 * Rows from the Android export's podcast_episodes, joined to podcasts. Only
 * episodes with a last-played stamp are history; of those, the ones on a bulk
 * day become undated baseline rows.
 */
export function normaliseAndroidHistory(episodes: AndroidEpisode[]): IngestRow[] {
  const heard = episodes.filter(e => (e.last_playback_interaction_date ?? 0) > 0);

  const perDay = new Map<string, number>();
  for (const e of heard) {
    const day = londonDay(e.last_playback_interaction_date!);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  const rows: IngestRow[] = [];
  for (const e of heard) {
    const duration = whole(e.duration);
    const position = whole(e.played_up_to);
    const status = statusFromAndroid(e.playing_status, position, duration);
    // Opened and never played: history in the app's sense, not listening.
    if (status === 'unplayed') continue;

    const bulk = (perDay.get(londonDay(e.last_playback_interaction_date!)) ?? 0) > BULK_DAY_THRESHOLD;

    rows.push({
      show_uuid: e.podcast_id,
      show_title: (e.podcast_title ?? '').trim(),
      show_author: (e.podcast_author ?? '').trim(),
      uuid: e.uuid,
      title: (e.title ?? '').trim(),
      published_at: isoOrNull(e.published_date),
      duration_s: duration,
      position_s: position,
      status,
      listened_at: bulk ? null : isoOrNull(e.last_playback_interaction_date),
      baseline: bulk,
    });
  }
  return rows;
}
