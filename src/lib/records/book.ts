import { FormValues, invalid, valid, type Parsed } from '../forms';

export const BOOK_FORMATS = ['print', 'audio', 'graphic'] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];

export interface BookValues {
  year_id: string;
  order_read: number;
  title: string;
  author: string;
  pages: number | null;
  year_published: number | null;
  date_started: string | null;
  date_finished: string | null;
  format: BookFormat;
  genre: string;
  publisher: string;
  cover_url: string;
  isbn: string;
  notes: string;
  tags: string[];
  reading: boolean;
  coming_up: boolean;
  link_openlibrary: string;
  link_wikipedia: string;
}

export function readBook(form: FormData): Parsed<BookValues> {
  const f = new FormValues(form);

  const year_id = f.str('year_id');
  const order_read = f.int('order_read');
  const title = f.str('title');
  const date_started = f.date('date_started');
  const date_finished = f.date('date_finished');

  if (!year_id) return invalid('Choose which year this book belongs to.');
  if (!title) return invalid('A book needs a title.');
  if (order_read === null || order_read < 1) {
    return invalid('Give the book a position in the year of 1 or more.');
  }

  // Same rule as rl_books_dates_ordered. ISO dates compare correctly as strings.
  if (date_started && date_finished && date_started > date_finished) {
    return invalid('The date started is after the date finished.');
  }

  const reading = f.bool('reading');
  // Not a database constraint, but the reading list treats a finish date as
  // what makes a book finished — the two together render as both at once.
  if (reading && date_finished) {
    return invalid('This has a date finished, so it is not still being read.');
  }

  return valid({
    year_id,
    order_read,
    title,
    author: f.str('author'),
    pages: f.int('pages'),
    year_published: f.int('year_published'),
    date_started,
    date_finished,
    format: f.choice('format', BOOK_FORMATS, 'print'),
    genre: f.str('genre'),
    // publisher_normalised is filled in by a trigger on write, so the form
    // never sends it and an imprint typed here groups the same way as one
    // fetched from Open Library.
    publisher: f.str('publisher'),
    cover_url: f.str('cover_url'),
    isbn: f.str('isbn'),
    notes: f.str('notes'),
    tags: f.list('tags'),
    reading,
    coming_up: f.bool('coming_up'),
    link_openlibrary: f.str('link_openlibrary'),
    link_wikipedia: f.str('link_wikipedia'),
  });
}
