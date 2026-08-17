import type { Cigar, CigarStatus } from './cigar-lounge';
export type { Cigar };

/**
 * The page an entry belongs on, given its status.
 *
 * Every write route ends by sending somebody back to where the thing they
 * just changed now lives, and each of them used to spell that out as a
 * ternary over two statuses. Three is where a ternary stops reading, and more
 * to the point it is where four copies of one rule start disagreeing.
 */
export function homeFor(base: string, status: CigarStatus): string {
  if (status === 'wishlist') return `${base}/wishlist`;
  if (status === 'humidor') return `${base}/humidor`;
  return base;
}

/** Whole days between a date and now, or null when there is no date. */
export function daysSince(from: Date | undefined, now = new Date()): number | null {
  if (!from) return null;
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000));
}

/** Whole days a humidor cigar has been resting, or null if the date is unknown. */
export function restingDays(cigar: Cigar, now = new Date()): number | null {
  return daysSince(cigar.data.dateAcquired, now);
}

/** "3 years", "5 months", "12 days" — one unit, rounded down. */
export function formatDuration(days: number): string {
  const units: [number, string][] = [
    [365, 'year'],
    [30, 'month'],
    [1, 'day'],
  ];
  for (const [size, label] of units) {
    const n = Math.floor(days / size);
    if (n >= 1) return `${n} ${label}${n === 1 ? '' : 's'}`;
  }
  return 'today';
}

/**
 * Where a cigar's photo lives.
 *
 * A stored photo is an absolute URL — the form takes one and
 * cl_cigars_photo_path_shape enforces it — so there is nothing to resolve.
 * This used to fall back to treating a bare value as a path under the site
 * root, which is how photos worked when entries were markdown files with the
 * images committed beside them. Nothing has resolved that way since the move
 * to the database, and the constraint now rules it out.
 */
export function photoUrl(photo: string): string {
  return photo;
}

/**
 * Build a URL inside a workspace. The base is passed in rather than held in
 * module state: this runs on a server handling concurrent requests for
 * different workspaces, and shared mutable state would let them race.
 */
export function url(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export interface ParsedPrice {
  /** The figure to use in sums, or null if none could be read. */
  value: number | null;
  /** True when the source was a band or estimate (">£40", "~£25") rather than exact. */
  approximate: boolean;
  /** The original text, for display. */
  display: string;
}

/**
 * Prices are free text so bands survive as written. Pull a number out where
 * one exists, and remember whether it was exact — the stats page says so
 * rather than presenting an estimate as a total.
 */
export function parsePrice(raw: string | number | undefined): ParsedPrice | null {
  if (raw === undefined) return null;

  if (typeof raw === 'number') {
    return { value: raw, approximate: false, display: formatGBP(raw) };
  }

  const text = raw.trim();
  if (!text) return null;

  const approximate = /[>~<≈]|approx|about|around|over|under|\bc\.\s/i.test(text);
  const match = text.match(/\d+(?:[.,]\d+)?/);
  const value = match ? Number(match[0].replace(',', '')) : null;

  return { value: Number.isFinite(value) ? value : null, approximate, display: text };
}

export function formatGBP(p: number): string {
  return `£${p.toFixed(2)}`;
}

export interface SpendSummary {
  total: number;
  average: number;
  /** How many entries contributed a figure. */
  counted: number;
  /** True if any contributing figure was a band or estimate. */
  approximate: boolean;
}

/**
 * `pricePaid` is per cigar, so spend multiplies by quantity — a no-op for
 * smoked entries, which are always 1. `counted` is entries with a readable
 * price; `average` is the mean unit price, not the mean per entry.
 */
export function spendSummary(cigars: Cigar[]): SpendSummary {
  const priced = cigars
    .map((c) => ({ price: parsePrice(c.data.pricePaid), quantity: quantityOf(c) }))
    .filter(
      (p): p is { price: ParsedPrice; quantity: number } =>
        p.price !== null && p.price.value !== null
    );

  const total = priced.reduce((sum, p) => sum + (p.price.value ?? 0) * p.quantity, 0);
  const units = priced.reduce((sum, p) => sum + p.quantity, 0);
  return {
    total,
    average: units ? total / units : 0,
    counted: priced.length,
    approximate: priced.some((p) => p.price.approximate),
  };
}

/** How many cigars this entry stands for. Absent means one. */
export function quantityOf(cigar: Cigar): number {
  return cigar.data.quantity ?? 1;
}

/** Total cigars across entries, counting quantities. */
export function totalCigars(cigars: Cigar[]): number {
  return cigars.reduce((sum, c) => sum + quantityOf(c), 0);
}

/** Entries carrying a rating. Unrated ones are excluded from every average. */
export function rated(cigars: Cigar[]): Cigar[] {
  return cigars.filter((c) => c.data.rating !== undefined);
}

export interface BrandStat {
  brand: string;
  count: number;
  /** Null when no entry for the brand has been rated. */
  averageRating: number | null;
  ratedCount: number;
}

/** One row per brand, with count and mean rating over its rated entries. */
export function brandStats(cigars: Cigar[]): BrandStat[] {
  const byBrand = new Map<string, Cigar[]>();
  for (const cigar of cigars) {
    const list = byBrand.get(cigar.data.brand) ?? [];
    list.push(cigar);
    byBrand.set(cigar.data.brand, list);
  }

  return Array.from(byBrand, ([brand, list]) => {
    const ratings = rated(list).map((c) => c.data.rating!);
    return {
      brand,
      count: list.length,
      averageRating: ratings.length ? mean(ratings) : null,
      ratedCount: ratings.length,
    };
  });
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Counts for every half-star bucket from 0 to 5, low to high. */
export function ratingDistribution(cigars: Cigar[]): { rating: number; count: number }[] {
  const buckets = new Map<number, number>();
  for (let r = 0; r <= 5; r += 0.5) buckets.set(r, 0);
  for (const cigar of rated(cigars)) {
    const r = cigar.data.rating!;
    buckets.set(r, (buckets.get(r) ?? 0) + 1);
  }
  return Array.from(buckets, ([rating, count]) => ({ rating, count }));
}

/**
 * Sorted, de-duplicated values of a frontmatter field — for filter dropdowns.
 * Entries missing the field are simply absent from the list.
 */
export function facetValues(cigars: Cigar[], field: 'brand' | 'boughtAt' | 'smokedAt'): string[] {
  const values = cigars.map((c) => c.data[field]).filter((v): v is string => Boolean(v));
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

/** "4 7/8\" · RG 50" — whichever of the two is present. */
export function formatSize(length?: string, ringGauge?: number): string | null {
  const parts = [length, ringGauge ? `RG ${ringGauge}` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
