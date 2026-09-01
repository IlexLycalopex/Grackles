import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import { YEAR_STATUSES, type YearStatus } from './records/year';

/**
 * Data access for the Reading List.
 *
 * The `Book` shape deliberately keeps the snake_case field names the static
 * site used, so its components port across unchanged. The database columns
 * happen to match, which is not a coincidence — the schema was derived from
 * this interface.
 */

export interface Book {
  id: string;
  title: string;
  author: string;
  year_published: number | null;
  pages: number | null;
  date_started: string | null;
  date_finished: string | null;
  year_read: number;
  /** The rl_years primary key, so the edit form can offer to move a book. */
  year_id: string;
  order_read: number;
  format: 'print' | 'audio' | 'graphic';
  genre: string | null;
  cover_url: string | null;
  publisher: string | null;
  publisher_normalised: string | null;
  description: string | null;
  isbn: string | null;
  tags: string[];
  notes: string | null;
  reading: boolean;
  coming_up: boolean;
  links: { openlibrary: string; wikipedia: string };
}

export interface YearMeta {
  id: string;
  status: YearStatus;
}

export interface YearData {
  id: string;
  year: number;
  status: YearStatus;
  total_books: number | null;
  books: Book[];
}

/**
 * The status column is plain text, so a row can in principle say anything the
 * CHECK constraint has been widened to allow but this build has not heard of.
 * A year that has started is the safe reading of an unknown value: it is the
 * only one of the three that neither hides the year's books from the totals
 * nor claims they were all read.
 */
function toStatus(raw: string | null): YearStatus {
  return (YEAR_STATUSES as readonly string[]).includes(raw ?? '') ? (raw as YearStatus) : 'active';
}

const BOOK_COLUMNS = `
  id, order_read, title, author, pages, date_started, date_finished, format,
  year_published, genre, publisher, publisher_normalised, cover_url, isbn,
  description, tags, notes, reading, coming_up,
  link_openlibrary, link_wikipedia,
  rl_years ( id, year )
`;

function toBook(row: any): Book {
  return {
    id: row.id,
    title: row.title,
    author: row.author ?? '',
    year_published: row.year_published,
    pages: row.pages,
    date_started: row.date_started,
    date_finished: row.date_finished,
    year_read: row.rl_years?.year ?? 0,
    year_id: row.rl_years?.id ?? row.year_id ?? '',
    order_read: row.order_read,
    format: (['print', 'audio', 'graphic'] as const).includes(row.format) ? row.format : 'print',
    genre: row.genre || null,
    cover_url: row.cover_url || null,
    publisher: row.publisher || null,
    publisher_normalised: row.publisher_normalised || null,
    description: row.description || null,
    isbn: row.isbn || null,
    tags: row.tags ?? [],
    notes: row.notes || null,
    reading: row.reading,
    coming_up: row.coming_up,
    links: {
      openlibrary: row.link_openlibrary ?? '',
      wikipedia: row.link_wikipedia ?? '',
    },
  };
}

