import type { APIRoute } from 'astro';
import { runTick, type ItemRunner } from '../../../../lib/ai/worker';
import { enrichOne, loadVocabulary } from '../../../../lib/ai/enrich';
import type { FeatureKey } from '../../../../lib/ai/features';

export const prerender = false;

/**
 * One slice of a batch.
 *
 * The page that started the job posts here until it reports done. That is the
 * whole of the execution model for now: no queue, no worker service, no new
 * dependency — the same test `lib/email.ts` and the provider were held to.
 *
 * It degrades honestly. Close the tab and the job stops ticking, the reaper
 * releases the envelope ten minutes later, and every item that finished stays
 * finished because each was committed as it landed. When something genuinely
 * unattended needs running, a cron drain calls this same endpoint for the same
 * jobs with the same worker, and nothing about a job's definition changes.
 *
 * Authorisation is entirely the database's. Every function the worker reaches
 * checks the job is visible to the caller, so a stranger with a job id gets
 * nothing and a member with somebody else's gets nothing either.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * What to do with one item, per feature.
 *
 * Built once per tick rather than once per item: anything a runner needs that
 * is the same for the whole batch — the reader's vocabulary, here — is fetched
 * here so four hundred items do not fetch it four hundred times.
 */
async function runnerFor(
  supabase: App.Locals['supabase'],
  feature: FeatureKey,
  workspaceId: string
): Promise<ItemRunner | null> {
  if (feature === 'reading.enrich') {
    const vocabulary = await loadVocabulary(supabase, workspaceId);
    return async (job, ref) => {
      const bookId = (ref as { book_id?: string })?.book_id;
      if (!bookId) return { ok: false, error: 'no book in this item' };
      return enrichOne(supabase, job, workspaceId, bookId, vocabulary);
    };
  }
  return null;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const { supabase, user } = locals;
  if (!user) return json({ error: 'Sign in first.' }, 401);

  const body = await request.json().catch(() => null);
  const jobId = String(body?.job_id ?? '');
  if (!jobId) return json({ error: 'No job.' }, 400);

  // RLS decides. A job the caller may not see does not come back, and the
  // response is the same as for one that does not exist.
  const { data: job } = await supabase
    .from('ai_jobs')
    .select('id, feature, workspace_id, class, status')
    .eq('id', jobId)
    .maybeSingle();

  if (!job) return json({ error: 'Not found.' }, 404);

  // A batch belongs to a project by construction — the work is that project's
  // records. A job with no workspace is a platform-scope one, which is always a
  // single call and never has items to tick through.
  if (!job.workspace_id) return json({ error: 'That job does not run in batches.' }, 400);

  const run = await runnerFor(supabase, job.feature as FeatureKey, job.workspace_id);
  if (!run) return json({ error: 'That feature does not run in batches.' }, 400);

  const result = await runTick(supabase, jobId, job.feature as FeatureKey, run);
  return json(result);
};
