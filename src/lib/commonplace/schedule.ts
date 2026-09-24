import { createEmptyCard, fsrs, generatorParameters, type Card, type Grade as FsrsGrade } from 'ts-fsrs';
import type { Grade } from './result.ts';

/**
 * When a fact is next asked, and how well it is known.
 *
 * FSRS, through ts-fsrs. It runs in the browser and only its result is saved:
 * the scheduler is deterministic with fuzz off, and it is the player's own
 * record, so there is nothing for the server to check by running it again.
 *
 * `StoredState` is exactly the columns of cp_card_state, so what the browser
 * sends and what the database holds are the same shape.
 */
export interface StoredState {
  due_at: string;
  last_at: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  /** 0 new, 1 learning, 2 review, 3 relearning */
  state: number;
  learning_steps: number;
  scheduled_days: number;
}

export const DEFAULT_RETENTION = 0.9;
export const DEFAULT_NEW_PER_DAY = 20;

function scheduler(retention = DEFAULT_RETENTION) {
  return fsrs(generatorParameters({ request_retention: retention, enable_fuzz: false }));
}

function toCard(s: StoredState): Card {
  return {
    due: new Date(s.due_at),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: 0,
    scheduled_days: s.scheduled_days,
    learning_steps: s.learning_steps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state,
    last_review: new Date(s.last_at),
  };
}

function fromCard(c: Card, now: Date): StoredState {
  return {
    due_at: c.due.toISOString(),
    last_at: (c.last_review ?? now).toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    learning_steps: c.learning_steps,
    scheduled_days: c.scheduled_days,
  };
}

/** The state after answering, from the state before (null for a first sight). */
export function review(
  prev: StoredState | null,
  grade: Grade,
  now = new Date(),
  retention = DEFAULT_RETENTION
): StoredState {
  const card = prev ? toCard(prev) : createEmptyCard(now);
  const { card: next } = scheduler(retention).next(card, now, grade as FsrsGrade);
  return fromCard(next, now);
}

/** How likely the fact is to be recalled at `at`, between 0 and 1. */
export function recallAt(s: StoredState, at: Date, retention = DEFAULT_RETENTION): number {
  return scheduler(retention).get_retrievability(toCard(s), at, false) as number;
}

/**
 * The five states the progress map is coloured by.
 *
 *   new       never seen
 *   learning  seen, not yet out of the short learning steps
 *   due       due for review now
 *   known     scheduled, not due
 *   mastered  better than 95% likely to be recalled a month from now
 */
export type Mastery = 'new' | 'learning' | 'due' | 'known' | 'mastered';

export const MASTERY_LABEL: Record<Mastery, string> = {
  new: 'Not seen',
  learning: 'Learning',
  due: 'Due',
  known: 'Known',
  mastered: 'Mastered',
};

const MONTH = 30 * 24 * 60 * 60 * 1000;

export function mastery(s: StoredState | null | undefined, now = new Date()): Mastery {
  if (!s) return 'new';
  if (s.state === 1 || s.state === 3) return 'learning';
  if (new Date(s.due_at) <= now) return 'due';
  return recallAt(s, new Date(now.getTime() + MONTH)) >= 0.95 ? 'mastered' : 'known';
}

/** Worst first, for picking which of two directions colours a place. */
export const MASTERY_ORDER: readonly Mastery[] = ['new', 'due', 'learning', 'known', 'mastered'];

export function weakest(a: Mastery, b: Mastery): Mastery {
  return MASTERY_ORDER.indexOf(a) <= MASTERY_ORDER.indexOf(b) ? a : b;
}
