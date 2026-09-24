import type { Tables } from '../database.types.ts';
import {
  PLACES, acceptedFor, deckPlaceKeys, deckRefs, inRegion, parseRef, placeRef, type MapDeck,
} from './decks.ts';
import type { MarkOptions } from './mark.ts';
import { MAP_MARKING } from './mark.ts';
import { MODES, type ModeId, type Settings } from './modes.ts';
import { mastery, type StoredState } from './schedule.ts';
import type { GazetteerMap } from './server.ts';
import { toStored } from './server.ts';

/**
 * What one run asks, worked out on the server and handed to the browser whole.
 *
 * The browser gets the questions and their answers. That is the trade-off the
 * spec states: marking has to be instant, and on a map the question is the
 * shape, which is on the page anyway. What the browser never decides is who it
 * is or what time it is (see the cp_* functions).
 */

export interface PlayItem {
  ref: string;
  /** The place, for map items. Null for a flashcard. */
  key: string | null;
  /** Typed, or clicked on the map. Review mixes the two. */
  ask: 'type' | 'click';
  /** Shown above the input. Empty in Name it, where the shape is the prompt. */
  prompt: string;
  /** Every accepted form. The first is the one shown. */
  answers: string[];
  /** Other official answers, named on the reveal (Cape Town, La Paz). */
  also: string[];
  /** Which pool this item's answer is compared against for near misses. */
  pool: 'names' | 'capitals' | 'cards' | 'cards-rev';
  /** A flashcard's own first hint, before the letter ladder. */
  hint: string;
  notes: string;
  region: string;
}

export interface PoolEntry {
  key: string;
  answers: string[];
  region: string;
}

export interface PlayData {
  api: string;
  deckRef: string;
  deckTitle: string;
  deckHref: string;
  kind: 'map' | 'cards';
  mode: ModeId;
  modeLabel: string;
  settings: Settings;
  pbKey: string;
  daily: string | null;
  schedules: boolean;
  retention: number;
  marking: MarkOptions;
  items: PlayItem[];
  pools: Record<'names' | 'capitals' | 'cards' | 'cards-rev', PoolEntry[]>;
  /** For Neighbours: every place on the map by key, with its accepted names. */
  names: Record<string, string[]>;
  neighbours: Record<string, string[]>;
  /** Keys on the map that are in this run; everything else is drawn grey. */
  inPlay: string[];
  states: Record<string, StoredState>;
  againHref: string;
  missedHref: string;
  nextReview: { href: string; label: string } | null;
  /** Shown instead of a board when there is nothing to ask. */
  empty: string | null;
}

type StateRows = Map<string, Tables<'cp_card_state'>>;

export type PlaceDir = 'name' | 'locate' | 'capital' | 'country';

/** Which fact a mode asks, on a deck of this topic. */
export function dirFor(mode: ModeId, topic: MapDeck['topic']): PlaceDir {
  if (topic === 'capitals') return mode === 'capital-find' ? 'country' : 'capital';
  return mode === 'locate' ? 'locate' : 'name';
}

export function placeItem(key: string, dir: PlaceDir): PlayItem {
  const p = PLACES[key];
  const capital = p.capital;
  const base = { ref: placeRef(key, dir), key, hint: '', notes: '', region: p.region };
  switch (dir) {
    case 'name':
      return { ...base, ask: 'type', prompt: '', answers: acceptedFor(key, 'name'), also: [], pool: 'names' };
    case 'locate':
      return { ...base, ask: 'click', prompt: p.name, answers: acceptedFor(key, 'name'), also: [], pool: 'names' };
    case 'capital':
      return {
        ...base, ask: 'type', prompt: p.name,
        answers: acceptedFor(key, 'capital'), also: capital?.also ?? [], pool: 'capitals',
      };
    case 'country':
      return {
        ...base, ask: 'click', prompt: capital?.name ?? p.name,
        answers: acceptedFor(key, 'name'), also: [], pool: 'names',
      };
  }
}

export interface MapPlayInput {
  deck: MapDeck;
  map: GazetteerMap;
  mode: ModeId;
  settings: Settings;
  states: StateRows;
  newRemaining: number;
  /** Refs or keys to restrict to: "only the ones I missed". */
  only: string[] | null;
  /** The daily challenge's fixed refs, in order. */
  fixed: string[] | null;
  now?: Date;
}

