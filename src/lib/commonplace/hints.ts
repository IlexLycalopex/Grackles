/**
 * The hint ladder for a typed answer.
 *
 *   1  first letter        B…
 *   2  the letter count    B _ _ _ _ _ _   _ _ _ _
 *   3+ one more letter     B u _ _ _ _ _   _ _ _ _
 *
 * Past the last letter there is nothing left to give but the answer itself,
 * which is the reveal, and belongs to the caller.
 */

const isLetter = (ch: string) => /[\p{L}\p{N}]/u.test(ch);

/** How many hint steps this answer has before the next step would reveal it. */
export function hintSteps(answer: string): number {
  const letters = [...answer].filter(isLetter).length;
  // First letter, then the pattern with one letter, then one more per step,
  // stopping one short of the whole word: a pattern with every letter filled
  // in is the answer typed out, and that is the reveal.
  return Math.max(1, letters);
}

export function typedHint(answer: string, step: number): string {
  if (step <= 0) return '';
  const chars = [...answer];
  if (step === 1) return `${chars.find(isLetter) ?? ''}…`;

  const shown = Math.max(1, step - 1);
  let seen = 0;
  const cells: string[] = [];
  for (const ch of chars) {
    if (isLetter(ch)) {
      cells.push(seen < shown ? ch : '_');
      seen++;
    } else if (ch === ' ') {
      // A word gap reads as a gap: joined below, it becomes three spaces.
      cells.push(' ');
    } else {
      cells.push(ch);
    }
  }
  return cells.join(' ');
}

/**
 * The ladder for finding a place on the map. Each step names what to light up;
 * the map code decides how.
 */
export type LocateHint = 'region' | 'quarter' | 'neighbours';
export const LOCATE_HINTS: readonly LocateHint[] = ['region', 'quarter', 'neighbours'];
