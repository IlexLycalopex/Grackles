import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

/**
 * Reading broadcasts.
 *
 * A broadcast is a night on air and the tables are shaped like one: four
 * blocks, each with the three cards drawn for it and what was played, plus a
 * phenomena log hanging off the broadcast itself. Nothing here decides who may
 * see it — the queries go through the caller's client and RLS answers that.
 */

export const CALLER_TYPES = ['none', 'standard', 'phenomenon', 'emergency'] as const;
export type CallerType = (typeof CALLER_TYPES)[number];

export const LOCATION_CONFIDENCE = ['precise', 'approximate', 'accent-only', 'unknown'] as const;
export type LocationConfidence = (typeof LOCATION_CONFIDENCE)[number];

export const PHENOMENON_STATUSES = [
  'New', 'Active', 'Stable', 'Escalating', 'Resolved', 'Dormant',
] as const;
export type PhenomenonStatus = (typeof PHENOMENON_STATUSES)[number];

export const CONFIDENCES = ['Unconfirmed', 'Likely', 'Confirmed'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/**
 * Veil readings as the archive already uses them. 'Normal' is in the list
 * because Session 1 is 'Normal' — the vocabulary drifted over nine broadcasts
 * and the column is deliberately unconstrained, so the select offers what has
 * actually been used rather than what a rulebook says.
 */
export const VEIL_STATUSES = ['Normal', 'Stable', 'Thin', 'Very Thin', 'Critical'] as const;

export interface Prompt {
  id: string;
  position: number;
  card: string;
  tone: string;
}

export interface Track {
  id: string;
  position: number;
  title: string;
  artist: string;
  url: string;
  source: string;
  notes: string;
}

export interface Block {
  id: string;
  position: number;
  time_label: string;
  caller_type: CallerType;
  caller_card: string;
  caller_card_meaning: string;
  caller_location: string;
  caller_lat: number | null;
  caller_lon: number | null;
  caller_location_confidence: LocationConfidence;
  phenomenon_ref: string;
  notes: string;
  prompts: Prompt[];
  tracks: Track[];
}

export interface Phenomenon {
  id: string;
  key: string;
  name: string;
  status: PhenomenonStatus;
  confidence: Confidence;
  locations: string[];
  lat: number | null;
  lon: number | null;
  notes: string;
  tags: string[];
}

export interface Broadcast {
  id: string;
  session: number;
  slug: string;
  station: string;
  call_sign: string;
  location: string;
  lat: number | null;
  lon: number | null;
  date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number | null;
  atmospheric_conditions: string;
  veil_status: string;
  veil_intensity: number | null;
  dawn_colour: string;
  veil_at_close: string;
  personal_notes: string;
  tags: string[];
  blocks: Block[];
  phenomena: Phenomenon[];
}

/** Everything about a broadcast except its blocks — enough for the archive. */
export type BroadcastSummary = Omit<Broadcast, 'blocks' | 'phenomena'> & {
  callers: number;
  block_count: number;
};

const BROADCAST_COLUMNS = `
  id, session, slug, station, call_sign, location, lat, lon, date, start_time,
  end_time, duration_minutes, atmospheric_conditions, veil_status, veil_intensity,
  dawn_colour, veil_at_close, personal_notes, tags
`;

/**
 * The archive, newest night first.
 *
 * Caller and block counts are derived from the blocks rather than stored on the
 * broadcast. The markdown carried a `callers:` number in its frontmatter and
 * that is exactly the kind of field that goes stale the first time somebody
 * corrects a die roll — the blocks are the record, so they are what is counted.
 */
export async function loadBroadcasts(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<BroadcastSummary[]> {
  const { data } = await supabase
    .from('wbpr_broadcasts')
    .select(`${BROADCAST_COLUMNS}, wbpr_blocks(caller_type)`)
    .eq('workspace_id', workspaceId)
    .order('session', { ascending: false });

  return (data ?? []).map(row => {
    const blocks = (row as { wbpr_blocks?: { caller_type: string }[] }).wbpr_blocks ?? [];
    const { wbpr_blocks: _ignored, ...rest } = row as Record<string, unknown>;
    return {
      ...(rest as Omit<Broadcast, 'blocks' | 'phenomena'>),
      block_count: blocks.length,
      callers: blocks.filter(b => b.caller_type !== 'none').length,
    };
  });
}

/**
 * One broadcast, whole.
 *
 * Ordering is applied to the embedded rows rather than sorted afterwards:
 * PostgREST returns nested rows in no defined order, and a playlist that comes
 * back shuffled is wrong in a way nobody notices until they read the archive.
 */
export async function loadBroadcast(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  slug: string
): Promise<Broadcast | null> {
  const { data } = await supabase
    .from('wbpr_broadcasts')
    .select(`
      ${BROADCAST_COLUMNS},
      wbpr_blocks(
        id, position, time_label, caller_type, caller_card, caller_card_meaning,
        caller_location, caller_lat, caller_lon, caller_location_confidence,
        phenomenon_ref, notes,
        wbpr_prompts(id, position, card, tone),
        wbpr_tracks(id, position, title, artist, url, source, notes)
      ),
      wbpr_phenomena(id, key, name, status, confidence, locations, lat, lon, notes, tags)
    `)
    .eq('workspace_id', workspaceId)
    .eq('slug', slug)
    .order('position', { referencedTable: 'wbpr_blocks' })
    .order('key', { referencedTable: 'wbpr_phenomena' })
    .maybeSingle();

  if (!data) return null;

  const row = data as Record<string, any>;
  const { wbpr_blocks, wbpr_phenomena, ...rest } = row;

  return {
    ...(rest as Omit<Broadcast, 'blocks' | 'phenomena'>),
    // The two nested-nested lists cannot be ordered by PostgREST, so they are
    // sorted here. One level down it will do it; two it will not.
    blocks: (wbpr_blocks ?? []).map((b: any) => ({
      ...b,
      prompts: [...(b.wbpr_prompts ?? [])].sort((x, y) => x.position - y.position),
      tracks: [...(b.wbpr_tracks ?? [])].sort((x, y) => x.position - y.position),
    })),
    phenomena: wbpr_phenomena ?? [],
  };
}

/** One block on its own, for the page that edits it. */
export async function loadBlock(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  blockId: string
): Promise<(Block & { broadcast_id: string; broadcast_slug: string; session: number }) | null> {
  const { data } = await supabase
    .from('wbpr_blocks')
    .select(`
      id, broadcast_id, position, time_label, caller_type, caller_card,
      caller_card_meaning, caller_location, caller_lat, caller_lon,
      caller_location_confidence, phenomenon_ref, notes,
      wbpr_prompts(id, position, card, tone),
      wbpr_tracks(id, position, title, artist, url, source, notes),
      wbpr_broadcasts(slug, session)
    `)
    .eq('workspace_id', workspaceId)
    .eq('id', blockId)
    .maybeSingle();

  if (!data) return null;
  const row = data as Record<string, any>;

  return {
    ...(row as Block & { broadcast_id: string }),
    broadcast_slug: row.wbpr_broadcasts?.slug ?? '',
    session: row.wbpr_broadcasts?.session ?? 0,
    prompts: [...(row.wbpr_prompts ?? [])].sort((a: Prompt, b: Prompt) => a.position - b.position),
    tracks: [...(row.wbpr_tracks ?? [])].sort((a: Track, b: Track) => a.position - b.position),
  };
}

/**
 * The phenomena catalogue, which is not a table.
 *
 * A phenomenon's current state is whatever the most recent broadcast said about
 * it, so the catalogue is the log read newest-first and folded by key. Keeping
 * it derived rather than stored is what stops the two disagreeing: there is no
 * standing row for anyone to forget to update when a night changes the picture.
 */
export interface CatalogueEntry extends Phenomenon {
  first_session: number;
  last_session: number;
  sightings: number;
}

export async function loadPhenomenaCatalogue(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<CatalogueEntry[]> {
  const { data } = await supabase
    .from('wbpr_phenomena')
    .select('id, key, name, status, confidence, locations, lat, lon, notes, tags, wbpr_broadcasts(session)')
    .eq('workspace_id', workspaceId);

  const byKey = new Map<string, CatalogueEntry>();

  for (const row of (data ?? []) as any[]) {
    const session = row.wbpr_broadcasts?.session ?? 0;
    const existing = byKey.get(row.key);

    if (!existing) {
      byKey.set(row.key, {
        ...(row as Phenomenon),
        first_session: session,
        last_session: session,
        sightings: 1,
      });
      continue;
    }

    existing.sightings += 1;
    existing.first_session = Math.min(existing.first_session, session);
    // Only a later sighting may overwrite the standing description.
    if (session >= existing.last_session) {
      Object.assign(existing, row as Phenomenon, {
        first_session: existing.first_session,
        last_session: session,
        sightings: existing.sightings,
      });
    }
  }

  return [...byKey.values()].sort(
    (a, b) => b.last_session - a.last_session || a.name.localeCompare(b.name, 'en')
  );
}

/** The slug a session number answers to, e.g. 9 → wbpr-s09. */
export const broadcastSlug = (session: number) => `wbpr-s${String(session).padStart(2, '0')}`;

/** Blocks with a caller, which is the number the archive reports. */
export const callerCount = (blocks: Pick<Block, 'caller_type'>[]) =>
  blocks.filter(b => b.caller_type !== 'none').length;

/**
 * The prose in a block or in Oso's notes, as paragraphs.
 *
 * The archive's text came out of markdown and still carries `**bold**` and
 * `*italic*` — a full markdown renderer for two inline markers would be a
 * dependency doing almost nothing, so this handles those two and escapes
 * everything else. Escaping happens *first*, so a `<` in a caller's account of
 * a road sign stays a `<` and cannot open a tag.
 */
export function renderProse(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(para =>
      `<p>${para
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/\n/g, '<br />')}</p>`
    )
    .join('');
}
