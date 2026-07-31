/**
 * Turning a rejected write into something worth reading.
 *
 * The edit routes used to put `writeError.message` straight on the page, so a
 * mistyped date produced `new row for relation "rl_books" violates check
 * constraint "rl_books_dates_ordered"`. The constraint is the honest reason;
 * it is not a sentence.
 *
 * Each form checks these rules before writing, so most of these never fire.
 * They are the backstop for the cases a form cannot catch: a race between two
 * people saving at once, and any rule the database grows that the form has not
 * caught up with. That is the point of keeping them — a new constraint degrades
 * to a plain sentence rather than a raw dump.
 */

/** Constraint name → what to tell the person who tripped it. */
const CONSTRAINTS: Record<string, string> = {
  // Listening Party
  lp_selections_season_id_week_contributor_id_key:
    'That contributor already has a pick for that week.',
  lp_selections_completed_has_album: 'A completed week needs both an album and an artist.',
  lp_selections_week_check: 'The week has to be 1 or more.',
  lp_seasons_workspace_id_slug_key: 'There is already a season with that name.',
  lp_seasons_total_weeks_check: 'A season needs at least one week.',
  lp_contributors_workspace_id_slug_key: 'Someone with that name is already on the roster.',

  // Reading List
  rl_books_year_id_order_read_key:
    'That position in the year is taken — someone may have just added a book. Try again.',
  rl_books_dates_ordered: 'The date started is after the date finished.',
  rl_books_pages_check: 'The page count has to be more than zero.',
  rl_books_title_check: 'A book needs a title.',
  rl_years_workspace_id_year_key: 'That year is already on the list.',

  // Cigar Lounge
  cl_cigars_workspace_id_slug_key: 'There is already an entry with that name and date.',
  cl_smoked_needs_date: 'A smoked cigar needs the date it was smoked.',
  cl_humidor_has_no_date: 'Something in the humidor cannot have a smoked date.',
  cl_smoked_is_singular: 'A smoked entry records a single cigar.',
  cl_acquired_before_smoked: 'It cannot have been smoked before it was acquired.',
  cl_cigars_quantity_check: 'The quantity has to be at least one.',
  cl_cigars_rating_check: 'A rating runs from 0 to 5, in halves.',
};

interface WriteError {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

/**
 * A sentence for a failed write, and a full record of it in the logs.
 *
 * The logging half matters as much as the message: swallowing the original
 * error is how a real fault gets mistaken for a validation problem and goes
 * unnoticed for a week.
 */
export function describeWriteError(error: WriteError, context: string): string {
  console.error(`write failed (${context})`, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });

  const haystack = `${error.message} ${error.details ?? ''}`;
  for (const [name, sentence] of Object.entries(CONSTRAINTS)) {
    if (haystack.includes(name)) return sentence;
  }

  // A row-level security refusal. Reachable when someone's role is downgraded
  // between loading the form and submitting it — the page checked canWrite,
  // the database checked again at the last moment and disagreed.
  if (error.code === '42501' || error.message.includes('row-level security')) {
    return 'You no longer have permission to change this.';
  }

  // A foreign key that points at nothing: the season or year was deleted while
  // the form was open.
  if (error.code === '23503') {
    return 'Something this record belongs to has been deleted. Reload and try again.';
  }

  return 'That could not be saved, so nothing has changed. The problem has been logged.';
}

/**
 * The same, for a delete.
 *
 * Worth its own function for one error code. On an insert, 23503 means the
 * parent is missing; on a delete it means the opposite — something still points
 * at this row and the database will not orphan it. `lp_selections.contributor_id`
 * is ON DELETE RESTRICT exactly so a person cannot be removed out from under
 * their picks, and that refusal deserves an explanation rather than the generic
 * "could not be saved".
 */
/**
 * What to say when a delete removed nothing.
 *
 * A delete blocked by RLS does not raise — the policy filters the row out of
 * the statement's scope, so the delete succeeds against zero rows and returns
 * no error at all. Every delete therefore asks for the removed rows back and
 * checks it actually got one; without that a viewer whose role changed mid
 * session would be told the record was deleted while it sat there untouched.
 */
export const NOTHING_DELETED =
  'Nothing was deleted. It may already be gone, or your access may have changed — reload and check.';

export function describeDeleteError(error: WriteError, context: string): string {
  console.error(`delete failed (${context})`, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });

  if (error.code === '23503') {
    return 'Something still refers to this, so it cannot be deleted yet.';
  }
  if (error.code === '42501' || error.message.includes('row-level security')) {
    return 'You no longer have permission to delete this.';
  }

  return 'That could not be deleted, so nothing has changed. The problem has been logged.';
}
