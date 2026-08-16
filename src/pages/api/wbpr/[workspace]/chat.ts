import type { APIRoute } from 'astro';
import { resolveWorkspace } from '../../../../lib/workspace';
import type { Json } from '../../../../lib/database.types';
import { closeJob, jobHandle, openJob } from '../../../../lib/ai/job';
import { validateDeskReply } from '../../../../lib/ai/validators/wbpr';
import { loadPhenomenaCatalogue } from '../../../../lib/wbpr';
import {
  buildMessages, closeBroadcast, openBroadcast, rollForCaller, sayAtTable, startBlock,
  SYSTEM, type AgentState,
} from '../../../../lib/wbpr-agent';

export const prerender = false;

/**
 * One turn at the desk.
 *
 * Everything that decides an outcome — the cards, the die — happens here, on
 * the server, before the model is spoken to. The model is told what the table
 * did; it is never asked to do it. That is what makes the transcript a record
 * rather than a story about one.
 *
 * The gate is owner-only and it is checked here rather than trusted from the
 * page, because this is the URL that spends money and a page check protects
 * only the button. It is now checked a third time, in ai_begin_job, from
 * `min_role` on the feature row — the same rule expressed where the money
 * actually moves. All three holding is not redundancy worth removing.
 *
 * The sitting is an `interactive` job: opened when the night opens, drawn
 * against turn by turn, and closed when it is written up or abandoned. Every
 * turn re-asks the cheap questions, which is what makes the kill switch reach
 * a broadcast already on air.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * How long a reply may run, per kind of turn.
 *
 * These are now a floor under the feature's registered ceiling rather than the
 * ceiling itself: `ai_features.max_tokens` is what the reservation is taken
 * against, and lib/ai clamps every request to it. Keeping them means a close-
 * down still costs a fifth of what a call costs, which the platform ceiling
 * alone would not express.
 */
const BUDGET: Record<string, number> = {
  open: 320,
  block: 220,
  roll: 700,
  say: 700,
  close: 320,
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { supabase, user } = locals;

  if (!user) return json({ error: 'Sign in first.' }, 401);

  const workspace = await resolveWorkspace(supabase, 'wbpr', params.workspace!, user.id);
  if (!workspace) return json({ error: 'Not found.' }, 404);
  if (!workspace.isOwner) {
    return json({ error: 'Only the owner of this project can run a broadcast.' }, 403);
  }

  const body = await request.json().catch(() => null);
  const action = String(body?.action ?? '');
  const sessionId = body?.session_id ? String(body.session_id) : null;

  // ── Open a sitting ────────────────────────────────────────────────
  if (action === 'open') {
    const session = Number(body?.session);
    const date = String(body?.date ?? '');
    if (!Number.isInteger(session) || session < 1 || !date) {
      return json({ error: 'A broadcast needs a session number and a date.' }, 400);
    }

    // Admission before anything else exists. A refused night leaves no sitting
    // behind to be resumed, and the refusal is a sentence rather than a 500.
    const opened = await openJob({
      supabase,
      feature: 'wbpr.desk',
      workspaceId: workspace.id,
      class: 'interactive',
    });

    if (!opened.ok) {
      return json({ error: opened.error }, opened.code === 'GRK15' || opened.code === 'GRK16' ? 402 : 403);
    }

    const { data: created, error } = await supabase
      .from('wbpr_agent_sessions')
      .insert({
        workspace_id: workspace.id,
        created_by: user.id,
        ai_job_id: opened.jobId,
        state: { session, date, block: 0, cards: [], caller: null },
      })
      .select('id')
      .single();

    if (error || !created) {
      // The job was admitted and is now holding nothing useful. Closing it here
      // rather than leaving it to the reaper keeps the queue honest about what
      // is actually running.
      await closeJob(supabase, opened.jobId, 'failed', 'the sitting could not be created');
      return json({ error: 'Could not start a sitting.' }, 500);
    }

    // The catalogue, so the night can say "the frost is back" rather than
    // naming it something new. Derived from the log the same way the phenomena
    // page derives it — there is no standing table to read.
    const catalogue = await loadPhenomenaCatalogue(supabase, workspace.id);
    const known = catalogue.map(p => ({ name: p.name, status: p.status }));

    return turn(supabase, workspace.id, created.id, opened.jobId, openBroadcast(session, date, known), 'open');
  }

  if (!sessionId) return json({ error: 'No sitting in progress.' }, 400);

  // The session row is fetched through the caller's client, so RLS has already
  // confirmed they own it — there is no second ownership check to write here.
  const { data: sitting } = await supabase
    .from('wbpr_agent_sessions')
    .select('id, block, state, status, ai_job_id')
    .eq('id', sessionId)
    .maybeSingle();

  if (!sitting) return json({ error: 'That sitting is not yours or no longer exists.' }, 404);
  if (sitting.status !== 'running') return json({ error: 'That sitting is finished.' }, 409);

  // `state` is a jsonb column, so its type is Json — deliberately wider than
  // what we put in it. The cast is the one place that width is narrowed, and
  // a resumed sitting is the only reader.
  const state = (sitting.state ?? {}) as unknown as AgentState & { session?: number; date?: string };

  // Killing a sitting. No model call — nothing to ask, and charging for the
  // privilege of giving up would be a strange design. The transcript is kept
  // rather than deleted: the tokens were real and the row is the only record
  // of what they were spent on.
  if (action === 'abandon') {
    const { data: killed } = await supabase
      .from('wbpr_agent_sessions')
      .update({ status: 'abandoned' })
      .eq('id', sitting.id)
      .select('id');

    if (!killed?.length) return json({ error: 'That sitting could not be closed.' }, 500);

    // Abandoning is a normal ending, so the job is closed rather than
    // cancelled: nothing went wrong, the night simply stopped. Whatever the
    // envelope did not spend goes back either way.
    if (sitting.ai_job_id) await closeJob(supabase, sitting.ai_job_id, 'done');

    return json({ abandoned: true });
  }

  const jobId = sitting.ai_job_id;

  if (action === 'block') {
    const next = (sitting.block ?? 0) + 1;
    if (next > 4) return json({ error: 'Four blocks is the night. Close it out.' }, 400);
    return turn(supabase, workspace.id, sitting.id, jobId, startBlock(next, state), 'block', next);
  }

  if (action === 'roll') {
    return turn(supabase, workspace.id, sitting.id, jobId, rollForCaller(state), 'roll');
  }

  if (action === 'close') {
    return turn(supabase, workspace.id, sitting.id, jobId, closeBroadcast(state), 'close');
  }

  if (action === 'say') {
    const said = String(body?.text ?? '').trim();
    if (!said) return json({ error: 'Nothing to say.' }, 400);
    return turn(
      supabase, workspace.id, sitting.id, jobId,
      { prompt: sayAtTable(said, state), table: '', state },
      'say', undefined, said
    );
  }

  return json({ error: 'Unknown action.' }, 400);
};

