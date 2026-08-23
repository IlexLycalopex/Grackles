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
 * Whether a catalogue's credit is the one that was asked for.
 *
 * Looser than the title test, and deliberately loose in both directions,
 * because the field on the other end holds more than a name. A store credits
 * features and collaborations in it — "DJ Shadow" has to match "DJ Shadow & Cut
 * Chemist" — and a library credits translators and illustrators the same way,
 * so "Italo Calvino" has to match "Italo Calvino, William Weaver". The reverse
 * happens just as often on the way in: somebody types both names of a
 * co-authored book, and the catalogue lists one of them.
 *
 * Both sides are expected already `normalise()`d, the same as `looselyEqual`.
 * A missing credit on either side is not a match — a result with nobody against
 * it is a result this cannot check, and unchecked is what the caller asked to
 * avoid.
 */
export function creditMatches(got: string, want: string): boolean {
  if (!got || !want) return false;
  return looselyEqual(got, want) || got.includes(want) || want.includes(got);
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
