/**
 * Facts about a book, from somewhere that knows them.
 *
 * The division of labour is the same one the desk uses for its deck: the app
 * fetches what is knowable and the model is told, never asked. A model asked
 * for an ISBN returns a *plausible* ISBN — thirteen digits, right prefix, wrong
 * book — and a reading list is a record somebody keeps.
 *
 * So nothing in this file is generated. It is one request to OpenLibrary and a
 * careful read of what comes back.
 */

const SEARCH = 'https://openlibrary.org/search.json';

/** What OpenLibrary can tell us, with everything it could not left null. */
export interface Edition {
  title: string;
  author: string;
  /** The work key, e.g. /works/OL45804W — the closest thing to a stable id. */
  key: string;
  year_published: number | null;
  pages: number | null;
  publisher: string | null;
  isbn: string | null;
  cover_url: string | null;
  /** OpenLibrary's own subject headings. Raw vocabulary, not ours. */
  subjects: string[];
  link_openlibrary: string;
}

export type Lookup =
  | { ok: true; candidates: Edition[] }
  | { ok: false; reason: string };

const first = <T>(value: T[] | undefined): T | null =>
  Array.isArray(value) && value.length > 0 ? value[0] : null;

/**
 * Up to three candidates for one title and author.
 *
 * Three rather than one because picking between them is the judgement the model
 * is actually for — a title with four editions, one of which is an abridged
 * audiobook, is exactly the case a "take the first result" rule gets wrong and
 * a person spots instantly.
 */
export async function lookupBook(
  title: string,
  author: string,
  signal?: AbortSignal
): Promise<Lookup> {
  const params = new URLSearchParams({
    title,
    limit: '3',
    fields: [
      'key', 'title', 'author_name', 'first_publish_year', 'number_of_pages_median',
      'publisher', 'isbn', 'cover_i', 'subject',
    ].join(','),
  });
  if (author) params.set('author', author);

  let response: Response;
  try {
    response = await fetch(`${SEARCH}?${params}`, {
      signal,
      headers: {
        // OpenLibrary asks for a way to be contacted about heavy use, and a
        // batch of four hundred lookups is heavy use.
        'User-Agent': 'Grackles/0.1 (https://grackles.co.uk)',
        Accept: 'application/json',
      },
    });
  } catch (cause) {
    return { ok: false, reason: `could not reach OpenLibrary: ${String(cause).slice(0, 120)}` };
  }

  if (!response.ok) return { ok: false, reason: `OpenLibrary answered ${response.status}` };

  const payload = await response.json().catch(() => null);
  const docs = payload?.docs;
  if (!Array.isArray(docs) || docs.length === 0) return { ok: true, candidates: [] };

  return { ok: true, candidates: docs.slice(0, 3).map(readDoc) };
}

/**
 * One search result, narrowed.
 *
 * Exported so the fixtures can exercise it without a network. Everything here
 * is defensive in the same way `parseLog` is: this is a third party's JSON and
 * a missing field is normal, not exceptional.
 */
export function readDoc(doc: Record<string, unknown>): Edition {
  const key = String(doc.key ?? '');
  const cover = doc.cover_i;
  const isbns = doc.isbn as string[] | undefined;

  return {
    title: String(doc.title ?? ''),
    author: first(doc.author_name as string[] | undefined) ?? '',
    key,
    year_published: Number.isInteger(doc.first_publish_year)
      ? (doc.first_publish_year as number)
      : null,
    pages: Number.isInteger(doc.number_of_pages_median)
      ? (doc.number_of_pages_median as number)
      : null,
    publisher: first(doc.publisher as string[] | undefined),
    // The thirteen-digit form when there is one: it is the one a barcode
    // carries and the one another catalogue will match on.
    isbn: (isbns ?? []).find(i => i.length === 13) ?? first(isbns) ?? null,
    cover_url: Number.isInteger(cover)
      ? `https://covers.openlibrary.org/b/id/${cover}-L.jpg`
      : null,
    // Capped hard. A popular novel carries hundreds of subject headings, and
    // sending them all would cost more than the answer is worth.
    subjects: Array.isArray(doc.subject) ? (doc.subject as string[]).slice(0, 25) : [],
    link_openlibrary: key ? `https://openlibrary.org${key}` : '',
  };
}

/**
 * Whether a proposal's facts are the ones OpenLibrary gave us.
 *
 * This is the check that makes the whole feature safe: the model is asked to
 * *choose* an edition, not to describe one, so any factual field it returns
 * must be identical to the candidate it picked. A model that improves a page
 * count is a model inventing a page count.
 */
export function factsMatch(
  edition: Edition,
  proposed: { isbn?: string | null; pages?: number | null; year_published?: number | null }
): string[] {
  const wrong: string[] = [];
  if (proposed.isbn && proposed.isbn !== edition.isbn) wrong.push('isbn');
  if (proposed.pages != null && proposed.pages !== edition.pages) wrong.push('pages');
  if (proposed.year_published != null && proposed.year_published !== edition.year_published) {
    wrong.push('year_published');
  }
  return wrong;
}
