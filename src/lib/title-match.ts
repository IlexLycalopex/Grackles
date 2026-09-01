/**
 * Deciding whether a catalogue returned the record somebody asked for.
 *
 * Written for the album lookup, which needed it first, and lifted out when the
 * book lookup needed exactly the same three functions — the same reason
 * `json.ts` exists. A catalogue answers every query with *something*, so the
 * question "is this the thing that was asked for" is the whole difference
 * between filling a blank field and quietly filing the wrong cover against
 * somebody's record.
 *
 * These are heuristics, and heuristics rot silently. They are pinned by
 * `artwork.test.mjs` and `book-lookup.test.mjs` against the cases the imported
 * data actually contains.
 */

/**
 * Down to letters and digits, so punctuation and accents cannot decide a match.
 *
 * `NFD` splits an accented letter into a letter and a combining mark and the
 * range strips the mark, which is what makes *Björk* and *Bjork* the same
 * string — and *Bolaño* and *Bolano*. The ellipsis in "…Grace the Corner of Our
 * Rooms…" goes the same way.
 */
export function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Drops the qualifier a store puts on a title: "(Deluxe Edition)",
 * "[Remastered]", "- 2011 Remaster". The pressing is not the album, and a
 * catalogue rarely holds the one somebody typed.
 *
 * It earns its place on books too, where the same shape appears as
 * "(Penguin Classics)" and "- Revised Edition".
 */
export function stripEdition(title: string): string {
  return title
    .replace(/\s*[\(\[][^\)\]]*[\)\]]\s*$/g, '')
    .replace(/\s+-\s+[^-]*\b(remaster(ed)?|edition|version|reissue|anniversary)\b.*$/i, '')
    .trim();
}

/**
 * Equal, or one a prefix of the other and not by a landslide.
 *
 * The prefix half is what accepts a catalogue's truncated title against a full
 * one. The length guard is what stops "live" matching "live at leeds" — a
 * prefix that throws away more than half the longer string is not the same
 * record, it is a different one that happens to start the same way.
 */
export function looselyEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter) && shorter.length * 2 >= longer.length;
}

/**
 * The author, reduced to something two spellings of one person agree on.
 *
 * A catalogue, a spine and a person typing all render the same author
 * differently — "Ursula K. Le Guin", "Le Guin, Ursula K.", "Ursula Le Guin" —
 * and the library's identity key has to see one author in all three. Two forms
 * are produced because they are wanted for different jobs:
 *
 * - `surname` alone, which is what the *ambiguity* check compares. Loose on
 *   purpose: it is looking for near-misses to show somebody, so over-matching
 *   costs a row on a review screen.
 * - `surname + first initial`, which is what goes in the key. Strict enough
 *   that two authors do not silently become one, loose enough that a middle
 *   name appearing or not appearing does not split a book in two.
 *
 * Both are heuristics over names, which is a domain with no rules, so they are
 * pinned by `supabase/tests/fixtures/work-keys.json` — read by the unit test
 * here and by the SQL test of the trigger that has to agree with it.
 */

/**
 * Name fragments that belong to the surname rather than in front of it.
 *
 * Without these, "Le Guin" folds to "guin" and "van der Rohe" to "rohe" —
 * which would still be consistent, and would still put both spellings of one
 * author together, but it makes the key unreadable in a way that matters the
 * first time somebody is looking at one wondering why two books did not merge.
 */
const PARTICLES = new Set([
  'de', 'del', 'della', 'di', 'da', 'dos', 'das', 'du',
  'van', 'von', 'der', 'den', 'ter', 'ten',
  'la', 'le', 'los', 'las', 'bin', 'ibn', 'al', 'st', 'saint',
]);

/** Suffixes that are not part of anybody's surname. */
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md']);

/**
 * "A & B", "A and B", "A; B" → "A", and the editorial furniture dropped.
 *
 * The same rule `firstAuthor()` in book-lookup.ts applies before searching a
 * catalogue, for the same reason: a joint credit matches nothing as written,
 * and the first name on it is the one both sides will have.
 */
function soleAuthor(author: string): string {
  return author
    .split(/;|&|\band\b|\bwith\b/i)[0]!
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(?:translated|illustrated|edited)\s+by\b.*$/i, '')
    .replace(/\bet\s+al\.?/i, '')
    .trim();
}

interface SplitName {
  surname: string;
  given: string;
}

/**
 * Surname and given names, from a name written either way round.
 *
 * A comma with no conjunction after it is the signal that the name is
 * reversed. That is not universal — "Smith, Jr." exists — which is what the
 * suffix list is for: a comma followed only by a suffix is not a reversal.
 */
function splitName(author: string): SplitName {
  const cleaned = soleAuthor(author);
  if (!cleaned) return { surname: '', given: '' };

  const comma = cleaned.indexOf(',');
  if (comma > 0) {
    const before = cleaned.slice(0, comma).trim();
    const after = cleaned.slice(comma + 1).trim();
    const afterIsSuffix = SUFFIXES.has(normalise(after).replace(/\s+/g, ''));
    if (after && !afterIsSuffix) return { surname: before, given: after };
    return splitTrailing(before);
  }

  return splitTrailing(cleaned);
}

/** A name written forwards: the surname is the last token, plus its particles. */
function splitTrailing(name: string): SplitName {
  const tokens = normalise(name).split(' ').filter(Boolean);
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  if (!tokens.length) return { surname: '', given: '' };

  let start = tokens.length - 1;
  while (start > 0 && PARTICLES.has(tokens[start - 1]!)) start--;

  return {
    surname: tokens.slice(start).join(' '),
    given: tokens.slice(0, start).join(' '),
  };
}

/** The surname alone. Used to look for near-misses, never to decide identity. */
export function authorSurname(author: string): string {
  return normalise(splitName(author).surname);
}

/**
 * Surname and first initial — what identity is actually decided on.
 *
 * The initial is what keeps two authors of one surname apart, and dropping
 * everything after it is what stops a middle name splitting one author in two.
 * An author with no given name at all folds to the surname, which is the right
 * answer for a spine that only had room for one word.
 */
export function authorKey(author: string): string {
  const { surname, given } = splitName(author);
  const folded = normalise(surname);
  if (!folded) return '';
  const initial = normalise(given).charAt(0);
  return initial ? `${folded} ${initial}` : folded;
}