export async function loadYears(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<YearData[]> {
  const { data } = await supabase
    .from('rl_years')
    .select('id, year, status, total_books')
    .eq('workspace_id', workspaceId)
    .order('year', { ascending: false });

  return (data ?? []).map(y => ({
    id: y.id,
    year: y.year,
    status: toStatus(y.status),
    total_books: y.total_books,
    books: [],
  }));
}

export async function loadYear(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  year: number
): Promise<YearData | null> {
  const { data: yearRow } = await supabase
    .from('rl_years')
    .select('id, year, status, total_books')
    .eq('workspace_id', workspaceId)
    .eq('year', year)
    .maybeSingle();

  if (!yearRow) return null;

  const { data: books } = await supabase
    .from('rl_books')
    .select(BOOK_COLUMNS)
    .eq('year_id', yearRow.id)
    .order('order_read');

  return {
    id: yearRow.id,
    year: yearRow.year,
    status: toStatus(yearRow.status),
    total_books: yearRow.total_books,
    books: (books ?? []).map(toBook),
  };
}

/**
 * The year a page means when nobody said which one.
 *
 * Not simply the newest: years come back newest-first, so once next year exists
 * as a plan it is the newest, and "add a book" would file this evening's book
 * under a year that has not started. The year under way is the one still being
 * read — falling back to the newest year that is at least not a plan, and only
 * then to the newest of all, which is the answer when every year is a plan.
 */
export function currentYear(years: YearData[]): YearData | null {
  return (
    years.find(y => y.status === 'active') ??
    years.find(y => y.status !== 'planning') ??
    years[0] ??
    null
  );
}

export async function loadAllBooks(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<Book[]> {
  const { data } = await supabase
    .from('rl_books')
    .select(BOOK_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('order_read');

  return (data ?? []).map(toBook);
}

export async function loadBook(
  supabase: SupabaseClient<Database>,
  bookId: string
): Promise<Book | null> {
  const { data } = await supabase.from('rl_books').select(BOOK_COLUMNS).eq('id', bookId).maybeSingle();
  return data ? toBook(data) : null;
}

// ── Derived views ───────────────────────────────────────────────────

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface GroupSummary {
  name: string;
  slug: string;
  bookCount: number;
  books: Book[];
  formats: Set<string>;
  years: number[];
}

/** Groups books by author or publisher, biggest group first. */
function groupBy(books: Book[], key: (b: Book) => string | null): GroupSummary[] {
  const map = new Map<string, GroupSummary>();

  for (const book of books) {
    const name = key(book);
    if (!name) continue;
    const slug = slugify(name);
    if (!map.has(slug)) {
      map.set(slug, { name, slug, bookCount: 0, books: [], formats: new Set(), years: [] });
    }
    const entry = map.get(slug)!;
    entry.bookCount++;
    entry.books.push(book);
    entry.formats.add(book.format);
    if (!entry.years.includes(book.year_read)) entry.years.push(book.year_read);
  }

  return [...map.values()].sort((a, b) => b.bookCount - a.bookCount || a.name.localeCompare(b.name));
}

export const groupByAuthor = (books: Book[]) => groupBy(books, b => b.author);

/**
 * Publishers group on the normalised name so imprints of the same house merge,
 * but display the name as written on the book.
 */
export const groupByPublisher = (books: Book[]) =>
  groupBy(books, b => b.publisher_normalised || b.publisher);

export interface ReadingStats {
  totalBooks: number;
  totalPages: number;
  audioCount: number;
  audioPct: number;
}

export function statsFor(books: Book[]): ReadingStats {
  const totalBooks = books.length;
  const totalPages = books.reduce((sum, b) => sum + (b.pages ?? 0), 0);
  const audioCount = books.filter(b => b.format === 'audio').length;
  return {
    totalBooks,
    totalPages,
    audioCount,
    audioPct: totalBooks > 0 ? Math.round((audioCount / totalBooks) * 100) : 0,
  };
}

// ── The target ──────────────────────────────────────────────────────

export interface YearProgress {
  target: number;
  /** Books that count: read, in a year under way — chosen, in one being planned. */
  counted: number;
  /** Books still wanted. Zero once the target is reached, never negative. */
  remaining: number;
  /** 0–100, capped so the bar cannot overflow. `over` is the honest answer. */
  percent: number;
  over: boolean;
  /**
   * Only for a year in progress *right now*: how many books the target implies
   * by today's date, and how far ahead (+) or behind (−) of it the year is.
   * Null for a plan, for a finished year, and for a year left marked in
   * progress after it ended — a pace against a date already passed is noise.
   */
  pace: { expected: number; delta: number } | null;
}

/**
 * How a year stands against its target, or null when it has none.
 *
 * What counts depends on the state of the year, and the difference matters:
 *
 * - A year under way or finished counts books **read**, so anything flagged
 *   `coming_up` is excluded. Counting intentions would let a target be met by
 *   writing a list, which is the one thing a target exists to rule out.
 * - A year being planned counts **every** book in it, because choosing them is
 *   the whole activity. Its books are all `coming_up` by definition, and
 *   excluding them would make every plan read as zero.
 *
 * `today` is a parameter so the pace is testable and does not change meaning
 * between a page render and a test run.
 */
export function yearProgress(
  year: { year: number; status: YearStatus; total_books: number | null },
  books: Book[],
  today = new Date()
): YearProgress | null {
  const target = year.total_books;
  if (target === null || target < 1) return null;

  const counted =
    year.status === 'planning' ? books.length : books.filter(b => !b.coming_up).length;

  return {
    target,
    counted,
    remaining: Math.max(0, target - counted),
    percent: Math.min(100, Math.round((counted / target) * 100)),
    over: counted > target,
    pace: year.status === 'active' && year.year === today.getFullYear()
      ? paceFor(target, counted, today)
      : null,
  };
}

/**
 * The target spread evenly across the year, read at today's date.
 *
 * Deliberately linear. Reading is not evenly paced — a fortnight off does more
 * for the count than a fortnight of work — but a target is a flat number and
 * the only pace that can be checked against it is a flat one. Anything cleverer
 * would be a model of a reading year, and it would be wrong about this one.
 */
function paceFor(target: number, counted: number, today: Date) {
  const start = Date.UTC(today.getFullYear(), 0, 1);
  const end = Date.UTC(today.getFullYear() + 1, 0, 1);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());

  const elapsed = (now - start) / (end - start);
  const expected = Math.round(target * elapsed);
  return { expected, delta: counted - expected };
}


// ── The library ─────────────────────────────────────────────────────

/**
 * A book, as against a reading of one.
 *
 * The two are deliberately separate types even though they share most of their
 * field names: a `Book` has a year and a position in it, and a `LibraryEntry`
 * has an owner and a read state. Merging them into one optional-everything
 * interface would make every page that handles either have to ask which it had.
 */
export interface LibraryEntry {
  id: string;
  title: string;
  author: string;
  series: string;
  series_index: number | null;
  format: 'print' | 'audio' | 'graphic';
  ownership: Ownership;
  /** coalesce(read_override, times_read > 0) — maintained by the database. */
  read: boolean;
  /** Null follows the readings; true is a book read before the log existed. */
  read_override: boolean | null;
  reading: boolean;
  times_read: number;
  last_read_on: string | null;
  year_published: number | null;
  pages: number | null;
  publisher: string | null;
  publisher_normalised: string | null;
  genre: string | null;
  tags: string[];
  isbn: string | null;
  cover_url: string | null;
  description: string | null;
  notes: string | null;
  link_openlibrary: string;
  source: string;
  source_photo: string;
  added_at: string;
}

export const OWNERSHIPS = ['owned', 'wanted', 'released', 'none'] as const;
export type Ownership = (typeof OWNERSHIPS)[number];

/** What each ownership state is called where a person reads it. */
export const OWNERSHIP_LABELS: Record<Ownership, string> = {
  owned: 'On the shelf',
  wanted: 'Wanted',
  released: 'Gone',
  none: 'Never owned',
};

const LIBRARY_COLUMNS = `
  id, title, author, series, series_index, format, ownership,
  read, read_override, reading, times_read, last_read_on,
  year_published, pages, publisher, publisher_normalised, genre, tags,
  isbn, cover_url, description, notes, link_openlibrary,
  source, source_photo, added_at
`;

function toEntry(row: any): LibraryEntry {
  return {
    ...row,
    author: row.author ?? '',
    series: row.series ?? '',
    format: (['print', 'audio', 'graphic'] as const).includes(row.format) ? row.format : 'print',
    ownership: (OWNERSHIPS as readonly string[]).includes(row.ownership)
      ? (row.ownership as Ownership)
      // Same reasoning as toStatus() above: a value this build has not heard of
      // is read as the one that hides nothing and claims nothing.
      : 'owned',
    tags: row.tags ?? [],
    publisher: row.publisher || null,
    genre: row.genre || null,
    isbn: row.isbn || null,
    cover_url: row.cover_url || null,
    description: row.description || null,
    notes: row.notes || null,
    link_openlibrary: row.link_openlibrary ?? '',
    source_photo: row.source_photo ?? '',
  };
}

export async function loadLibrary(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<LibraryEntry[]> {
  const { data } = await supabase
    .from('rl_library')
    .select(LIBRARY_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('author')
    .order('series_index', { nullsFirst: true })
    .order('title');

  return (data ?? []).map(toEntry);
}

export async function loadEntry(
  supabase: SupabaseClient<Database>,
  entryId: string
): Promise<LibraryEntry | null> {
  const { data } = await supabase
    .from('rl_library')
    .select(LIBRARY_COLUMNS)
    .eq('id', entryId)
    .maybeSingle();
  return data ? toEntry(data) : null;
}

export interface LibraryStats {
  total: number;
  owned: number;
  read: number;
  unread: number;
  /** Owned and unread — the pile, and the point of the whole exercise. */
  pile: number;
  pilePages: number;
  wanted: number;
  /** Of what is owned, the proportion still unread. Null when nothing is owned. */
  pilePct: number | null;
}

/**
 * The library in numbers.
 *
 * `pile` is the figure that matters and it is deliberately the intersection
 * rather than either axis alone: books read but not owned are history, and
 * books owned and read are the majority and are not a question. What somebody
 * wants to know is how much of what is on the bookcase is still ahead of them.
 */
export function libraryStats(entries: LibraryEntry[]): LibraryStats {
  const owned = entries.filter(e => e.ownership === 'owned');
  const pile = owned.filter(e => !e.read);
  return {
    total: entries.length,
    owned: owned.length,
    read: entries.filter(e => e.read).length,
    unread: entries.filter(e => !e.read).length,
    pile: pile.length,
    pilePages: pile.reduce((sum, e) => sum + (e.pages ?? 0), 0),
    wanted: entries.filter(e => e.ownership === 'wanted').length,
    pilePct: owned.length ? Math.round((pile.length / owned.length) * 100) : null,
  };
}

/** The distinct values of a field, commonest first, for a filter. */
export function facetsOf(entries: LibraryEntry[], key: (e: LibraryEntry) => string | null): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const value = key(entry);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value);
}
