import type { AppSlug } from '../database.types';

/**
 * The code-side mirror of `ai_features`, the same way lib/apps.ts mirrors the
 * app_slug enum.
 *
 * The database is the authority: it decides whether a feature is enabled, what
 * it may spend and who may run it, and `ai_begin_job` refuses whatever this
 * file believes. What lives here is the part TypeScript needs — the set of
 * valid keys, so a typo in a route is a compile error rather than a GRK12 at
 * runtime — and the human description of what each one is for.
 *
 * Adding a feature means a row and a line here. The line is not optional: a key
 * that exists only in the database cannot be referenced by the code that would
 * use it.
 */

export const FEATURE_KEYS = [
  'wbpr.desk',
  'wbpr.writeup',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type JobClass = 'single' | 'interactive' | 'batch' | 'scheduled';

export interface FeatureNote {
  key: FeatureKey;
  app: AppSlug;
  /** What kind of work it is, which decides how its budget is held. */
  class: JobClass;
  what: string;
}

export const FEATURES: FeatureNote[] = [
  {
    key: 'wbpr.desk',
    app: 'wbpr',
    class: 'interactive',
    what: 'One night at the desk — a turn at a time, paced by the DJ.',
  },
  {
    key: 'wbpr.writeup',
    app: 'wbpr',
    class: 'single',
    what: 'The one call that turns a finished sitting into a broadcast.',
  },
];

const BY_KEY = new Map(FEATURES.map(f => [f.key, f]));

export const featureNote = (key: FeatureKey) => BY_KEY.get(key);

/**
 * The refusals, as sentences.
 *
 * The functions carry their own messages but those name columns and thresholds
 * — useful in a log, wrong on a page. This is the same table `describeGrantError`
 * keeps for the invite and creation codes, and it is deliberately the same
 * mechanism: a caller branches on the SQLSTATE, never on the message text.
 */
export const AI_MESSAGES: Record<string, string> = {
  GRK10: 'Not found.',
  GRK11: 'AI features are switched off across the site at the moment.',
  GRK12: 'That feature is not switched on for this project.',
  GRK13: 'You do not have permission to run that here.',
  GRK14: 'That is a lot of requests at once — give it a minute.',
  GRK15: "This month's AI allowance is spent.",
  GRK16: 'This project has reached its daily AI limit.',
  GRK17: 'That went too many steps deep — nothing was run.',
  // Deliberately not the same sentence as GRK15. The allowance is not spent;
  // the job will not fit inside what is left of it, and the useful next action
  // is to narrow the job rather than to ask for a bigger limit.
  GRK18: 'That job is too large for what is left this month. Narrow it, or wait for the allowance to reset.',
  GRK19: 'That job has run as far as it may.',
  GRK1A: 'That feature has too many prompt versions on record.',
  GRK1B: 'No new AI work is being accepted at the moment.',
  GRK1C: 'No allowed model is configured for that feature.',
};

/**
 * The sentence an editor should see when the owner's allowance runs out.
 *
 * They will read a bare "this month's allowance is spent" as their own, and go
 * looking for a limit they cannot see and could not raise.
 */
export const NOT_MY_ALLOWANCE =
  "The owner's AI allowance for this month is spent, so this could not run.";

export function describeAiError(error: { code?: string; message?: string } | null): string {
  if (!error) return 'Something went wrong.';
  return (error.code && AI_MESSAGES[error.code]) || error.message || 'Something went wrong.';
}
