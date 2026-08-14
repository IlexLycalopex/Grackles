import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import type { StoredReference } from './cigar-lookup';

/**
 * Data access for the Cigar Lounge.
 *
 * The `Cigar` shape mirrors an Astro content-collection entry — `{ id, data }`
 * with Date objects — so the components port across untouched. That is why the
 * date columns are revived into Dates here rather than left as ISO strings.
 */

export interface CigarData {
  status: 'humidor' | 'smoked';
  quantity: number;
  name: string;
  brand: string;
  vitola: string;
  wrapper?: string;
  length?: string;
  ringGauge?: number;
  country?: string;
  strength?: 'mild' | 'medium' | 'full';
  boughtAt?: string;
  smokedAt?: string;
  dateAcquired?: Date;
  dateSmoked?: Date;
  pricePaid?: string;
  rating?: number;
  pairing?: string;
  note?: string;
  photo?: string;
}

export interface Cigar {
  /** The slug, which is also the URL — carried over from the markdown filename. */
  id: string;
  /** Database primary key, needed for writes. */
  rowId: string;
  data: CigarData;
  /** Tasting notes, formerly the markdown body. */
  body: string;
  /**
   * The reference row this entry was filled from, when it was filled from one.
   *
   * Deliberately not on `data`: that shape is what a person recorded about a
   * cigar, and what a model said is a different kind of thing kept in a
   * different table. Carrying the id rather than the row keeps the join
   * optional — the list pages never want it.
   */
  referenceId: string | null;
}

const COLUMNS = `
  id, slug, status, quantity, name, brand, vitola, wrapper, length_text,
  ring_gauge, country, strength, bought_at, smoked_at, date_acquired,
  date_smoked, price_text, rating, pairing, note, photo_path, tasting_notes,
  reference_id
`;

/** Every column of a reference row. Short enough that narrowing it earns nothing. */
const REFERENCE_COLUMNS = `
  id, key, query, brand, line, name, vitola, length_inches, ring_gauge, wrapper,
  binder, filler, country, factory, strength, flavour, confidence, alternates,
  model, created_at
`;

/** Dates arrive as 'YYYY-MM-DD'; parse as UTC so they do not drift a day west. */
function toDate(value: string | null): Date | undefined {
  return value ? new Date(`${value}T00:00:00Z`) : undefined;
}

function undef(value: string | null): string | undefined {
  return value ? value : undefined;
}

function toCigar(row: any): Cigar {
  return {
    id: row.slug,
    rowId: row.id,
    body: row.tasting_notes ?? '',
    referenceId: row.reference_id ?? null,
    data: {
      status: row.status === 'humidor' ? 'humidor' : 'smoked',
      quantity: row.quantity ?? 1,
      name: row.name,
      brand: row.brand ?? '',
      vitola: row.vitola ?? '',
      wrapper: undef(row.wrapper),
      length: undef(row.length_text),
      ringGauge: row.ring_gauge ?? undefined,
      country: undef(row.country),
      strength: row.strength ?? undefined,
      boughtAt: undef(row.bought_at),
      smokedAt: undef(row.smoked_at),
      dateAcquired: toDate(row.date_acquired),
      dateSmoked: toDate(row.date_smoked),
      pricePaid: undef(row.price_text),
      rating: row.rating ?? undefined,
      pairing: undef(row.pairing),
      note: undef(row.note),
      photo: undef(row.photo_path),
    },
  };
}

export async function loadCigars(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<Cigar[]> {
  const { data } = await supabase.from('cl_cigars').select(COLUMNS).eq('workspace_id', workspaceId);
  return (data ?? []).map(toCigar);
}

/** The log: smoked cigars, newest first. Ties break on name to stay stable. */
export function smokedFrom(cigars: Cigar[]): Cigar[] {
  return cigars
    .filter(c => c.data.status === 'smoked')
    .sort((a, b) => {
      const diff = (b.data.dateSmoked?.getTime() ?? 0) - (a.data.dateSmoked?.getTime() ?? 0);
      return diff !== 0 ? diff : a.data.name.localeCompare(b.data.name);
    });
}

/**
 * The humidor: unsmoked cigars, longest-resting first — the ones that have
 * been waiting longest are the ones you want to see.
 */
export function humidorFrom(cigars: Cigar[]): Cigar[] {
  return cigars
    .filter(c => c.data.status === 'humidor')
    .sort((a, b) => {
      const diff =
        (a.data.dateAcquired?.getTime() ?? Date.now()) - (b.data.dateAcquired?.getTime() ?? Date.now());
      return diff !== 0 ? diff : a.data.name.localeCompare(b.data.name);
    });
}

export async function loadCigar(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  slug: string
): Promise<Cigar | null> {
  const { data } = await supabase
    .from('cl_cigars')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('slug', slug)
    .maybeSingle();

  return data ? toCigar(data) : null;
}

/**
 * One reference row.
 *
 * Read through the caller's client like everything else, so RLS decides — which
 * here means any signed-in reader sees it, because the cache is shared on
 * purpose. A signed-out visitor to a public lounge gets null and the entry
 * simply renders without the block, which is the right outcome: what a model
 * said is working material, not part of the published record.
 */
export async function loadReference(
  supabase: SupabaseClient<Database>,
  id: string
): Promise<StoredReference | null> {
  const { data } = await supabase
    .from('cl_cigar_reference')
    .select(REFERENCE_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  return (data as StoredReference | null) ?? null;
}
