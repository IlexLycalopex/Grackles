import type { APIRoute } from 'astro';
import { resolveWorkspace } from '../../../../lib/workspace';
import { openJob } from '../../../../lib/ai/job';
import type { Json } from '../../../../lib/database.types';

export const prerender = false;

/**
 * Start an enrichment run.
 *
 * The books are chosen here, not by the model and not by the page: the page can
 * ask for "everything thin" or for a specific year, and this route works out
 * which rows that is and enqueues them. A batch whose contents were decided by
 * the browser would be a batch anybody could point at anything.
 *
 * The whole envelope is reserved at admission, so this either starts or is
 * refused. A year half-enriched is worse than one never started — whoever asked
 * then has to work out which half.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** How many books one run may cover. Beyond this, do it a year at a time. */
const MOST = 400;

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { supabase, user } = locals;
  if (!user) return json({ error: 'Sign in first.' }, 401);

  const workspace = await resolveWorkspace(supabase, 'reading-list', params.workspace!, user.id);
  if (!workspace) return json({ error: 'Not found.' }, 404);
  // A courtesy check. ai_begin_job refuses a viewer anyway, from `min_role` on
  // the feature row, which is the one that holds when somebody posts here
  // directly.
  if (!workspace.canWrite) return json({ error: 'You may not change this project.' }, 403);

  const body = await request.json().catch(() => null);
  const yearId = body?.year_id ? String(body.year_id) : null;

  // Thin books only: something is missing that this feature can supply. A book
  // already carrying a genre, a publisher and a page count is one somebody has
  // already dealt with, and re-asking about it would be paying to confirm what
  // is in front of us.
  let query = supabase
    .from('rl_books')
    .select('id')
    .eq('workspace_id', workspace.id)
    .or('genre.eq.,publisher_normalised.eq.,pages.is.null')
    .order('order_read')
    .limit(MOST);

  if (yearId) query = query.eq('year_id', yearId);

  const { data: books, error: booksError } = await query;
  if (booksError) return json({ error: 'Could not read the reading list.' }, 500);
  if (!books?.length) return json({ error: 'Nothing on this list needs filling in.' }, 400);

  const opened = await openJob({
    supabase,
    feature: 'reading.enrich',
    workspaceId: workspace.id,
    class: 'batch',
    maxCalls: books.length + 10,
    itemsTotal: 0,
    // The same selection, twice within the hour, is the same run. Somebody
    // double-clicking Start should not open a second batch against the first's
    // envelope.
    idempotencyKey: `enrich:${yearId ?? 'all'}:${books.length}`,
  });

  if (!opened.ok) {
    return json(
      { error: opened.error },
      opened.code === 'GRK15' || opened.code === 'GRK16' || opened.code === 'GRK18' ? 402 : 403
    );
  }

  const { data: added, error: enqueueError } = await supabase.rpc('ai_enqueue_items', {
    p_job: opened.jobId,
    p_refs: books.map(b => ({ book_id: b.id })) as unknown as Json,
  });

  if (enqueueError) {
    return json({ error: 'The run could not be filled.' }, 500);
  }

  return json({ job_id: opened.jobId, items: added ?? books.length });
};
