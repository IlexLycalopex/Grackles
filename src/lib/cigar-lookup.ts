import type { ChatMessage } from './ai/provider';
import { oneOf, oneOfOrNull, parseJsonObject } from './json';
import { fold, lengthInches, matches, parseQuery, type Query } from './cigar-search';
import { STRENGTHS, type Strength } from './records/cigar';
import { slugify } from './slug';

/**
 * Asking a model what a cigar is.
 *
 * The division of labour is the one `wbpr-agent.ts` already argues for: send
 * the model what only it knows, and never what the app knows or can check. So
 * it is not asked for a slug, a date, an echo of the query, or anything about
 * the workspace — and it is not asked for a score.
 *
 * That last one is a decision rather than an oversight. A Cigar Aficionado
 * rating is a specific integer attributed to a real magazine for a specific
 * vitola in a specific issue, and a model asked for one returns a *plausible*
 * number with no signal that it invented it — the same failure as asking it to
 * roll a d6, but printed under somebody else's masthead. Dimensions, wrapper,
 * origin and flavour profile are what it is actually good for, and are most of
 * what makes filling a form from a lookup worth doing.
 */

/** How much of a reply is allowed. A ceiling on cost, not just on length. */
export const LOOKUP_BUDGET = 400;

/**
 * Low, because this is recall rather than invention. It also makes two people
 * asking about one cigar more likely to produce one canonical key, which is
 * the difference between one cached row and two.
 */
export const LOOKUP_TEMPERATURE = 0.2;

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/**
 * The system prompt, and it is the whole of the instruction.
 *
 * Byte-identical on every call, which is the point: the schema and the rules
 * are about 400 tokens and the query is under twenty, so putting the schema
 * here rather than in the user turn costs the same tokens once and gives a
 * provider-side prefix cache something to hold. There is no conversation — a
 * lookup is one system message and one user message, and unlike a night at the
 * desk there is no history worth paying to carry.
 */
export const LOOKUP_SYSTEM = `You identify cigars. The user gives a brand, a name, a size, or a fragment of one. You answer with JSON and nothing else — no prose, no code fence, no explanation.

{
  "brand": "Partagás",
  "line": "Serie D",
  "name": "Serie D No. 4",
  "vitola": "Robusto",
  "length_inches": 4.9,
  "ring_gauge": 50,
  "wrapper": "Cuban",
  "binder": "Cuban",
  "filler": "Cuban",
  "country": "Cuba",
  "factory": null,
  "strength": "full",
  "flavour": "Earth, cocoa and black pepper over a leathery finish.",
  "confidence": "high",
  "alternates": ["Partagás Serie E No. 2"]
}

RULES.

Every field may be null, and null is the right answer whenever you do not specifically know. A field you omit is a field the app leaves for the user to fill in; a field you guess is a wrong record they will not know to correct. Prefer null.

"brand" is the marque. "line" is the series within it, or null when there is none. "name" is what is printed on the band or the box.

"length_inches" is a decimal number of inches. "ring_gauge" is the ring gauge in sixty-fourths of an inch, a whole number. Give both or neither for a named vitola; if you know the vitola name but not its measurements for this particular marque, both are null.

"strength" is exactly one of "mild", "medium", "full", or null.

"flavour" is the profile as it is commonly described. Two sentences at most. Not a review, not a score, not a recommendation.

"confidence" is "high" for a specific cigar you know, "medium" when you are confident about the marque and less so about this vitola, "low" when you are reasoning from the brand alone.

"alternates" is at most two other cigars the query might have meant, by full name only, and only when it is genuinely ambiguous. Otherwise an empty list. Never put the cigar you have just described in it.

Do not invent a cigar. If the query matches nothing you know of, every field is null, confidence is "low", and alternates may suggest what was meant.

Never give a rating, a score, a number out of 100, a price, or an award, and never attribute anything to a magazine, a reviewer or a publication. If the user asks for one, answer the rest and leave it out. This is not a matter of formatting: a score you produce would be indistinguishable from one you remembered.`;

/** What the model is asked, in full. One system message, one user message. */
export function lookupMessages(query: string): ChatMessage[] {
  return [
    { role: 'system', content: LOOKUP_SYSTEM },
    { role: 'user', content: query },
  ];
}