export function buildMapItems(input: MapPlayInput) {
  const { deck, map, mode, settings, states, now = new Date() } = input;
  const inc = { territories: settings.territories, disputed: settings.disputed };
  const everything = deckPlaceKeys(deck, { territories: true, disputed: true });
  let keys = deckPlaceKeys(deck, inc).filter(k => map.places[k]);
  const stateOf = (ref: string) => (states.has(ref) ? toStored(states.get(ref)!) : null);

  // The direction that colours the progress map and decides "learnt".
  const primaryDir: PlaceDir = deck.topic === 'capitals' ? 'capital' : 'name';

  // Scope.
  const scope = settings.scope;
  if (scope === 'small') keys = keys.filter(k => map.places[k].small);
  else if (scope === 'unlearnt') {
    keys = keys.filter(k => {
      const m = mastery(stateOf(placeRef(k, primaryDir)), now);
      return m !== 'known' && m !== 'mastered';
    });
  } else if (scope === 'missed') {
    keys = keys.filter(k => {
      const row = states.get(placeRef(k, primaryDir));
      return !!row && (row.last_result === 'hinted' || row.last_result === 'revealed' || mastery(toStored(row), now) === 'due');
    });
  } else if (scope !== 'all' && deck.regions.includes(scope)) {
    keys = keys.filter(k => inRegion(k, scope));
  }

  if (input.only?.length) {
    const only = new Set(input.only.map(o => parseRef(o)?.kind === 'place' ? (parseRef(o) as { key: string }).key : o));
    keys = keys.filter(k => only.has(k));
  }

  let items: PlayItem[];
  if (input.fixed) {
    items = input.fixed.flatMap(ref => {
      const p = parseRef(ref);
      return p?.kind === 'place' && PLACES[p.key] && map.places[p.key] ? [placeItem(p.key, p.dir)] : [];
    });
  } else if (mode === 'review') {
    items = deckRefs(deck, keys)
      .filter(ref => {
        const s = stateOf(ref);
        return !!s && new Date(s.due_at) <= now;
      })
      .map(ref => {
        const p = parseRef(ref) as { key: string; dir: PlaceDir };
        return placeItem(p.key, p.dir);
      });
  } else if (mode === 'learn') {
    const fresh = keys.filter(k => !states.has(placeRef(k, primaryDir)));
    const limit = Math.min(input.newRemaining, settings.length || 12);
    items = fresh.slice(0, Math.max(0, limit)).map(k => placeItem(k, primaryDir));
  } else if (mode === 'neighbours') {
    items = keys
      .filter(k => PLACES[k].neighbours.some(n => map.places[n]))
      .map(k => placeItem(k, 'name'));
  } else {
    items = keys.map(k => placeItem(k, dirFor(mode, deck.topic)));
  }

  const inPlay = [...new Set([...keys, ...items.map(i => i.key!)])];

  const pool = (dir: 'name' | 'capital'): PoolEntry[] =>
    everything
      .filter(k => dir === 'name' || PLACES[k].capital)
      .map(k => ({ key: k, answers: acceptedFor(k, dir), region: PLACES[k].region }));

  const names: Record<string, string[]> = {};
  const neighbours: Record<string, string[]> = {};
  if (mode === 'neighbours') {
    for (const k of Object.keys(map.places)) {
      if (PLACES[k]) names[k] = acceptedFor(k, 'name');
    }
  }
  // Neighbours are also the third rung of the Find it hint ladder, and the
  // first choice of wrong answers in multiple choice.
  for (const k of keys) neighbours[k] = PLACES[k].neighbours.filter(n => map.places[n]);

  const refs = new Set(items.map(i => i.ref));
  const known: Record<string, StoredState> = {};
  for (const ref of refs) {
    const s = stateOf(ref);
    if (s) known[ref] = s;
  }

  return {
    items,
    inPlay,
    pools: { names: pool('name'), capitals: deck.topic === 'capitals' || mode === 'review' ? pool('capital') : [], cards: [], 'cards-rev': [] },
    names,
    neighbours,
    states: known,
    schedules: MODES[mode].schedules,
    marking: MAP_MARKING,
  };
}

/** Why a run has nothing in it, in words. */
export function emptyReason(mode: ModeId, settings: Settings): string {
  if (mode === 'review') return 'Nothing is due here. Come back tomorrow, or learn something new.';
  if (mode === 'learn') return 'Nothing new to learn here today: either you have seen it all, or today’s allowance of new cards is spent.';
  if (settings.scope === 'missed') return 'Nothing missed recently. Well done.';
  if (settings.scope === 'unlearnt') return 'You have learnt everything in this deck.';
  return 'Nothing matches those settings.';
}

// ── Daily challenge ───────────────────────────────────────────────────

export const DAILY_DECKS = ['europe', 'africa', 'asia', 'north-america', 'us-states', 'south-america', 'oceania'];
export const DAILY_SIZE = 10;

