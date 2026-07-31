import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

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
  status: 'complete' | 'active';
}

export interface YearData {
  id: string;
  year: number;
  status: 'complete' | 'active';
  total_books: number | null;
  books: Book[];
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
    status: y.status === 'complete' ? 'complete' : 'active',
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
    status: yearRow.status === 'complete' ? 'complete' : 'active',
    total_books: yearRow.total_books,
    books: (books ?? []).map(toBook),
  };
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
