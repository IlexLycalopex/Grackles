import { FormValues, invalid, valid, type Parsed } from '../forms';
import { parsePrice } from '../cigar-helpers';
import { slugify } from '../slug';

export const CIGAR_STATUSES = ['humidor', 'smoked'] as const;
export type CigarStatus = (typeof CIGAR_STATUSES)[number];

export const STRENGTHS = ['mild', 'medium', 'full'] as const;
export type Strength = (typeof STRENGTHS)[number];

export interface CigarValues {
  status: CigarStatus;
  quantity: number;
  name: string;
  brand: string;
  vitola: string;
  wrapper: string;
  length_text: string;
  ring_gauge: number | null;
  country: string;
  strength: Strength | null;
  bought_at: string;
  smoked_at: string;
  date_acquired: string | null;
  date_smoked: string | null;
  price_text: string;
  price_gbp: number | null;
  price_approximate: boolean;
  rating: number | null;
  pairing: string;
  note: string;
  photo_path: string;
  tasting_notes: string;
}

export function readCigar(form: FormData): Parsed<CigarValues> {
  const f = new FormValues(form);

  const status = f.choice('status', CIGAR_STATUSES, 'smoked');
  const name = f.str('name');
  const quantity = Math.max(1, f.int('quantity') ?? 1);
  const date_smoked = f.date('date_smoked');
  const date_acquired = f.date('date_acquired');

  if (!name) return invalid('A cigar needs a name.');

  // The four CHECK constraints on cl_cigars, in the order they read there.
  if (status === 'smoked' && !date_smoked) {
    return invalid('A smoked cigar needs the date it was smoked — or put it back in the humidor.');
  }
  if (status === 'humidor' && date_smoked) {
    return invalid('This has a date smoked, so its status should be smoked.');
  }
  if (status === 'smoked' && quantity > 1) {
    return invalid('A smoked entry records one cigar. Keep the rest as a humidor entry.');
  }
  if (date_acquired && date_smoked && date_acquired > date_smoked) {
    return invalid('It cannot have been smoked before it was acquired.');
  }

  // Mirrors cl_cigars_photo_path_shape. Checked here so a pasted `www.…` or a
  // filename dragged off the desktop comes back as a sentence rather than as
  // 23514, and there because that is what guarantees it.
  const photo_path = f.str('photo_path');
  if (photo_path && !/^https?:\/\//i.test(photo_path)) {
    return invalid('A photo has to be a link starting http:// or https:// — there is no upload yet.');
  }

  const price = parsePrice(f.str('price_text'));

  return valid({
    status,
    quantity,
    name,
    brand: f.str('brand'),
    vitola: f.str('vitola'),
    wrapper: f.str('wrapper'),
    length_text: f.str('length_text'),
    ring_gauge: f.int('ring_gauge'),
    country: f.str('country'),
    strength: f.optionalChoice('strength', STRENGTHS),
    bought_at: f.str('bought_at'),
    smoked_at: f.str('smoked_at'),
    date_acquired,
    date_smoked,
    // Kept exactly as written ('>£40', '~£25') because that is the honest
    // record, with the parsed figure alongside so the stats page can sum.
    price_text: price?.display ?? '',
    price_gbp: price?.value ?? null,
    price_approximate: price?.approximate ?? false,
    rating: f.dec('rating'),
    pairing: f.str('pairing'),
    note: f.str('note'),
    photo_path,
    tasting_notes: f.str('tasting_notes'),
  });
}

/**
 * The slug for a new entry, following the convention the markdown filenames
 * set: `2026-02-07-hoyo-de-monterrey-epicure-no-2`.
 *
 * Dating it is what keeps the same cigar smoked twice from colliding, so the
 * date used is the one that gives the entry its place — smoked, else acquired,
 * else today.
 */
export function cigarSlug(values: CigarValues, today: string): string {
  const date = values.date_smoked ?? values.date_acquired ?? today;
  return slugify([date, values.brand, values.name].filter(Boolean).join(' '));
}
