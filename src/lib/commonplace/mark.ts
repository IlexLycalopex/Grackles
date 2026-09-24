import { distance, normalise, typoAllowance } from './normalise.ts';

/**
 * Marking one typed answer.
 *
 * Every mode that takes a typed answer comes through here, maps and flashcards
 * alike. It knows nothing about hints, attempts or scheduling: it answers only
 * "is this input the answer", in one of three ways.
 *
 *   exact  right, after normalising
 *   close  right, with a slip the deck forgives (a typo, a missing accent)
 *   wrong  not right, or right-looking but nearer to a different answer
 */
export type Verdict = 'exact' | 'close' | 'wrong';

export interface MarkOptions {
  /** Forgive slips of one or two letters. On for maps; a deck setting for cards. */
  typos?: boolean;
  /**
   * 'ignore': accents never matter (maps).
   * 'close':  a missing or wrong accent is accepted but marked close (languages).
   */
  accents?: 'ignore' | 'close';
  /** A right answer in the wrong case is marked close. */
  caseSensitive?: boolean;
}

export const MAP_MARKING: MarkOptions = { typos: true, accents: 'ignore', caseSensitive: false };

/**
 * @param input    what was typed
 * @param accepted every form that counts as this answer: the answer itself and
 *                 its alternatives
 * @param rivals   every other answer in the same deck. A typo is never accepted
 *                 if it lands as near to one of these as to the target: typing
 *                 "Nigeri" for Niger is not a slip, it is the wrong country.
 */
export function mark(
  input: string,
  accepted: readonly string[],
  rivals: readonly string[] = [],
  opts: MarkOptions = MAP_MARKING
): Verdict {
  const n = normalise(input);
  if (!n) return 'wrong';

  const targets = accepted.map(a => normalise(a)).filter(Boolean);
  const targetSet = new Set(targets);
  const rivalSet = new Set(rivals.map(r => normalise(r)).filter(r => r && !targetSet.has(r)));

  if (targetSet.has(n)) {
    // Right once folded. Whether the fold was forgivable is the deck's call.
    const strict = { accents: opts.accents === 'close', caseSensitive: !!opts.caseSensitive };
    if (strict.accents || strict.caseSensitive) {
      const precise = normalise(input, strict);
      if (!accepted.some(a => normalise(a, strict) === precise)) return 'close';
    }
    return 'exact';
  }

  if (rivalSet.has(n)) return 'wrong';
  if (!opts.typos) return 'wrong';

  let best = Infinity;
  for (const t of targets) {
    const d = distance(n, t);
    if (d <= typoAllowance(t.length) && d < best) best = d;
  }
  if (best === Infinity) return 'wrong';

  for (const r of rivalSet) {
    if (distance(n, r) <= best) return 'wrong';
  }
  return 'close';
}

/**
 * Free recall: which of the remaining answers, if any, this input names.
 *
 * Exact after normalising, and nothing looser. The input is checked on every
 * keystroke, and "nige" is on its way to both Niger and Nigeria: typo tolerance
 * here would fill in countries the player never meant.
 */
export function recall<T>(input: string, remaining: Iterable<[T, readonly string[]]>): T | null {
  const n = normalise(input);
  if (!n) return null;
  for (const [id, accepted] of remaining) {
    if (accepted.some(a => normalise(a) === n)) return id;
  }
  return null;
}
