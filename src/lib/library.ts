import { authorKey, authorSurname, normalise, stripEdition } from './title-match.ts';

/**
 * What counts as the same book.
 *
 * One question with one answer, because four things downstream depend on
 * getting the same answer from it: the unique index that makes one-row-per-book
 * a property of the database rather than a promise, the import's verdicts, the
 * "you already own this" warning at a bookshop, and the backfill that turns a
 * reading list into a library.
 *
 * This file is the TypeScript half. The other half is `app.rl_work_key()` in
 * the schema, which is the authority — a title corrected by hand has to update
 * the key, and a value the form is trusted to send is a value the form can
 * forget to send. What lives here is used to *propose* matches before anything
 * is written, so that the review screen can show somebody a duplicate rather
 * than the database refusing one.
 *
 * Two implementations of one rule will drift. Three things hold them together:
 * the fixture at `supabase/tests/fixtures/work-keys.json`, which the unit test
 * and the SQL test both read; the design, in which a fold that disagrees
 * produces a refused insert rather than a duplicate row; and the fact that
 * neither half is allowed to be cleverer than the other. Resist improving one.
 */

/**
 * The volume number, pulled out of a title that carries it.
 *
 * This is the difference between a key and a lookup, and it is the single most
 * consequential line in the file. `cleanTitle()` in book-lookup.ts strips the
 * volume *and throws it away*, because neither catalogue indexes a graphic
 * novel under its volume number and searching for one finds nothing. Doing that
 * here would fold every volume of Chew onto one row and quietly delete a run of
 * a series from the library. So the number is taken out of the title and put
 * back into the key.
 *
 * Only the unambiguous markers. "Part 1" and "Book of Three" are titles;
 * "Vol. 9", "#3" and "Book 4" are positions.
 */
const VOLUME_PATTERNS: RegExp[] = [
  /\b(?:vol|volume)s?\.?\s*(\d{1,3})\b/i,
  /(?:^|[\s,])#\s*(\d{1,3})\b/,
  /[,:]?\s*\bbook\s+(\d{1,3})\s*$/i,
];

export interface TitleParts {
  /** The title with any volume marker taken out. */
  title: string;
  /** The volume, when the title carried one. */
  index: number | null;
}

export function splitVolume(title: string): TitleParts {
  for (const pattern of VOLUME_PATTERNS) {
    const match = title.match(pattern);
    if (match) {
      return {
        title: title.replace(pattern, ' ').replace(/\s{2,}/g, ' ').trim(),
        index: Number(match[1]),
      };
    }
  }
  return { title, index: null };
}

/**
 * The title, folded.
 *
 * `stripEdition` first, so "(Penguin Classics)" and "- Revised Edition" do not
 * make a second book. The leading article is deliberately *kept*: "The Trial"
 * and "Trial" stay two keys, and are caught instead by the ambiguity check
 * below, where a person decides. That is the wrong way round for tidiness and
 * the right way round for safety — a missed merge is a visible duplicate, and a
 * wrong merge is a book that has quietly become a different book.
 */
export function foldTitle(title: string): string {
  return normalise(stripEdition(splitVolume(title).title));
}

/**
 * The identity of a book, as one string.
 *
 * `series_index` is passed separately because the library has a column for it
 * and the import may supply it; when it is absent, the title is asked. Taking
 * the column when there is one and the title otherwise is what makes "Chew Vol
 * 9" and a row that says Chew with index 9 the same book.
 */
export function workKey(title: string, author: string, seriesIndex?: number | null): string {
  const parts = splitVolume(title);
  const index = seriesIndex ?? parts.index;
  const folded = normalise(stripEdition(parts.title));
  const volume = index === null || index === undefined ? '' : `#${index}`;
  return `${folded}${volume}|${authorKey(author)}`;
}

/** A book, as much of one as any of the four callers needs to compare. */
export interface Identifiable {
  title: string;
  author: string;
  series_index?: number | null;
}

export const keyOf = (book: Identifiable): string =>
  workKey(book.title, book.author, book.series_index ?? null);

/**
 * Two books that are not the same by the key, but close enough to ask about.
 *
 * Everything this returns true for goes in front of a person; nothing it
 * returns true for is ever merged automatically. So it is deliberately looser
 * than the key on both halves — surname without the initial, titles that are a
 * prefix of one another, and the leading article ignored — because the cost of
 * catching too much is one line on a review screen.
 *
 * Two rules it is *not* loose about, both from the spec and both load-bearing:
 * an empty author never matches on the title alone, since Blindness, Ghosts and
 * The Trial are each the title of several unrelated books; and two rows with
 * different volume numbers are different books however alike their titles.
 */
export function looksLikeSameBook(a: Identifiable, b: Identifiable): boolean {
  if (keyOf(a) === keyOf(b)) return false; // the same book, not a near-miss

  const surnameA = authorSurname(a.author);
  const surnameB = authorSurname(b.author);
  if (!surnameA || !surnameB) return false;
  if (surnameA !== surnameB) return false;

  const volA = a.series_index ?? splitVolume(a.title).index;
  const volB = b.series_index ?? splitVolume(b.title).index;
  if (volA !== null && volB !== null && volA !== volB) return false;

  return sharesTitleStem(article(a.title), article(b.title));
}

/** The folded title with a leading article dropped — for comparison only. */
const article = (title: string): string =>
  foldTitle(title).replace(/^(?:the|a|an) /, '');

/**
 * One title is the start of the other, at a word boundary.
 *
 * Deliberately not `looselyEqual`, which is the obvious thing to reach for and
 * is wrong here. That function guards against a prefix throwing away more than
 * half the longer string, because it was written to decide whether a catalogue
 * returned the record somebody asked for — where "live" matching "live at
 * leeds" is a wrong cover on somebody's record. This is the opposite job: the
 * subtitle case it has to catch is exactly the one that guard rejects, since
 * "The Dispossessed" against "The Dispossessed: An Ambiguous Utopia" is a
 * prefix that discards two thirds of the longer title.
 *
 * What makes dropping the guard safe is that this is never reached until the
 * author surnames have already matched, and that nothing here decides anything
 * — it puts two rows next to each other on a review screen. The four-character
 * floor is all that is left of the guard, and it is there so a one-word stub
 * does not drag in everything an author wrote.
 */
function sharesTitleStem(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 4) return false;
  return longer.startsWith(`${shorter} `);
}

/**
 * What a person typing in a filter box is looking for.
 *
 * The same shape as `matches()` in cigar-search.ts and for the same reason: the
 * library page and the picker on the add form both need it, and a matcher that
 * exists twice is one that will answer the same query two ways. Every word has
 * to appear somewhere, so "le guin dispossessed" narrows rather than widens.
 */
export function matchesQuery(haystack: string, query: string): boolean {
  const words = normalise(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = normalise(haystack);
  return words.every(word => hay.includes(word));
}

/**
 * Everything about an entry worth searching, as one string.
 *
 * Nullable rather than optional on every field but the title, because that is
 * how the columns come back from Postgres — an absent genre is `null`, not
 * missing — and a signature that only accepted `undefined` would make every
 * caller launder the row first.
 */
export const searchableText = (entry: {
  title: string;
  author?: string | null;
  series?: string | null;
  genre?: string | null;
  publisher?: string | null;
  tags?: string[] | null;
  isbn?: string | null;
}): string =>
  [
    entry.title,
    entry.author ?? '',
    entry.series ?? '',
    entry.genre ?? '',
    entry.publisher ?? '',
    (entry.tags ?? []).join(' '),
    entry.isbn ?? '',
  ].join(' ');
