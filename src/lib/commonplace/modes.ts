/**
 * Ways to play, and the settings around them.
 *
 * A run is a mode (what you are asked) with settings (the rules around it)
 * over a scope (which cards). The settings travel in the play page's query
 * string, so a run can be bookmarked, shared, or started again from the
 * results screen with one link.
 */
import type { Topic } from './decks.ts';

export type ModeId =
  | 'name' | 'locate' | 'capital' | 'capital-find' | 'outline' | 'free' | 'neighbours'
  | 'choice' | 'learn' | 'review' | 'daily' | 'typed' | 'flip';

export interface ModeDef {
  id: ModeId;
  label: string;
  blurb: string;
  /** Whether answers in this mode move the review schedule. See the spec on why three do not. */
  schedules: boolean;
  /** Whether a timer, attempts and so on mean anything here. */
  timed: boolean;
}

export const MODES: Record<ModeId, ModeDef> = {
  name: { id: 'name', label: 'Name it', blurb: 'Click a shape, type its name.', schedules: true, timed: true },
  locate: { id: 'locate', label: 'Find it', blurb: 'You are given a name. Click the shape.', schedules: true, timed: true },
  capital: { id: 'capital', label: 'Capitals', blurb: 'A country is highlighted. Type its capital.', schedules: true, timed: true },
  'capital-find': { id: 'capital-find', label: 'Capitals, reversed', blurb: 'You are given a capital. Click its country.', schedules: true, timed: true },
  outline: { id: 'outline', label: 'Outline', blurb: 'One shape on its own, no map around it. Name it.', schedules: true, timed: true },
  free: { id: 'free', label: 'Free recall', blurb: 'Type names in any order. They fill in as you go.', schedules: false, timed: true },
  neighbours: { id: 'neighbours', label: 'Neighbours', blurb: 'Name everything that borders the highlighted place.', schedules: false, timed: true },
  choice: { id: 'choice', label: 'Multiple choice', blurb: 'Four options, all from the same part of the world.', schedules: false, timed: true },
  learn: { id: 'learn', label: 'Learn', blurb: 'New ones, three at a time: shown, then asked, then mixed in.', schedules: true, timed: false },
  review: { id: 'review', label: 'Review', blurb: 'Whatever is due, each asked the way it was learnt.', schedules: true, timed: false },
  daily: { id: 'daily', label: 'Daily challenge', blurb: 'Ten places, the same for everyone here. One go a day.', schedules: true, timed: false },
  typed: { id: 'typed', label: 'Type the answer', blurb: 'See the prompt, type the answer.', schedules: true, timed: true },
  flip: { id: 'flip', label: 'Flip and rate', blurb: 'See the prompt, flip the card, say how well you knew it.', schedules: true, timed: false },
};

/** Which modes a deck page offers, in order. */
export function modesFor(kind: 'map' | 'flashcards', topic?: Topic): ModeId[] {
  if (kind === 'flashcards') return ['learn', 'typed', 'flip', 'choice', 'review'];
  if (topic === 'capitals') return ['learn', 'capital', 'capital-find', 'free', 'choice', 'review'];
  return ['learn', 'name', 'locate', 'outline', 'free', 'neighbours', 'choice', 'review'];
}

// ── Settings ──────────────────────────────────────────────────────────

export type Timer = 'off' | 'up' | '3' | '5' | '10' | '15';
export type Order = 'random' | 'west' | 'largest' | 'smallest' | 'deck';
export type Advance = 'stay' | 'next' | 'nearest';
export type Direction = 'fwd' | 'rev' | 'both';

export interface Settings {
  timer: Timer;
  sudden: boolean;
  /** 0 is unlimited. */
  attempts: 0 | 1 | 3 | 5;
  hints: boolean;
  order: Order;
  /** 0 is the whole deck. */
  length: 0 | 10 | 20 | 50;
  labels: boolean;
  advance: Advance;
  territories: boolean;
  disputed: boolean;
  /** 'all', a region id, or one of the SCOPES below. */
  scope: string;
  /** Flashcards only. */
  direction: Direction;
}

export const DEFAULTS: Settings = {
  timer: 'up',
  sudden: false,
  attempts: 3,
  hints: true,
  order: 'random',
  length: 0,
  labels: true,
  advance: 'nearest',
  territories: false,
  disputed: true,
  scope: 'all',
  direction: 'fwd',
};

/** Scopes that are about you rather than about geography. */
export const SCOPES: Record<string, string> = {
  all: 'Everything',
  unlearnt: 'Only ones I have not learnt',
  missed: 'Only ones I have got wrong recently',
  small: 'Only small places',
};

const pick = <T extends string | number>(value: string | null, allowed: readonly T[], fallback: T): T => {
  if (value === null) return fallback;
  const found = allowed.find(a => String(a) === value);
  return found ?? fallback;
};
const flag = (value: string | null, fallback: boolean) =>
  value === null ? fallback : value === '1' || value === 'true' || value === 'on';

export function parseSettings(q: URLSearchParams): Settings {
  return {
    timer: pick(q.get('timer'), ['off', 'up', '3', '5', '10', '15'] as const, DEFAULTS.timer),
    sudden: flag(q.get('sudden'), DEFAULTS.sudden),
    attempts: pick(q.get('attempts'), [0, 1, 3, 5] as const, DEFAULTS.attempts),
    hints: flag(q.get('hints'), DEFAULTS.hints),
    order: pick(q.get('order'), ['random', 'west', 'largest', 'smallest', 'deck'] as const, DEFAULTS.order),
    length: pick(q.get('length'), [0, 10, 20, 50] as const, DEFAULTS.length),
    labels: flag(q.get('labels'), DEFAULTS.labels),
    advance: pick(q.get('advance'), ['stay', 'next', 'nearest'] as const, DEFAULTS.advance),
    territories: flag(q.get('territories'), DEFAULTS.territories),
    disputed: flag(q.get('disputed'), DEFAULTS.disputed),
    scope: (q.get('scope') ?? DEFAULTS.scope).replace(/[^a-z-]/g, '') || 'all',
    direction: pick(q.get('direction'), ['fwd', 'rev', 'both'] as const, DEFAULTS.direction),
  };
}

/** Back to a query string, leaving out anything at its default. */
export function settingsQuery(s: Settings, mode: ModeId): string {
  const q = new URLSearchParams({ mode });
  for (const [k, v] of Object.entries(s) as [keyof Settings, Settings[keyof Settings]][]) {
    if (v === DEFAULTS[k]) continue;
    q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  return q.toString();
}

/**
 * The key a personal best is filed under: deck, mode, scope, and every setting
 * that changes how hard the run was. Beating a time with hints on is not
 * beating it with hints off, so the two are different bests.
 */
export function pbKey(deck: string, mode: ModeId, s: Settings): string {
  return [
    deck, mode, s.scope,
    `t${s.timer}`, s.sudden ? 'sd' : '', s.hints ? 'h' : 'nh', `a${s.attempts}`, `n${s.length}`,
    s.territories ? 'terr' : '', s.disputed ? '' : 'nodisp', mode === 'typed' || mode === 'flip' || mode === 'choice' ? s.direction : '',
  ].filter(Boolean).join('|');
}

/** Seconds on the clock for a countdown, or null when the clock counts up or is off. */
export function countdownSeconds(t: Timer): number | null {
  return t === 'off' || t === 'up' ? null : Number(t) * 60;
}