/** A small, stable string hash (FNV-1a). Stable is the point: every member must propose the same ten. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Today's proposal: the deck by the day, the ten by a hash of workspace and
 * date. cp_daily_today() keeps whichever proposal arrives first, so this only
 * needs to be the same for everybody, not the same forever.
 */
export function proposeDaily(workspaceId: string, day: string, deckKeys: (slug: string) => string[]) {
  const dayIndex = Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 86_400_000);
  const slug = DAILY_DECKS[dayIndex % DAILY_DECKS.length];
  const keys = deckKeys(slug)
    .map(k => [hash(`${workspaceId}:${day}:${k}`), k] as const)
    .sort((a, b) => a[0] - b[0])
    .slice(0, DAILY_SIZE)
    .map(([, k]) => placeRef(k, 'name'));
  return { slug, refs: keys };
}

// ── Flashcards ────────────────────────────────────────────────────────

export interface CardRow {
  id: string;
  prompt: string;
  answer: string;
  accepts: string[];
  hint: string;
  notes: string;
  tags: string[];
  reverse: boolean;
}

const slugTag = (t: string) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function cardItem(c: CardRow, dir: 'fwd' | 'rev'): PlayItem {
  const fwd = dir === 'fwd';
  return {
    ref: `card:${c.id}:${dir}`,
    key: null,
    ask: 'type',
    prompt: fwd ? c.prompt : c.answer,
    answers: fwd ? [c.answer, ...c.accepts] : [c.prompt],
    also: [],
    pool: fwd ? 'cards' : 'cards-rev',
    hint: fwd ? c.hint : '',
    notes: c.notes,
    region: c.tags[0] ?? '',
  };
}

/** Which directions a card is asked in, for a run's direction setting. */
export function cardDirs(c: CardRow, direction: Settings['direction']): ('fwd' | 'rev')[] {
  if (direction === 'rev') return ['rev'];
  if (direction === 'both') return ['fwd', 'rev'];
  return c.reverse ? ['fwd', 'rev'] : ['fwd'];
}

export function buildCardItems(input: {
  cards: CardRow[];
  mode: ModeId;
  settings: Settings;
  states: StateRows;
  newRemaining: number;
  only: string[] | null;
  now?: Date;
}) {
  const { mode, settings, states, now = new Date() } = input;
  let cards = input.cards;
  const scope = settings.scope;
  if (input.only?.length) {
    const only = new Set(input.only);
    cards = cards.filter(c => only.has(c.id));
  }
  if (scope !== 'all' && scope !== 'unlearnt' && scope !== 'missed') {
    cards = cards.filter(c => c.tags.some(t => slugTag(t) === scope));
  }
  // Learn and Review work on facts, both directions as the card says; the
  // direction setting is for practice runs.
  const dirSetting = mode === 'learn' || mode === 'review' ? 'fwd' : settings.direction;
  let items = cards.flatMap(c => cardDirs(c, dirSetting).map(d => cardItem(c, d)));
  const stateOf = (ref: string) => (states.has(ref) ? toStored(states.get(ref)!) : null);

  if (scope === 'unlearnt') {
    items = items.filter(i => { const m = mastery(stateOf(i.ref), now); return m !== 'known' && m !== 'mastered'; });
  } else if (scope === 'missed') {
    items = items.filter(i => {
      const row = states.get(i.ref);
      return !!row && (row.last_result === 'hinted' || row.last_result === 'revealed' || mastery(toStored(row), now) === 'due');
    });
  }
  if (mode === 'review') {
    items = items.filter(i => { const s = stateOf(i.ref); return !!s && new Date(s.due_at) <= now; });
  } else if (mode === 'learn') {
    const limit = Math.min(input.newRemaining, settings.length || 12);
    items = items.filter(i => !states.has(i.ref)).slice(0, Math.max(0, limit));
  }

  const all = input.cards;
  const known: Record<string, StoredState> = {};
  for (const i of items) {
    const s = stateOf(i.ref);
    if (s) known[i.ref] = s;
  }
  return {
    items,
    inPlay: [],
    pools: {
      names: [],
      capitals: [],
      cards: all.map(c => ({ key: `card:${c.id}:fwd`, answers: [c.answer, ...c.accepts], region: c.tags[0] ?? '' })),
      'cards-rev': all.map(c => ({ key: `card:${c.id}:rev`, answers: [c.prompt], region: c.tags[0] ?? '' })),
    },
    names: {},
    neighbours: {},
    states: known,
    schedules: MODES[mode].schedules,
  };
}

export { slugTag };
