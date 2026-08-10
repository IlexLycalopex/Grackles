/**
 * Filling a book in from Open Library, and from Google Books when it cannot.
 *
 * Every cover in this list arrived with the migration, put there by a script in
 * the old repo (`scripts/fetch-metadata.js`) that ran on every deploy: it swept
 * the YAML for `cover_url: ""` and filled the blanks. Nothing replaced it when
 * the list moved into this app, which is why every book imported has a cover
 * and every book added since has a placeholder.
 *
 * This is that script's knowledge, moved to where a book is actually entered.
 * The differences follow from the setting rather than from taste: a deploy hook
 * sweeping a whole year can afford half a second between calls and three
 * retries; a person waiting on a button press cannot, so this makes at most two
 * requests and gives up quickly. What is kept is everything the old script
 * learned the hard way about these two APIs — see the notes at each call.
 *
 * Two rules shape the whole file.
 *
 * **It only ever fills blanks.** A lookup never overwrites something typed, so
 * the button is safe to press twice, and safe on a book that already exists —
 * it tops up what is missing instead of replacing the record with a stranger's
 * idea of it.
 *
 * **What comes back is a suggestion, not a fact.** These APIs index works, and
 * a work has many editions. So this fetches into the form and stops, leaving a
 * person looking at the values before anything is written, and names the fields
 * it filled so they know where to look.
 */

const OPEN_LIBRARY = 'https://openlibrary.org/search.json';
const GOOGLE_BOOKS = 'https://www.googleapis.com/books/v1/volumes';

/** Long enough for a slow answer, short enough that nobody wonders. */
const TIMEOUT_MS = 6000;

export interface BookDetails {
  title: string;
  author: string;
  year_published: number | null;
  pages: number | null;
  publisher: string;
  genre: string;
  isbn: string;
  cover_url: string;
  link_openlibrary: string;
}

type Partial_ = Partial<BookDetails>;

// ── Cleaning up what gets asked ─────────────────────────────────────

/**
 * "Chew Vol 9 Chicken Tenders" → "Chew Chicken Tenders".
 *
 * Straight from the old script. Neither API indexes a graphic novel under its
 * volume number, so searching the title as written finds nothing — and this
 * list has a lot of them.
 */
function cleanTitle(title: string): string {
  const m = title.match(/^(.+?)\s+Vol(?:ume)?\s+\d+\s*(.*)/i);
  if (!m) return title;
  const [, series, subtitle] = m;
  return subtitle?.trim() ? `${series!.trim()} ${subtitle.trim()}` : series!.trim();
}

/** "A & B", "A and B", "A; B" → "A". A joint credit matches nothing as written. */
function firstAuthor(author: string): string {
  return author.split(/;|&|\band\b/)[0]!.trim();
}

/**
 * Open Library asks that automated callers identify themselves and rate-limits
 * the ones that do not. The same string the artwork lookup sends, because it is
 * the same application from the other end.
 */
const USER_AGENT = 'Grackles/1.0 (+https://grackles.co.uk)';

/**
 * One JSON GET, with a timeout, that reports failure by *throwing*.
 *
 * `artwork.ts` has the same helper returning null, and the difference is not an
 * oversight: that lookup runs inside a save nobody is watching, so a failure has
 * nowhere to go but the log. This one runs because somebody pressed a button and
 * is waiting for an answer, so "could not reach it" and "there is no such book"
 * have to stay distinguishable all the way up to the sentence they read.
 */
async function getJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  // Parsed from text rather than response.json(), the same way the artwork
  // lookup does it: not every one of these endpoints labels its JSON as JSON in
  // every runtime, and text parses the same either way.
  return JSON.parse(await response.text());
}

// ── Open Library ────────────────────────────────────────────────────

/** The 13-digit form when it is on offer, because that is what a modern book carries. */
function pickIsbn(isbns: string[] | undefined): string {
  if (!isbns?.length) return '';
  return isbns.find(i => i.replace(/[^0-9X]/gi, '').length === 13) ?? isbns[0] ?? '';
}

