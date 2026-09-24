import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '../database.types.ts';
import type { StoredState } from './schedule.ts';
import { DEFAULT_NEW_PER_DAY, DEFAULT_RETENTION } from './schedule.ts';
import type { MapId } from './decks.ts';

/**
 * Reads the pages need, gathered so each page does not rebuild them.
 *
 * Everything here runs as the signed-in user, so RLS decides what comes back:
 * card state is the viewer's own rows whatever the query says, and a deck in a
 * project the viewer cannot read is simply not found.
 */

type Db = SupabaseClient<Database>;

export interface MapPlace {
  d: string;
  c: [number, number];
  b: [number, number, number, number];
  small: boolean;
  cap?: [number, number];
}

export interface GazetteerMap {
  id: MapId;
  title: string;
  viewBox: [number, number, number, number];
  places: Record<string, MapPlace>;
  context: string;
}

// Lazy, so a page that draws Europe does not pull the world into its bundle.
const MAPS = import.meta.glob<{ default: GazetteerMap }>('../../data/gazetteer/maps/*.json');

export async function loadMap(id: MapId): Promise<GazetteerMap> {
  const load = MAPS[`../../data/gazetteer/maps/${id}.json`];
  if (!load) throw new Error(`no map ${id}`);
  return (await load()).default;
}

/**
 * Every card state the viewer holds, as a map from card reference.
 *
 * Paged, because PostgREST caps a response at a thousand rows and a year of
 * world capitals and flashcards passes that. Own rows only, by policy.
 */
export async function loadStates(supabase: Db): Promise<Map<string, Tables<'cp_card_state'>>> {
  const out = new Map<string, Tables<'cp_card_state'>>();
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('cp_card_state')
      .select('*')
      .order('card_ref')
      .range(from, from + page - 1);
    if (error) {
      console.error('cp_card_state read failed', error);
      break;
    }
    for (const row of data ?? []) out.set(row.card_ref, row);
    if (!data || data.length < page) break;
  }
  return out;
}

/** The subset of a stored row the scheduler needs. */
export function toStored(row: Tables<'cp_card_state'>): StoredState {
  return {
    due_at: row.due_at,
    last_at: row.last_at,
    stability: row.stability,
    difficulty: row.difficulty,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    learning_steps: row.learning_steps,
    scheduled_days: row.scheduled_days,
  };
}

export interface Prefs {
  retention: number;
  new_per_day: number;
}

export async function loadPrefs(supabase: Db): Promise<Prefs> {
  const { data } = await supabase.from('cp_prefs').select('retention, new_per_day').maybeSingle();
  return data ?? { retention: DEFAULT_RETENTION, new_per_day: DEFAULT_NEW_PER_DAY };
}

/** Midnight in London, today, as an instant. The same "today" the database uses. */
export function startOfToday(now = new Date()): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);
  // The offset of London at that moment: 0 in winter, 60 in summer.
  const london = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = london.getTime() - utc.getTime();
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - offset);
}

/** How many new cards the viewer may still be introduced to today. */
export function newRemaining(states: Map<string, Tables<'cp_card_state'>>, prefs: Prefs, now = new Date()): number {
  const since = startOfToday(now).getTime();
  let seen = 0;
  for (const s of states.values()) if (new Date(s.created_at).getTime() >= since) seen++;
  return Math.max(0, prefs.new_per_day - seen);
}

// ── Custom decks ──────────────────────────────────────────────────────

export interface DeckSettings {
  typos: boolean;
  accents: 'ignore' | 'close';
  caseSensitive: boolean;
  blurb: string;
}

export const DEFAULT_DECK_SETTINGS: DeckSettings = {
  typos: true,
  accents: 'close',
  caseSensitive: false,
  blurb: '',
};

export function deckSettings(raw: unknown): DeckSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    typos: typeof r.typos === 'boolean' ? r.typos : DEFAULT_DECK_SETTINGS.typos,
    accents: r.accents === 'ignore' ? 'ignore' : 'close',
    caseSensitive: r.caseSensitive === true,
    blurb: typeof r.blurb === 'string' ? r.blurb.slice(0, 300) : '',
  };
}

export async function listDecks(supabase: Db, workspaceId: string) {
  const { data } = await supabase
    .from('cp_decks')
    .select('id, slug, title, settings, updated_at')
    .eq('workspace_id', workspaceId)
    .order('title');
  return data ?? [];
}

export async function loadDeck(supabase: Db, workspaceId: string, slug: string) {
  const { data: deck } = await supabase
    .from('cp_decks')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('slug', slug)
    .maybeSingle();
  if (!deck) return null;
  const { data: cards } = await supabase
    .from('cp_cards')
    .select('*')
    .eq('deck_id', deck.id)
    .order('position');
  return { deck, cards: cards ?? [], settings: deckSettings(deck.settings) };
}

/** Card id → deck slug, for grouping due flashcards by the deck they belong to. */
export async function cardDecks(supabase: Db, workspaceId: string): Promise<Map<string, { slug: string; title: string }>> {
  const { data } = await supabase
    .from('cp_cards')
    .select('id, cp_decks!inner(slug, title, workspace_id)')
    .eq('cp_decks.workspace_id', workspaceId);
  const out = new Map<string, { slug: string; title: string }>();
  for (const row of (data ?? []) as unknown as { id: string; cp_decks: { slug: string; title: string } }[]) {
    out.set(row.id, { slug: row.cp_decks.slug, title: row.cp_decks.title });
  }
  return out;
}

/** The address a run at a custom deck is recorded under, kept apart from built-in slugs. */
export const customDeckRef = (slug: string) => `cards-${slug}`;

/** "3:07", or "1:02:44" past an hour. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
