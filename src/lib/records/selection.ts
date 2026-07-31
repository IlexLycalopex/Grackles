import { FormValues, invalid, valid, type Parsed } from '../forms';

export const SELECTION_STATUSES = ['upcoming', 'completed'] as const;
export type SelectionStatus = (typeof SELECTION_STATUSES)[number];

/**
 * A week's pick, as the form describes it.
 *
 * Shared by `pick/new` and `pick/[selection]`, which is the whole point: the
 * two routes read the same fields, enforce the same rules and produce the same
 * shape, so a column added here reaches both at once.
 */
export interface SelectionValues {
  season_id: string;
  contributor_id: string;
  week: number;
  year_slot: number;
  album: string;
  artist: string;
  status: SelectionStatus;
  notes: string;
  link_wikipedia: string;
  link_spotify: string;
  link_youtube: string;
  artwork_url: string;
}

export function readSelection(form: FormData): Parsed<SelectionValues> {
  const f = new FormValues(form);

  const season_id = f.str('season_id');
  const contributor_id = f.str('contributor_id');
  const week = f.int('week');
  const year_slot = f.int('year_slot');
  const album = f.str('album');
  const artist = f.str('artist');
  const status = f.choice('status', SELECTION_STATUSES, 'upcoming');

  if (!season_id) return invalid('Choose which season this belongs to.');
  if (!contributor_id) return invalid('Choose whose pick this is.');
  if (week === null || week < 1) return invalid('Give the week a number of 1 or more.');
  if (year_slot === null) return invalid('Give the year this album stands for.');

  // Mirrors lp_selections_completed_has_album. Checked here so the answer is a
  // sentence; the constraint is still what guarantees it.
  if (status === 'completed' && (!album || !artist)) {
    return invalid('A completed week needs both an album and an artist.');
  }

  return valid({
    season_id,
    contributor_id,
    week,
    year_slot,
    album,
    artist,
    status,
    notes: f.str('notes'),
    link_wikipedia: f.str('link_wikipedia'),
    link_spotify: f.str('link_spotify'),
    link_youtube: f.str('link_youtube'),
    // Clearing the artwork URL is how you ask for it to be looked up again,
    // exactly as it was in the YAML.
    artwork_url: f.str('artwork_url'),
  });
}
