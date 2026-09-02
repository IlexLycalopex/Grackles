import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBook, type BookValues } from './book.ts';
import { finishedReading, yearProgress, type Book } from '../reading-list.ts';

/**
 * What makes a reading finished, on both sides of the form.
 *
 * The rule exists three times — `app.rl_reading_finished()` in the schema,
 * `finishedReading()` in lib/reading-list.ts, and the coherence checks in
 * readBook() that stop a form saying two of the three states at once — and the
 * one it replaced lived in a date column. These tests are here so the version
 * that got it wrong cannot come back quietly: a reading with no dates at all is
 * a finished reading, because that is how eight years of this list were logged.
 */

const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const base = { year_id: 'a-year', order_read: '1', title: 'The Living Mountain' };

const ok = (fields: Record<string, string>): BookValues => {
  const r = readBook(form({ ...base, ...fields }));
  assert.equal(r.ok, true, r.ok ? '' : `refused: ${r.error}`);
  return r.ok ? r.values : (undefined as never);
};

const refused = (fields: Record<string, string>): string => {
  const r = readBook(form({ ...base, ...fields }));
  assert.equal(r.ok, false, 'expected a refusal');
  return r.ok ? (undefined as never) : r.error;
};

// ── the rule ────────────────────────────────────────────────────────

const reading = (state: Partial<Book> = {}): Book =>
  ({ reading: false, coming_up: false, abandoned: false, ...state }) as Book;

test('a reading with no dates at all is finished', () => {
  assert.equal(finishedReading(reading()), true);
});

test('the three states are what say a reading did not finish', () => {
  assert.equal(finishedReading(reading({ reading: true })), false);
  assert.equal(finishedReading(reading({ coming_up: true })), false);
  assert.equal(finishedReading(reading({ abandoned: true })), false);
});

test('a year of undated readings counts towards its target', () => {
  const books = [reading(), reading(), reading()];
  const progress = yearProgress({ year: 2025, status: 'complete', total_books: 3 }, books);
  assert.equal(progress?.counted, 3);
  assert.equal(progress?.percent, 100);
});

test('a year counts what was read, not what is in hand or lined up', () => {
  const books = [reading(), reading({ reading: true }), reading({ coming_up: true }), reading({ abandoned: true })];
  const progress = yearProgress({ year: 2026, status: 'active', total_books: 4 }, books);
  assert.equal(progress?.counted, 1);
});

test('a year being planned counts everything in it', () => {
  const books = [reading({ coming_up: true }), reading({ coming_up: true })];
  const progress = yearProgress({ year: 2027, status: 'planning', total_books: 2 }, books);
  assert.equal(progress?.counted, 2);
});

// ── the form ────────────────────────────────────────────────────────

test('a book with no dates is a book read', () => {
  const values = ok({});
  assert.equal(values.date_started, null);
  assert.equal(values.date_finished, null);
  assert.equal(values.reading, false);
  assert.equal(values.coming_up, false);
  assert.equal(values.abandoned, false);
});

test('a book given up on is not also in hand', () => {
  const error = refused({ abandoned: 'on', reading: 'on' });
  assert.match(error, /still reading/);
});

test('a book given up on is not also coming up', () => {
  refused({ abandoned: 'on', coming_up: 'on' });
});

test('a book given up on cannot carry a finish date', () => {
  // The same rule as rl_books_abandoned_alone: a finish date is the half of
  // that pair which is believed, so the checkbox is the mistake.
  const error = refused({ abandoned: 'on', date_finished: '2026-01-04' });
  assert.match(error, /given up on/);
});

test('a book coming up cannot carry a finish date', () => {
  refused({ coming_up: 'on', date_finished: '2026-01-04' });
});

test('a book in hand cannot carry a finish date', () => {
  refused({ reading: 'on', date_finished: '2026-01-04' });
});
