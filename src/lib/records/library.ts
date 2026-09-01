import { FormValues, invalid, valid, type Parsed } from '../forms';
import { BOOK_FORMATS, type BookFormat } from './book';
import { OWNERSHIPS, type Ownership } from '../reading-list';

/**
 * Reading a library entry out of a form.
 *
 * Beside records/book.ts and deliberately not merged with it: a reading has a
 * year and a position, a book has an owner and a read state, and the one field
 * they both appear to have — the title — belongs to the book. The book form
 * sends it; the reading form no longer does, because a trigger mirrors it down.
 */

export interface LibraryValues {
  title: string;
  author: string;
  series: string;
  series_index: number | null;
  format: BookFormat;
  ownership: Ownership;
  /**
   * Three states, and the form has to be able to say all three: null hands the
   * question back to the readings, true and false override them. A checkbox
   * cannot express that, so this arrives as a select.
   */
  read_override: boolean | null;
  year_published: number | null;
  pages: number | null;
  publisher: string;
  genre: string;
  tags: string[];
  isbn: string;
  cover_url: string;
  description: string;
  notes: string;
  link_openlibrary: string;
}

export const READ_CHOICES = ['auto', 'read', 'unread'] as const;

export function readLibraryEntry(form: FormData): Parsed<LibraryValues> {
  const f = new FormValues(form);

  const title = f.str('title');
  if (!title) return invalid('A book needs a title.');

  const pages = f.int('pages');
  if (pages !== null && pages < 1) return invalid('The page count has to be more than zero.');

  const seriesIndex = f.int('series_index');
  if (seriesIndex !== null && seriesIndex < 0) {
    return invalid('A volume number cannot be negative.');
  }

  const choice = f.choice('read_state', READ_CHOICES, 'auto');

  return valid({
    title,
    author: f.str('author'),
    series: f.str('series'),
    series_index: seriesIndex,
    format: f.choice('format', BOOK_FORMATS, 'print'),
    ownership: f.choice('ownership', OWNERSHIPS, 'owned'),
    read_override: choice === 'auto' ? null : choice === 'read',
    year_published: f.int('year_published'),
    pages,
    // publisher_normalised is filled in by a trigger on write, the same as on a
    // reading, so an imprint typed here groups with one fetched from a
    // catalogue.
    publisher: f.str('publisher'),
    genre: f.str('genre'),
    tags: f.list('tags'),
    isbn: f.str('isbn'),
    cover_url: f.str('cover_url'),
    description: f.str('description'),
    notes: f.str('notes'),
    link_openlibrary: f.str('link_openlibrary'),
  });
}

/** Which of the three the stored value means, for rendering the select. */
export const readChoiceOf = (override: boolean | null): (typeof READ_CHOICES)[number] =>
  override === null ? 'auto' : override ? 'read' : 'unread';
