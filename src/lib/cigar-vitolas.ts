import { fold } from './cigar-search';

/**
 * What a vitola is roughly the size of.
 *
 * This is the same move as `lib/wbpr-deck.ts`: a lookup table the model never
 * sees. Sending it would be renting a reference book on every call so the model
 * could read one row out of it, and — worse — a model handed the expected
 * dimensions for a Robusto will return them whether or not it knows this
 * particular Robusto's. The table's value is precisely that it is independent
 * of the answer it is checking.
 *
 * It catches a failure the range checks in `readLookup` cannot. "Robusto,
 * 7¼ inches, ring 38" has three individually plausible fields; only their
 * disagreement gives it away, and disagreement is the shape confabulation
 * takes once each field on its own looks reasonable.
 *
 * The ranges are deliberately wide and the table deliberately short. A
 * validator that cries wolf gets ignored, and vitola naming is genuinely loose
 * — houses disagree, and a Toro from one marque is a Corona Gorda at another.
 * The check exists to catch the obviously wrong, not to police the marginal.
 * Anything not in this table is simply not checked, which is the correct
 * behaviour for a name we have no opinion about.
 */

export interface VitolaSpec {
  /** Inches, inclusive. */
  length: [number, number];
  /** Ring gauge, inclusive. */
  ring: [number, number];
}

export const VITOLAS: Record<string, VitolaSpec> = {
  cigarillo:       { length: [2.8, 4.5], ring: [18, 30] },
  'demi tasse':    { length: [3.4, 4.3], ring: [26, 36] },
  'half corona':   { length: [3.2, 4.0], ring: [36, 44] },
  'petit corona':  { length: [3.9, 4.9], ring: [36, 44] },
  corona:          { length: [4.9, 5.9], ring: [36, 45] },
  'corona gorda':  { length: [5.2, 6.1], ring: [43, 49] },
  'corona larga':  { length: [5.7, 6.6], ring: [40, 47] },
  'gran corona':   { length: [5.9, 7.1], ring: [43, 49] },
  'double corona': { length: [6.9, 8.1], ring: [45, 53] },
  churchill:       { length: [6.5, 7.4], ring: [44, 52] },
  robusto:         { length: [4.4, 5.4], ring: [45, 55] },
  'petit robusto': { length: [3.6, 4.6], ring: [45, 55] },
  toro:            { length: [5.4, 6.4], ring: [46, 57] },
  gordo:           { length: [4.9, 6.6], ring: [55, 74] },
  lonsdale:        { length: [5.9, 6.9], ring: [39, 45] },
  panetela:        { length: [4.4, 7.1], ring: [28, 40] },
  lancero:         { length: [6.6, 7.9], ring: [35, 43] },
  'petit lancero': { length: [5.4, 6.6], ring: [35, 43] },
  torpedo:         { length: [5.1, 6.6], ring: [46, 57] },
  piramide:        { length: [5.6, 6.6], ring: [46, 57] },
  belicoso:        { length: [4.7, 5.9], ring: [46, 57] },
  perfecto:        { length: [3.9, 7.1], ring: [38, 62] },
  figurado:        { length: [3.9, 8.1], ring: [32, 62] },
  culebra:         { length: [5.4, 6.6], ring: [30, 42] },
  salomon:         { length: [6.6, 7.8], ring: [48, 62] },
};

/**
 * Names that mean one of the above.
 *
 * Only the ones in common circulation. Cuban factory names are a rabbit hole
 * with a hundred entries and diminishing returns — a Mareva or a Hermoso No. 4
 * that goes unchecked is no worse off than the unchecked names already are.
 */
const ALIASES: Record<string, string> = {
  pyramid: 'piramide',
  pyramide: 'piramide',
  piramides: 'piramide',
  pirimide: 'piramide',
  rothschild: 'robusto',
  'short robusto': 'petit robusto',
  'petit edmundo': 'petit robusto',
  'double robusto': 'toro',
  'toro gordo': 'gordo',
  'gran toro': 'gordo',
  presidente: 'double corona',
  'julieta no. 2': 'churchill',
  'laguito no. 1': 'lancero',
  'laguito no. 2': 'petit lancero',
  'petit panetela': 'panetela',
  'gran panetela': 'panetela',
  'long panetela': 'panetela',
  corona_gorda: 'corona gorda',
  'petit pyramid': 'belicoso',
  belicosos: 'belicoso',
  torpedoes: 'torpedo',
  robustos: 'robusto',
  coronas: 'corona',
  churchills: 'churchill',
  toros: 'toro',
  lanceros: 'lancero',
};

/**
 * The spec for a vitola name, or null when we have no opinion.
 *
 * Matching is on the folded name, then on the longest table entry the name
 * contains — so "Petit Robusto" reaches `petit robusto` rather than `robusto`,
 * which is the one substring collision in the table that actually changes the
 * answer.
 */
export function specFor(vitola: string): VitolaSpec | null {
  const name = fold(vitola);
  if (!name) return null;

  const direct = VITOLAS[name] ?? VITOLAS[ALIASES[name] ?? ''];
  if (direct) return direct;

  const contained = [...Object.keys(VITOLAS), ...Object.keys(ALIASES)]
    .filter(key => name.includes(key))
    .sort((a, b) => b.length - a.length)[0];

  if (!contained) return null;
  return VITOLAS[contained] ?? VITOLAS[ALIASES[contained] ?? ''] ?? null;
}

/**
 * Slack beyond the stated range before anything is said.
 *
 * On top of ranges that are already generous, because the cost of a false
 * alarm is that the next real one is ignored.
 */
const LENGTH_SLACK = 0.3;
const RING_SLACK = 2;

/**
 * Where a lookup disagrees with itself.
 *
 * Returns sentences rather than a structured complaint because there is only
 * one thing to do with them — show them to whoever is about to accept the
 * suggestion. Nothing is corrected and nothing is withheld: we know the three
 * fields cannot all be right, and we do not know which one is wrong.
 */
export function checkDimensions(
  vitola: string,
  lengthInches: number | null,
  ringGauge: number | null
): string[] {
  const spec = specFor(vitola);
  if (!spec) return [];

  const notes: string[] = [];
  const name = vitola.trim();

  if (lengthInches !== null) {
    const [low, high] = spec.length;
    if (lengthInches < low - LENGTH_SLACK || lengthInches > high + LENGTH_SLACK) {
      notes.push(
        `${lengthInches}″ is an unusual length for a ${name}, which is normally ${low}″ to ${high}″.`
      );
    }
  }

  if (ringGauge !== null) {
    const [low, high] = spec.ring;
    if (ringGauge < low - RING_SLACK || ringGauge > high + RING_SLACK) {
      notes.push(
        `Ring ${ringGauge} is unusual for a ${name}, which is normally ${low} to ${high}.`
      );
    }
  }

  return notes;
}
