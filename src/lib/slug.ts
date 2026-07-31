/**
 * Slugs for records created through the app.
 *
 * Deliberately separate from the `slugify` in `listening-party.ts` and
 * `reading-list.ts`. Those two derive *display* URLs from artist and author
 * names on every render, and they disagree with each other — the Listening
 * Party's drops accented letters entirely, so Rokia Traoré is `rokia-traor`.
 * Both are wrong in the abstract and both are load-bearing: changing either
 * would move live URLs that already exist in the wild.
 *
 * This one is only ever used to mint a slug that is then stored, so it can be
 * the sensible version without breaking anything.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A slug not already in `taken`, suffixed `-2`, `-3`… if it has to be.
 *
 * The unique index is still the thing that guarantees uniqueness; this only
 * spares someone an error message for the ordinary case of smoking the same
 * cigar twice in a day. Two simultaneous inserts can still collide, and the
 * database will say so.
 */
export function uniqueSlug(desired: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(desired) || 'entry';
  if (!used.has(base)) return base;

  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
