import { FormValues, invalid, valid, type Parsed } from '../forms';

export const YEAR_STATUSES = ['active', 'complete'] as const;
export type YearStatus = (typeof YEAR_STATUSES)[number];

export interface YearValues {
  year: number;
  status: YearStatus;
  total_books: number | null;
}

export function readYear(form: FormData): Parsed<YearValues> {
  const f = new FormValues(form);

  const year = f.int('year');
  if (year === null) return invalid('Give the year a number.');
  // Wide enough to be no constraint at all in practice, narrow enough to catch
  // a typo like 202 or 20226 before it becomes a page nobody can find.
  if (year < 1900 || year > 2200) return invalid('That does not look like a year.');

  return valid({
    year,
    status: f.choice('status', YEAR_STATUSES, 'active'),
    // Left blank for a year in progress. The overview shows it as a target
    // alongside the running count, so a wrong number is worse than none.
    total_books: f.int('total_books'),
  });
}
