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
