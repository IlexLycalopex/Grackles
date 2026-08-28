import type { APIRoute } from 'astro';
import type { Database } from '../../../lib/database.types';

export const prerender = false;

/**
 * What a person did with a proposal.
 *
 * This is the quality ledger, and it is the reason the propose-then-confirm
 * discipline is worth keeping: what somebody did with an answer is the best
 * evaluation available and it costs a column. Accepted verbatim, accepted after
 * editing, or thrown away — and the edit distance, because a proposal that was
 * rewritten before saving is not the same event as one saved as offered.
 *
 * Accepting is also the only place an enrichment reaches rl_books. The batch
 * writes proposals and nothing else, so a wrong answer is a row somebody
 * declines rather than a record somebody has to repair.
 */

/**
 * How much of the proposal survived, as a count of fields the person changed.
 *
 * Not a character distance: the fields are short and categorical, and "they
 * changed the genre" is the fact worth trending. A character measure over a
 * tag list would mostly report how long the tags were.
 */
function fieldsChanged(proposed: Record<string, unknown>, applied: Record<string, unknown>): number {
  let changed = 0;
  for (const key of Object.keys(proposed)) {
    if (JSON.stringify(proposed[key]) !== JSON.stringify(applied[key])) changed += 1;
  }
  return changed;
}

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const { supabase, user } = locals;
  if (!user) return new Response('Sign in first.', { status: 401 });

  const form = await request.formData();
  const id = String(form.get('proposal_id') ?? '');
  const outcome = String(form.get('outcome') ?? '');
  const next = String(form.get('next') ?? '/dashboard');

  if (!id || !['accepted', 'discarded'].includes(outcome)) {
    return new Response('Nothing to decide.', { status: 400 });
  }

  // Read through the caller's client, so RLS has already decided whether this
  // proposal is theirs to act on. There is no second ownership check to write.
  const { data: proposal } = await supabase
    .from('ai_proposals')
    .select('id, workspace_id, target_table, target_id, proposed, outcome')
    .eq('id', id)
    .maybeSingle();

  if (!proposal) return new Response('Not found.', { status: 404 });
  if (proposal.outcome) return new Response('Already decided.', { status: 409 });

  let recorded: 'accepted' | 'edited' | 'discarded' = 'discarded';
  let changed = 0;

  if (outcome === 'accepted') {
    const payload = (proposal.proposed ?? {}) as { fields?: Record<string, unknown> };
    const fields = payload.fields ?? {};

    // The person may have untick individual fields on the review page. What
    // they left ticked is what gets written, and the difference is the signal.
    //
    // No fallback for an empty set. An earlier version treated "nothing ticked"
    // as "no preference expressed" and wrote everything — so unticking every
    // box saved every field, which is the exact opposite of what unticking
    // every box means. An unchecked checkbox submits nothing; that is the
    // whole of the ambiguity, and the form always renders them.
    const keep = new Set(form.getAll('field').map(String));
    const applied = Object.fromEntries(
      Object.entries(fields).filter(([key]) => keep.has(key))
    );

    if (Object.keys(applied).length === 0) {
      return new Response('Nothing was ticked.', { status: 400 });
    }

    // Two tables now, and the allowlist is written out rather than trusted from
    // the row: target_table decides which table an update is aimed at, and a
    // value that arrived from anywhere but this app's own enqueue must not be
    // able to point it somewhere new.
    const table = proposal.target_table === 'rl_library' ? 'rl_library'
      : proposal.target_table === 'rl_books' ? 'rl_books'
      : null;

    if (!table || !proposal.target_id) {
      return new Response('That proposal has nowhere to go.', { status: 400 });
    }

    // Asks for the row back and checks it got one, for the same reason every
    // delete in this app does: a write refused by row-level security does not
    // raise, it narrows the statement to zero rows and reports success.
    //
    // Written as two branches rather than one call against a union of tables.
    // Every field an enrichment proposes exists on both, so a single call would
    // work at runtime — but its argument type is the *intersection*, which
    // requires `never` for every column the two do not share, and the cast that
    // silences that would also silence a real mistake later. Two lines is the
    // cheaper honesty.
    //
    // The fields were built from the proposal, which the validator already
    // checked field by field. The cast is where that check is trusted.
    const { data: saved, error } =
      table === 'rl_library'
        ? await supabase
            .from('rl_library')
            .update(applied as Database['public']['Tables']['rl_library']['Update'])
            .eq('id', proposal.target_id)
            .select('id')
        : await supabase
            .from('rl_books')
            .update(applied as Database['public']['Tables']['rl_books']['Update'])
            .eq('id', proposal.target_id)
            .select('id');

    if (error) return new Response('That could not be saved.', { status: 500 });
    if (!saved?.length) {
      return new Response('That could not be saved — you may no longer be able to edit it.', {
        status: 403,
      });
    }

    changed = fieldsChanged(fields, applied);
    recorded = changed > 0 ? 'edited' : 'accepted';
  }

  await supabase
    .from('ai_proposals')
    .update({
      outcome: recorded,
      edit_distance: changed,
      decided_by: user.id,
      decided_at: new Date().toISOString(),
    })
    .eq('id', id);

  return redirect(next.startsWith('/') ? next : '/dashboard', 303);
};