async function searchOpenLibrary(
  title: string,
  author: string,
  isbn: string
): Promise<Partial_ | null> {
  const params = new URLSearchParams({
    // Five, not one. The first hit for a title is regularly a reprint or a
    // study guide with no artwork, and a result with a cover is worth more
    // than a result that merely came first — the old script learned this and
    // so the pick below is deliberate.
    limit: '5',
    fields: 'key,title,author_name,first_publish_year,number_of_pages_median,publisher,subject,isbn,cover_i',
  });

  // An ISBN identifies one edition, so it beats a title matched against every
  // book of that name.
  if (isbn) params.set('isbn', isbn.replace(/[^0-9Xx]/g, ''));
  else {
    params.set('title', title);
    if (author) params.set('author', author);
  }

  const body = await getJson(`${OPEN_LIBRARY}?${params}`);
  const docs: any[] = body.docs ?? [];
  const doc = docs.find(d => d.cover_i) ?? docs[0];
  if (!doc) return null;

  return {
    title: doc.title ?? '',
    author: doc.author_name?.[0] ?? '',
    year_published: doc.first_publish_year ?? null,
    // A median across editions, which is why the notice says so.
    pages: doc.number_of_pages_median ?? null,
    publisher: doc.publisher?.[0] ?? '',
    genre: doc.subject?.slice(0, 2).join(', ') ?? '',
    isbn: pickIsbn(doc.isbn),
    // Built from the cover id, never from the ISBN. The ISBN route answers with
    // a blank image rather than a 404 unless asked otherwise, which lands in the
    // column as a cover that is not there; a cover id only exists when the
    // picture does.
    cover_url: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : '',
    link_openlibrary: doc.key ? `https://openlibrary.org${doc.key}` : '',
  };
}

// ── Google Books ────────────────────────────────────────────────────

/**
 * The fallback, and the reason a handful of covers in this list are served by
 * Google rather than Open Library.
 *
 * Only called when Open Library produced no cover, which is the one thing it
 * is reliably better at supplying. The API key is optional — without it the
 * request still works, on a shared quota — so a missing key degrades the same
 * way a missing RESEND_API_KEY does rather than breaking the button.
 */
async function searchGoogleBooks(
  title: string,
  author: string,
  isbn: string
): Promise<Partial_ | null> {
  const q = isbn ? `isbn:${isbn.replace(/[^0-9Xx]/g, '')}` : `intitle:${title} inauthor:${author}`;
  // Optional chained: import.meta.env is Vite's, and is absent when this module
  // is exercised outside a build. A missing key is a supported case anyway.
  const key = import.meta.env?.GOOGLE_BOOKS_API_KEY;
  const params = new URLSearchParams({ q });
  if (key) params.set('key', key);

  const body = await getJson(`${GOOGLE_BOOKS}?${params}`);
  const items: any[] = body.items ?? [];
  const info = (items.find(i => i.volumeInfo?.imageLinks?.thumbnail) ?? items[0])?.volumeInfo;
  if (!info) return null;

  return {
    title: info.title ?? '',
    author: info.authors?.[0] ?? '',
    // publishedDate is "2022" or "2022-09-13"; the leading year is what we want.
    year_published: info.publishedDate ? Number.parseInt(info.publishedDate, 10) || null : null,
    // Edition-specific and exact, unlike Open Library's median.
    pages: info.pageCount ?? null,
    publisher: info.publisher ?? '',
    genre: info.categories?.[0] ?? '',
    isbn: '',
    // Google still hands these out as http:// on an https:// page, where the
    // browser blocks them as mixed content and the cover silently fails to load.
    cover_url: info.imageLinks?.thumbnail?.replace(/^http:/, 'https:') ?? '',
    link_openlibrary: '',
  };
}

// ── Putting the two together ────────────────────────────────────────

const EMPTY: BookDetails = {
  title: '',
  author: '',
  year_published: null,
  pages: null,
  publisher: '',
  genre: '',
  isbn: '',
  cover_url: '',
  link_openlibrary: '',
};

