import type { APIRoute } from 'astro';
import { resolveWorkspace } from '../../../../lib/workspace';

export const prerender = false;

/**
 * Apply a staged import.
 *
 * One RPC call, because the transaction is the point. Everything this route
 * does beyond calling it is turning an SQLSTATE into a sentence.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The refusals rl_apply_import raises, as sentences. */
const MESSAGES: Record<string, string> = {
  GRK30: 'That import could not be found.',
  GRK31: 'That import has already been applied.',
  '42501': 'You may not change this project.',
  // The two folds disagreeing, which is the one way this happens. Said plainly
  // rather than as a constraint name, because the useful next action is to look
  // at the row rather than to try again.
  '23505': 'Two rows in that import are the same book. Nothing was written — mark one of them to skip and apply again.',
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { supabase, user } = locals;
  if (!user) return json({ error: 'Sign in first.' }, 401);

  const workspace = await resolveWorkspace(supabase, 'reading-list', params.workspace!, user.id);
  if (!workspace) return json({ error: 'Not found.' }, 404);
  if (!workspace.canWrite) return json({ error: 'You may not change this project.' }, 403);

  const body = await request.json().catch(() => null);
  const batchId = body?.batch_id ? String(body.batch_id) : null;
  if (!batchId) return json({ error: 'Which import?' }, 400);

  const { data, error } = await supabase.rpc('rl_apply_import', { p_batch: batchId });

  if (error) {
    console.error('import: apply failed', { batchId, error });
    return json(
      { error: MESSAGES[error.code ?? ''] ?? 'That import could not be applied. Nothing has changed.' },
      error.code === '42501' ? 403 : 400
    );
  }

  return json(data ?? { added: 0, confirmed: 0 });
};
