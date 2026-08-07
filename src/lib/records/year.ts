import { FormValues, invalid, valid, type Parsed } from '../forms';

/**
 * The three states a year can be in, oldest-first in the sense that a year
 * moves through them in this order. `planning` exists so next year's list can
 * be built while this year is still being read — see the migration
 * `20260807090000_reading_year_planning.sql` for why it is not just `active`.
 */
export const YEAR_STATUSES = ['planning', 'active', 'complete'] as const;
export type YearStatus = (typeof YEAR_STATUSES)[number];

export const YEAR_STATUS_LABELS: Record<YearStatus, string> = {
  planning: 'In planning',
  active: 'In progress',
  complete: 'Complete',
};

export interface YearValues {
  year: number;
  status: YearStatus;
  total_books: number | null;
}

/**
 * What a year should be created as, given the year it is for.
 *
 * A year after this one has not started, so it is being planned. This is only
 * the default the form opens on — the status is a field like any other and can
 * be set to anything.
 */
export function defaultStatusFor(year: number, today = new Date()): YearStatus {
  return year > today.getFullYear() ? 'planning' : 'active';
}

export function readYear(form: FormData): Parsed<YearValues> {
  const f = new FormValues(form);

  const year = f.int('year');
  if (year === null) return invalid('Give the year a number.');
  // Wide enough to be no constraint at all in practice, narrow enough to catch
  // a typo like 202 or 20226 before it becomes a page nobody can find.
  if (year < 1900 || year > 2200) return invalid('That does not look like a year.');

  // Left blank means "not counting", which is different from a target of zero:
  // zero is a target the year meets before it starts, and every reading of it
  // downstream — the bar, the pace, "so many still to choose" — is nonsense.
  const total_books = f.int('total_books');
  if (total_books !== null && total_books < 1) {
    return invalid('A target is one book or more. Leave it blank if you are not counting.');
  }

  return valid({
    year,
    status: f.choice('status', YEAR_STATUSES, defaultStatusFor(year)),
    total_books,
  });
}