export interface Lookup {
  details: BookDetails;
  /** Whether the page count is Open Library's median, so the notice can warn. */
  pagesAreMedian: boolean;
}

/**
 * Ask both sources, Open Library first. Null means neither had anything; it
 * throws only when neither could be reached.
 */
export async function lookupBook(query: {
  title: string;
  author: string;
  isbn: string;
}): Promise<Lookup | null> {
  const title = cleanTitle(query.title);
  const author = firstAuthor(query.author);

  let primary: Partial_ | null = null;
  let primaryFailed = false;

  try {
    primary = await searchOpenLibrary(title, author, query.isbn);
  } catch (error) {
    console.error('open library lookup failed', error);
    primaryFailed = true;
  }

  // Google is asked only for what Open Library could not give, which is
  // usually the cover — the one field this whole feature exists for.
  let fallback: Partial_ | null = null;
  if (!primary?.cover_url) {
    try {
      fallback = await searchGoogleBooks(title, author, query.isbn || primary?.isbn || '');
    } catch (error) {
      console.error('google books lookup failed', error);
      if (primaryFailed) throw error;
    }
  }

  if (!primary && !fallback) {
    if (primaryFailed) throw new Error('both lookups failed');
    return null;
  }

  const details = { ...EMPTY };
  for (const key of Object.keys(EMPTY) as (keyof BookDetails)[]) {
    const chosen = primary?.[key] || fallback?.[key] || EMPTY[key];
    (details as any)[key] = chosen;
  }

  return { details, pagesAreMedian: Boolean(primary?.pages) && details.pages === primary?.pages };
}

// ── Into the form ───────────────────────────────────────────────────

/** What each filled field is called when the page reports back. */
const LABELS: Record<keyof BookDetails, string> = {
  title: 'title',
  author: 'author',
  year_published: 'year published',
  pages: 'pages',
  publisher: 'publisher',
  genre: 'genre',
  isbn: 'ISBN',
  cover_url: 'cover',
  link_openlibrary: 'Open Library link',
};

function sentence(parts: string[]): string {
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Look a book up and fill the blanks of a submitted form in place, returning
 * one sentence about what happened.
 *
 * The form is what gets edited because it is already what the fields render
 * from — a page that has just failed to save shows what was typed, and this
 * arrives through the same door. Nothing is written to the database here; the
 * person still has to press Save.
 */
export async function fillFromLookup(form: FormData): Promise<string> {
  const title = String(form.get('title') ?? '').trim();
  const author = String(form.get('author') ?? '').trim();
  const isbn = String(form.get('isbn') ?? '').trim();

  if (!title && !isbn) return 'Give it a title or an ISBN first, then fetch.';

  let found: Lookup | null;
  try {
    found = await lookupBook({ title, author, isbn });
  } catch {
    // Both sources are already logged where they failed.
    return 'Neither Open Library nor Google Books could be reached, so nothing has changed. Fill the fields in by hand, or try again.';
  }

  if (!found) return `Nothing found for ${isbn ? `ISBN ${isbn}` : `“${title}”`}.`;

  const filled: string[] = [];
  for (const [key, value] of Object.entries(found.details) as [
    keyof BookDetails,
    string | number | null,
  ][]) {
    if (value === null || value === '') continue;
    // The rule the whole file turns on: what is already there wins.
    if (String(form.get(key) ?? '').trim() !== '') continue;
    form.set(key, String(value));
    filled.push(LABELS[key]);
  }

  if (filled.length === 0) {
    return 'Found it, but every field it could fill already has something in it.';
  }

  // The caveat is only worth the words when the field it is about was filled
  // from the source that estimates it.
  const caveat =
    filled.includes(LABELS.pages) && found.pagesAreMedian
      ? ' — check them before saving; the page count is a median across editions.'
      : ' — check them before saving.';

  return `Filled in ${sentence(filled)}${caveat}`;
}
