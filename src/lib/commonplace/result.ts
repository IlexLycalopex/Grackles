/**
 * How one card went, and what that means for when it is asked again.
 *
 * Four results, and the whole app agrees on them: the colours on the map, the
 * counts on the results screen, the personal bests, and the rating handed to
 * the scheduler all come from here.
 */
export type CardResult = 'clean' | 'close' | 'hinted' | 'revealed';

export const RESULTS: readonly CardResult[] = ['clean', 'close', 'hinted', 'revealed'];

export const RESULT_LABEL: Record<CardResult, string> = {
  clean: 'Right first time',
  close: 'Right, with a slip',
  hinted: 'Right, with a hint',
  revealed: 'Revealed',
};

export interface Attempt {
  /** Wrong answers given before the right one (or before giving up). */
  wrong: number;
  /** Hint steps taken. */
  hints: number;
  /** The accepted answer was a typo or a missing accent. */
  close: boolean;
  /** Gave up, or ran out of attempts. */
  revealed: boolean;
}

export function resultOf(a: Attempt): CardResult {
  if (a.revealed) return 'revealed';
  if (a.hints > 0) return 'hinted';
  if (a.close) return 'close';
  return 'clean';
}

/** Does this result count as knowing the card, for scores and bests. */
export const counts = (r: CardResult) => r === 'clean' || r === 'close';

/** FSRS ratings, by value, so this module does not need the scheduler loaded. */
export const Again = 1, Hard = 2, Good = 3, Easy = 4;
export type Grade = 1 | 2 | 3 | 4;

/** Answered faster than this, clean, and it was easy. */
export const FAST_MS = { map: 5000, card: 8000 } as const;

/**
 * The rating a result earns. The table in the spec, as code:
 *
 *   clean, quick                               Easy
 *   clean                                      Good
 *   close; clean after a wrong try; 1 hint     Hard
 *   2+ hints; revealed                         Again
 */
export function gradeOf(a: Attempt, ms: number, kind: keyof typeof FAST_MS = 'map'): Grade {
  const r = resultOf(a);
  if (r === 'revealed') return Again;
  if (r === 'hinted') return a.hints >= 2 ? Again : Hard;
  if (r === 'close' || a.wrong > 0) return Hard;
  return ms < FAST_MS[kind] ? Easy : Good;
}
