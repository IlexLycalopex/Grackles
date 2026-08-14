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
 * declines rather than a shelf somebody has to repair.
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

    // The person may have unticked individual fields on the review page. What
    // they left ticked is what gets written, and the difference is the signal.
    const keep = new Set(form.getAll('field').map(String));
    const applied = Object.fromEntries(
      Object.entries(fields).filter(([key]) => keep.size === 0 || keep.has(key))
    );

    if (Object.keys(applied).length === 0) {
      return new Response('Nothing was ticked.', { status: 400 });
    }

    if (proposal.target_table !== 'rl_books' || !proposal.target_id) {
      return new Response('That proposal has nowhere to go.', { status: 400 });
    }

    // Asks for the row back and checks it got one, for the same reason every
    // delete in this app does: a write refused by row-level security does not
    // raise, it narrows the statement to zero rows and reports success.
    const { data: saved, error } = await supabase
      .from('rl_books')
      // The fields were built from the proposal, which the validator already
      // checked field by field. The cast is where that check is trusted, and
      // it is one line rather than a shape assertion repeated per column.
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