/** What the model may say. Every field optional, because every field may be null. */
interface RawLookup {
  brand?: unknown;
  line?: unknown;
  name?: unknown;
  vitola?: unknown;
  length_inches?: unknown;
  ring_gauge?: unknown;
  wrapper?: unknown;
  binder?: unknown;
  filler?: unknown;
  country?: unknown;
  factory?: unknown;
  strength?: unknown;
  flavour?: unknown;
  confidence?: unknown;
  alternates?: unknown;
}

/** What the app will store and show, once every claim has been through a sieve. */
export interface CigarReference {
  brand: string;
  line: string;
  name: string;
  vitola: string;
  length_inches: number | null;
  ring_gauge: number | null;
  wrapper: string;
  binder: string;
  filler: string;
  country: string;
  factory: string;
  strength: Strength | null;
  flavour: string;
  confidence: Confidence;
  alternates: string[];
}

/** Caps, so a model having a long day cannot write a long row. */
const SHORT = 120;
const FLAVOUR = 500;

const text = (value: unknown, cap = SHORT): string =>
  typeof value === 'string' ? value.trim().slice(0, cap) : '';

/**
 * A number inside the range the physical world allows, or null.
 *
 * The bounds are the cheapest hallucination filter available and they cost
 * nothing: no cigar is fourteen inches long or has a ring gauge of 200, so a
 * reply carrying one is wrong in a way that can be caught without asking
 * anybody. The same bounds are CHECK constraints on the table, because this is
 * the courtesy and that is the guarantee.
 */
const bounded = (value: unknown, low: number, high: number, whole = false): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < low || n > high) return null;
  return whole ? Math.round(n) : n;
};

/**
 * The model's answer, sieved.
 *
 * Returns null when nothing usable came back — a reply with neither a brand nor
 * a name has not identified anything, and caching it would mean the next person
 * asking the same question gets the same nothing for free instead of a second
 * chance at an answer.
 */
export function readLookup(content: string): CigarReference | null {
  const raw = parseJsonObject<RawLookup>(content);
  if (!raw) return null;

  const brand = text(raw.brand);
  const name = text(raw.name);
  if (!brand && !name) return null;

  return {
    brand,
    line: text(raw.line),
    name,
    vitola: text(raw.vitola),
    length_inches: bounded(raw.length_inches, 1, 12),
    ring_gauge: bounded(raw.ring_gauge, 20, 90, true),
    wrapper: text(raw.wrapper),
    binder: text(raw.binder),
    filler: text(raw.filler),
    country: text(raw.country),
    factory: text(raw.factory),
    strength: oneOfOrNull(raw.strength, STRENGTHS),
    flavour: text(raw.flavour, FLAVOUR),
    confidence: oneOf(raw.confidence, CONFIDENCES, 'low'),
    alternates: Array.isArray(raw.alternates)
      ? raw.alternates
          .map(a => text(a))
          .filter(Boolean)
          // Its own name in its own alternates would offer a second lookup that
          // returns the row you are already reading.
          .filter(a => fold(a) !== fold([brand, name].filter(Boolean).join(' ')))
          .slice(0, 2)
      : [],
  };
}

/**
 * The key two askings of the same question have to agree on.
 *
 * Derived from the answer rather than the question, which is the only way it
 * can be stable: "partagas serie d 4" and "Partagás Serie D No.4" are the same
 * cigar and share nothing as strings. The ring gauge is in it because a marque
 * sells one name in several sizes and they are different cigars — a Montecristo
 * No. 2 is not a Montecristo No. 4.
 */
export function referenceKey(reference: {
  brand: string;
  name: string;
  ring_gauge: number | null;
}): string {
  const stem = slugify([reference.brand, reference.name].filter(Boolean).join(' '));
  return reference.ring_gauge ? `${stem}-${reference.ring_gauge}` : stem;
}

/**
 * A reference row as it comes back out of the database.
 *
 * The provenance columns are on it because they are the point: a row is a claim
 * somebody's lookup produced, and a page showing one has to be able to say when
 * it was produced, by which model, and how sure it said it was.
 */
export interface StoredReference extends CigarReference {
  id: string;
  key: string;
  query: string;
  model: string;
  created_at: string;
}

/** One field where the entry and the lookup do not agree. */
export interface Disagreement {
  label: string;
  /** What the entry records. */
  yours: string;
  /** What the lookup claims. */
  looked: string;
}

/**
 * Where an entry and the reference it was filled from have drifted apart.
 *
 * Only fields where *both* have something to say: a blank on either side is not
 * a disagreement, it is an absence, and reporting it would bury the two or
 * three real ones under a list of things nobody filled in.
 *
 * Nothing is corrected. You have the cigar in front of you and the model does
 * not, so where the two differ the interesting fact is simply that they do —
 * and it is as likely to mean the lookup was wrong as that you typed the wrong
 * thing.
 */
