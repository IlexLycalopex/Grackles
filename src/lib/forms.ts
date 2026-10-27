/**
 * Reading values out of a submitted form.
 *
 * Every write route used to open with its own `str()`, `dateOrNull()` and
 * `numOrNull()` — three near-copies that had already started to drift (one
 * treated a checkbox as `=== 'on'`, which breaks the moment a checkbox is given
 * a value). These are the one set, so a field behaves identically whether it is
 * being created or corrected.
 */
export class FormValues {
  // Written out rather than declared as a constructor parameter property. The
  // test runner strips types rather than compiling them (`--experimental-strip-
  // types`), and a parameter property is the one piece of TypeScript that
  // cannot be stripped — it emits an assignment. The shorthand made every
  // module that imports this one, which is every record reader in the repo,
  // impossible to unit test.
  private readonly form: FormData;

  constructor(form: FormData) {
    this.form = form;
  }

  /** Trimmed text. Absent and blank are the same thing. */
  str(key: string): string {
    return String(this.form.get(key) ?? '').trim();
  }

  /** A whole number, or null when the field was left empty. */
  int(key: string): number | null {
    const raw = this.str(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  /** A decimal, or null when the field was left empty. */
  dec(key: string): number | null {
    const raw = this.str(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * An ISO date, or null. A cleared `<input type="date">` submits an empty
   * string, which has to become NULL — a date column rejects ''.
   */
  date(key: string): string | null {
    return this.str(key) || null;
  }

  /** An unchecked checkbox submits nothing at all, so presence is the answer. */
  bool(key: string): boolean {
    return this.form.get(key) !== null;
  }

  /** Comma-separated text into a trimmed array, blanks dropped. */
  list(key: string): string[] {
    return this.str(key)
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
  }

  /** One of a fixed set, falling back when the value is not recognised. */
  choice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const raw = this.str(key) as T;
    return allowed.includes(raw) ? raw : fallback;
  }

  /** Like choice(), but "none" is a legitimate answer and becomes null. */
  optionalChoice<T extends string>(key: string, allowed: readonly T[]): T | null {
    const raw = this.str(key) as T;
    return allowed.includes(raw) ? raw : null;
  }

  /** Every value for a repeated field — a checkbox group, a multi-select. */
  all(key: string): string[] {
    return this.form
      .getAll(key)
      .map(v => String(v).trim())
      .filter(Boolean);
  }
}

/**
 * The result of reading a form: either a row ready to write, or one sentence
 * explaining what to fix.
 *
 * Validation stops at the first problem rather than collecting every one. With
 * forms this small that is the kinder behaviour — a single clear instruction
 * beats a list — and it keeps each record module to a readable run of guards.
 */
export type Parsed<T> = { ok: true; values: T } | { ok: false; error: string };

export const valid = <T>(values: T): Parsed<T> => ({ ok: true, values });
export const invalid = (error: string): Parsed<never> => ({ ok: false, error });

/**
 * What a field should show, given three possible sources.
 *
 * A form is rendered in three situations and they have to be told apart: it is
 * new (show the default), it is editing something (show what is stored), or a
 * save was just rejected (show what they typed, not what is in the database —
 * otherwise correcting one mistake silently discards every other change they
 * made). Passing the submitted FormData through is what makes the third case
 * work, and doing it here means each field gets it right without the page
 * having to think about it.
 */
export function fieldValue(
  submitted: FormData | null,
  key: string,
  stored: string | number | null | undefined,
  fallback: string | number = ''
): string {
  if (submitted) return String(submitted.get(key) ?? '');
  if (stored === null || stored === undefined) return String(fallback);
  return String(stored);
}

/** The same, for a checkbox — where "absent" is the value, not an omission. */
export function fieldChecked(
  submitted: FormData | null,
  key: string,
  stored: boolean | undefined
): boolean {
  return submitted ? submitted.get(key) !== null : (stored ?? false);
}

/** The same, for one box of a checkbox group. */
export function fieldInGroup(
  submitted: FormData | null,
  key: string,
  value: string,
  stored: string[]
): boolean {
  return submitted ? submitted.getAll(key).includes(value) : stored.includes(value);
}

/**
 * The first of these link fields holding something other than a web address,
 * as a sentence to show — or null when they are all blank or http(s).
 *
 * Every stored link is rendered as an `href`, so a value like `javascript:…`
 * saved by one editor would run in whoever clicked it next, signed in as them.
 * The database refuses the same values (`*_shape` constraints), because an
 * editor can write to these tables without going through this form; this is
 * what turns that refusal into a sentence.
 */
export function badLink(values: Record<string, unknown>, labels: Record<string, string>): string | null {
  for (const [key, label] of Object.entries(labels)) {
    const value = String(values[key] ?? '');
    if (value && !/^https?:\/\//i.test(value)) {
      return `${label} has to be a web address starting http:// or https://.`;
    }
  }
  return null;
}

/**
 * A Spotify link as the Android app shares it — `intent://album/<id>#Intent;…`
 * — turned into the web address it stands for. Anything else is returned as
 * it came, for badLink() to judge.
 */
export function spotifyWebLink(raw: string): string {
  const m = raw.match(/^intent:\/\/(album|track|artist|playlist)\/([A-Za-z0-9]+)/);
  return m ? `https://open.spotify.com/${m[1]}/${m[2]}` : raw;
}