/**
 * Send one turn, record both halves, and bill it.
 *
 * The player's turn is written before the call and the reply after, so a call
 * that fails mid-flight leaves the transcript showing what was asked. Losing
 * the question and keeping nothing is the version that makes a resumed sitting
 * incoherent.
 */
async function turn(
  supabase: App.Locals['supabase'],
  workspaceId: string,
  sessionId: string,
  jobId: string | null,
  step: { prompt: string; table: string; state: AgentState },
  kind: string,
  block?: number,
  /** What the DJ typed, if anything. Music he named himself is his to name. */
  said = ''
) {
  if (!jobId) {
    // A sitting from before the ledger existed. Rather than quietly spending
    // unmetered, it is refused and says why — there are nine of them and they
    // are all finished.
    return json({ error: 'That sitting predates AI metering. Start a new one.' }, 409);
  }

  const { data: history } = await supabase
    .from('wbpr_agent_messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .order('position');

  const prior = (history ?? []) as { role: 'user' | 'assistant'; content: string }[];
  const messages = buildMessages(prior, step.prompt);

  const result = await jobHandle(supabase, jobId, 'wbpr.desk').chat({
    messages,
    systemPrompt: SYSTEM,
    // Under the feature's ceiling, never above it. The reservation is taken
    // against the ceiling either way, so asking for less here does not buy more
    // headroom — it just costs less, which is the point.
    maxTokens: BUDGET[kind] ?? 700,
    // Checked before Jamie sees it, and recorded either way. The cards are a
    // hard fail because the app dealt them and knows; music is a warning,
    // because there is no list of every song to check against and a false
    // positive that blocked a broadcast would be worse than the thing it
    // guards.
    validate: content => validateDeskReply(content, step.state, said),
  });

  if (!result.ok) {
    // A refusal from the gates and a refusal from the provider read
    // differently: one is a limit doing its job, the other is something broken.
    const gated = result.code?.startsWith('GRK') ?? false;
    return json({ error: result.error }, gated ? 402 : 502);
  }

  const at = prior.length;
  const { error: writeError } = await supabase.from('wbpr_agent_messages').insert([
    { workspace_id: workspaceId, session_id: sessionId, position: at, role: 'user', content: step.prompt },
    { workspace_id: workspaceId, session_id: sessionId, position: at + 1, role: 'assistant', content: result.content },
  ]);

  if (writeError) {
    // The tokens are already spent, so the reply is returned rather than
    // discarded — but the sitting is now out of step with what was said, and
    // saying so beats a transcript that quietly skips a turn.
    console.error('wbpr agent: could not record turn', writeError);
    return json({ reply: result.content, table: step.table, warning: 'That turn was not saved.' });
  }

  // Read-modify-write on the counters. Two people cannot be at one desk — the
  // gate is owner-only and a sitting is one browser tab — so there is no race
  // worth an RPC here.
  //
  // These are now dual-written with the ledger rather than being the only
  // record. They stay until a full night has been through both and the totals
  // agree: taking them away first would mean discovering a discrepancy with
  // nothing left to compare against.
  const { data: totals } = await supabase
    .from('wbpr_agent_sessions')
    .select('prompt_tokens, completion_tokens, calls')
    .eq('id', sessionId)
    .maybeSingle();

  await supabase
    .from('wbpr_agent_sessions')
    .update({
      state: step.state as unknown as Json,
      ...(block !== undefined ? { block } : {}),
      prompt_tokens: (totals?.prompt_tokens ?? 0) + result.usage.prompt_tokens,
      completion_tokens: (totals?.completion_tokens ?? 0) + result.usage.completion_tokens,
      calls: (totals?.calls ?? 0) + 1,
    })
    .eq('id', sessionId);

  return json({
    // Returned on every turn, not just the first: the page needs it after
    // `open` creates the sitting, and echoing it back makes a resumed tab and
    // a fresh one take the same path.
    session_id: sessionId,
    reply: result.content,
    table: step.table,
    state: step.state,
    usage: result.usage,
    // What that turn actually cost, and whether it broke a rule. The desk shows
    // both: a running total nobody can see is the thing this layer exists to
    // stop, and a warning that never reaches the page is a warning nobody acts
    // on.
    cost_usd: result.costUsd,
    validation: result.validation,
  });
}
