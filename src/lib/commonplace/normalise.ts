/**
 * What two answers have to agree on before they are compared.
 *
 * Both sides go through the same steps, so an accepted name never needs to be
 * listed twice to cover a capital letter, an accent or a full stop. The build
 * script uses this too, to refuse a deck in which two places share a name once
 * it has been applied.
 */

export interface NormaliseOptions {
  /** Keep accents rather than folding them away. Language decks can ask for it. */
  accents?: boolean;
  /** Keep case. German nouns, for example. */
  caseSensitive?: boolean;
}

export function normalise(input: string, opts: NormaliseOptions = {}): string {
  let s = input.normalize('NFKD');
  if (!opts.accents) s = s.replace(/\p{M}/gu, '');
  else s = s.normalize('NFC');
  if (!opts.caseSensitive) s = s.toLowerCase();
  s = s
    .replace(/&/g, ' and ')
    // Straight and curly apostrophes vanish rather than becoming a space:
    // "Cote d'Ivoire" and "Cote dIvoire" are the same answer.
    .replace(/['’‘ʻ`]/g, '')
    // Everything else that is not a letter or a digit is a word break.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  // "St", "St." and "Saint" are one word. Only at the start of a word, so
  // "Sts" or "first" are left alone.
  s = s.replace(/(^| )st(?= |$)/gi, (_m, pre) => `${pre}saint`);
  s = s.replace(/^the /i, '');
  return s.replace(/ +/g, ' ');
}

/**
 * Optimal string alignment distance: insertions, deletions, substitutions, and
 * a swap of two neighbouring letters counted as one edit. The swap is the point
 * of using this over plain Levenshtein: "Lihtuania" is one slip, not two.
 */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev2 = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
    }
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[n];
}

/** How many slips an answer of this length can absorb and still be accepted. */
export function typoAllowance(length: number): number {
  if (length <= 4) return 0;
  if (length <= 8) return 1;
  return 2;
}
