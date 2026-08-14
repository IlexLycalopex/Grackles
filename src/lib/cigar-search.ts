import type { CigarData } from './cigar-lounge';

/**
 * Searching a lounge.
 *
 * This module runs in two places and that is deliberate. The filter box on the
 * log and the humidor imports it into a browser script; the lookup endpoint
 * imports it on the server to search the reference cache. One matcher means a
 * query that finds a cigar in your humidor finds the same cigar in the cache,
 * which is the whole basis of "answer for free before answering for money".
 *
 * So nothing here may touch Supabase, `import.meta.env`, or the DOM. The type
 * import above is erased at build time and is the only dependency.
 */

/** Vulgar fractions, as they appear on a box. Expanded before anything is parsed. */
const FRACTIONS: Record<string, string> = {
  '½': ' 1/2', '¼': ' 1/4', '¾': ' 3/4',
  '⅐': ' 1/7', '⅑': ' 1/9', '⅒': ' 1/10',
  '⅓': ' 1/3', '⅔': ' 2/3',
  '⅕': ' 1/5', '⅖': ' 2/5', '⅗': ' 3/5', '⅘': ' 4/5',
  '⅙': ' 1/6', '⅚': ' 5/6',
  '⅛': ' 1/8', '⅜': ' 3/8', '⅝': ' 5/8', '⅞': ' 7/8',
};

/**
 * The form two pieces of text are compared in: lowercase, unaccented, single
 * spaces.
 *
 * Dropping the accents is the point. Half the cigars worth searching for are
 * Partagás, Padrón, Hoyo de Monterrey or Montecristo No. 2, and nobody reaches
 * for the compose key to find one they already own.
 */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Inches, out of whatever the box said.
 *
 * `length_text` is free text by design — it keeps `4 7/8"` as written rather
 * than rounding it to a decimal nobody printed. That is the right call for
 * display and useless for comparison, so this is the one place the two are
 * reconciled. Millimetres are handled because European boxes use them.
 *
 * Returns null rather than 0 for text carrying no measurement, so "no length
 * recorded" and "zero inches" stay distinguishable.
 */
export function lengthInches(text: string | null | undefined): number | null {
  if (!text) return null;

  let t = text.trim();
  for (const [glyph, expansion] of Object.entries(FRACTIONS)) {
    t = t.replaceAll(glyph, expansion);
  }

  const mm = t.match(/(\d+(?:\.\d+)?)\s*mm\b/i);
  if (mm) return Number(mm[1]) / 25.4;

  // A whole number and a fraction — `4 7/8`. Tried before the plain number
  // below, which would otherwise stop at the 4 and lose the seven eighths.
  const mixed = t.match(/(\d+)\s+(\d+)\s*\/\s*(\d+)/);
  if (mixed && Number(mixed[3]) !== 0) {
    return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  }

  const fraction = t.match(/^\s*(\d+)\s*\/\s*(\d+)/);
  if (fraction && Number(fraction[2]) !== 0) {
    return Number(fraction[1]) / Number(fraction[2]);
  }

  const plain = t.match(/(\d+(?:\.\d+)?)/);
  return plain ? Number(plain[1]) : null;
}

/** How far off a length may be and still count as the size asked for. */
const LENGTH_TOLERANCE = 0.2;

/** How much of a tasting note joins the haystack. See `haystackFor`. */
const NOTE_BUDGET = 300;

export interface Size {
  lengthInches: number | null;
  ringGauge: number | null;
}

/** A `5x50` in a query: either half may be absent. */
export interface SizeTerm {
  length: number | null;
  ring: number | null;
}

export interface Query {
  /** Words, all of which must appear. */
  words: string[];
  /** Dimensions, all of which must match. */
  sizes: SizeTerm[];
  /** True when the query asks nothing, in which case everything matches. */
  empty: boolean;
}

/**
 * A query, read.
 *
 * Words are ANDed rather than ORed: someone typing "hoyo epicure" wants the
 * one cigar that is both, not every Hoyo followed by every Epicure. With a few
 * hundred entries an OR search returns the whole lounge and is no search at
 * all.
 *
 * Dimensions are pulled out as their own kind of term because they cannot be
 * matched as text — `5x50` appears nowhere in a record that stores `5"` in one
 * column and `50` in another, and a substring search for "50" would also find
 * every cigar bought in 1950.
 */
export function parseQuery(raw: string): Query {
  const folded = fold(raw)
    // `5 x 50` and `5×50` become one token, so the split below keeps them whole.
    .replace(/(\d)\s*[x×]\s*(\d)/g, '$1x$2')
    // `rg 50` likewise.
    .replace(/\b(?:rg|ring(?:\s*gauge)?)\s*(\d+)/g, 'rg$1');

  const words: string[] = [];
  const sizes: SizeTerm[] = [];

  for (const token of folded.split(' ').filter(Boolean)) {
    const cross = token.match(/^(\d+(?:\.\d+)?)?x(\d+)$/);
    if (cross) {
      sizes.push({ length: cross[1] ? Number(cross[1]) : null, ring: Number(cross[2]) });
      continue;
    }

    const ring = token.match(/^rg(\d+)$/);
    if (ring) {
      sizes.push({ length: null, ring: Number(ring[1]) });
      continue;
    }

    words.push(token);
  }

  return { words, sizes, empty: words.length === 0 && sizes.length === 0 };
}

/**
 * Does this record answer the query?
 *
 * The haystack is pre-folded — built once when the page renders rather than on
 * every keystroke for every card.
 */
export function matches(haystack: string, size: Size, query: Query): boolean {
  if (query.empty) return true;

  for (const word of query.words) {
    if (!haystack.includes(word)) return false;
  }

  for (const term of query.sizes) {
    // A dimension asked for and not recorded is a miss, not a pass. An entry
    // with no ring gauge cannot be the 50 somebody is looking for.
    if (term.ring !== null && size.ringGauge !== term.ring) return false;
    if (term.length !== null) {
      if (size.lengthInches === null) return false;
      if (Math.abs(size.lengthInches - term.length) > LENGTH_TOLERANCE) return false;
    }
  }

  return true;
}

/**
 * Everything about a cigar worth searching, folded and joined.
 *
 * The tasting note is included but capped: searching for "cedar" and finding
 * the cigar you wrote it about is most of the value of a search box, and this
 * string ships to the browser on every card, so the whole note would be paying
 * page weight for the tail of a paragraph.
 */
export function haystackFor(data: CigarData, note = ''): string {
  return fold(
    [
      data.name,
      data.brand,
      data.vitola,
      data.wrapper,
      data.country,
      data.strength,
      data.boughtAt,
      data.smokedAt,
      data.pairing,
      data.note,
      data.length,
      data.ringGauge ? `rg${data.ringGauge}` : '',
      note.slice(0, NOTE_BUDGET),
    ]
      .filter(Boolean)
      .join(' ')
  );
}

export function sizeOf(data: CigarData): Size {
  return { lengthInches: lengthInches(data.length), ringGauge: data.ringGauge ?? null };
}