export function compareToEntry(
  reference: Pick<
    StoredReference,
    'brand' | 'vitola' | 'wrapper' | 'country' | 'strength' | 'ring_gauge' | 'length_inches'
  >,
  entry: {
    brand?: string;
    vitola?: string;
    wrapper?: string;
    country?: string;
    strength?: string;
    ringGauge?: number;
    length?: string;
  }
): Disagreement[] {
  const out: Disagreement[] = [];

  const text = (label: string, yours: string | undefined, looked: string) => {
    if (!yours || !looked) return;
    if (fold(yours) === fold(looked)) return;
    out.push({ label, yours, looked });
  };

  text('Brand', entry.brand, reference.brand);
  text('Vitola', entry.vitola, reference.vitola);
  text('Wrapper', entry.wrapper, reference.wrapper);
  text('Country', entry.country, reference.country);
  text('Strength', entry.strength, reference.strength ?? '');

  if (entry.ringGauge && reference.ring_gauge && entry.ringGauge !== reference.ring_gauge) {
    out.push({ label: 'Ring gauge', yours: String(entry.ringGauge), looked: String(reference.ring_gauge) });
  }

  // Compared as numbers, so `4 7/8"` and 4.875 agree rather than differing as
  // strings. The tolerance is the search box's, for the same reason: a marque
  // that rounds 4.9 to 5 on the box has not contradicted anybody.
  const yourLength = lengthInches(entry.length);
  if (yourLength !== null && reference.length_inches !== null) {
    if (Math.abs(yourLength - reference.length_inches) > 0.2) {
      out.push({
        label: 'Length',
        yours: entry.length ?? String(yourLength),
        looked: `${reference.length_inches}″`,
      });
    }
  }

  return out;
}

/** The searchable text of a cached row, in the same form a cigar card carries. */
export function referenceHaystack(row: {
  brand: string;
  line: string;
  name: string;
  vitola: string;
  wrapper: string;
  country: string;
  ring_gauge: number | null;
}): string {
  return fold(
    [
      row.brand,
      row.line,
      row.name,
      row.vitola,
      row.wrapper,
      row.country,
      row.ring_gauge ? `rg${row.ring_gauge}` : '',
    ]
      .filter(Boolean)
      .join(' ')
  );
}

export interface CachedRow {
  id: string;
  key: string;
  brand: string;
  line: string;
  name: string;
  vitola: string;
  length_inches: number | null;
  ring_gauge: number | null;
  wrapper: string;
  country: string;
}

/**
 * The best cached row for a query, or null.
 *
 * The same matcher the filter box runs, against rows the database narrowed
 * first. Ties break on the shorter name: a query for "montecristo no 2" that
 * matches both it and some "Montecristo No. 2 Edición Limitada" means the plain
 * one, because every word of the longer name that the query did not ask for is
 * a way it is less likely to be what was meant.
 */
export function bestCached(rows: CachedRow[], query: Query): CachedRow | null {
  const hits = rows.filter(row =>
    matches(
      referenceHaystack(row),
      { lengthInches: row.length_inches, ringGauge: row.ring_gauge },
      query
    )
  );

  if (hits.length === 0) return null;

  return hits.reduce((best, row) =>
    `${row.brand} ${row.name}`.length < `${best.brand} ${best.name}`.length ? row : best
  );
}

/**
 * The words worth handing to Postgres to narrow on.
 *
 * Longest first, and only the first few: an ilike per term is a scan per term,
 * and the terms that discriminate are the long ones. "no", "de" and "el" narrow
 * nothing and appear in half the marques in Havana.
 *
 * Stripped to letters and digits, which matters for a reason beyond tidiness.
 * These are interpolated into a PostgREST `or=(…)` string, a comma-and-bracket
 * grammar with no placeholders — a query containing either would not be an
 * injection so much as a filter that silently means something else. Punctuation
 * costs nothing to lose here because the real matching is done by `bestCached`
 * against the rows this brings back; narrowing only has to be roughly right.
 */
export function narrowingTerms(query: Query, limit = 3): string[] {
  return [...query.words]
    .map(word => word.replace(/[^a-z0-9]/g, ''))
    .filter(word => word.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, limit);
}

export { parseQuery };
