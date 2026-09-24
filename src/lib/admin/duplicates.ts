/**
 * Accounts that are probably the same person.
 *
 * Somebody signs in with one address, is later invited at another, and ends up
 * with two accounts that look unrelated in any list sorted by name. Nothing in
 * the database can know they are the same person, so this only suggests it,
 * and the console says "may be" rather than acting on it.
 *
 * The test is deliberately narrow — the same letters in the part before the @,
 * or every word of one address appearing inside the other ("watts.nick" and
 * "nickgwatts") — because a false alarm on a list of a handful of people is
 * worse than a miss the admin would have spotted anyway.
 */

export interface Account {
  id: string;
  email: string;
  display_name: string | null;
}

const localPart = (email: string) => email.split('@')[0]?.toLowerCase() ?? '';
const letters = (s: string) => s.replace(/[^a-z]/g, '');
const words = (s: string) => s.split(/[^a-z]+/).filter(w => w.length >= 3);

export function looksLikeSamePerson(a: Account, b: Account): boolean {
  if (a.id === b.id) return false;

  const la = localPart(a.email);
  const lb = localPart(b.email);
  if (letters(la) && letters(la) === letters(lb)) return true;

  // Two words at least: a single short word ("tom") appears inside too many
  // unrelated addresses to mean anything.
  const inside = (from: string, into: string) => {
    const w = words(from);
    return w.length >= 2 && w.every(x => letters(into).includes(x));
  };
  if (inside(la, lb) || inside(lb, la)) return true;

  const na = (a.display_name ?? '').trim().toLowerCase();
  const nb = (b.display_name ?? '').trim().toLowerCase();
  return na.length > 0 && na === nb;
}

/** Each account's likely twins, keyed by id. Accounts with none are absent. */
export function findDuplicates<T extends Account>(people: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const a of people) {
    const twins = people.filter(b => looksLikeSamePerson(a, b));
    if (twins.length) out.set(a.id, twins);
  }
  return out;
}
