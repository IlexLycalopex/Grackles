import { FormValues, invalid, valid, type Parsed } from '../forms';
import { slugify } from '../slug';

export const SEASON_STATUSES = ['upcoming', 'active', 'complete'] as const;
export type SeasonStatus = (typeof SEASON_STATUSES)[number];

export interface SeasonValues {
  slug: string;
  title: string;
  description: string;
  total_weeks: number;
  status: SeasonStatus;
  sort_order: number;
  /** Contributor ids for lp_season_contributors — a separate table, so kept apart. */
  roster: string[];
}

export function readSeason(form: FormData): Parsed<SeasonValues> {
  const f = new FormValues(form);

  // The slug is the URL: /lp/brothers/2028. Offered as an editable field rather
  // than derived silently, because renaming a season would move a page that
  // people have linked to.
  const slug = slugify(f.str('slug'));
  const title = f.str('title');
  const total_weeks = f.int('total_weeks');

  if (!slug) return invalid('Give the season a short name for its URL, like 2028.');
  if (!title) return invalid('Give the season a title.');
  if (total_weeks === null || total_weeks < 1) return invalid('A season needs at least one week.');

  const roster = f.all('roster');
  if (roster.length === 0) return invalid('Choose at least one person to play this season.');

  return valid({
    slug,
    title,
    description: f.str('description'),
    total_weeks,
    status: f.choice('status', SEASON_STATUSES, 'upcoming'),
    // Seasons sort by this rather than by slug, so 2028 lands after 2027
    // without depending on the name being a number.
    sort_order: f.int('sort_order') ?? 0,
    roster,
  });
}
