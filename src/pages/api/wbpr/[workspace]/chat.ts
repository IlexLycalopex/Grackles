import type { APIRoute } from 'astro';
import { resolveWorkspace } from '../../../../lib/workspace';
import type { Json } from '../../../../lib/database.types';
import { chat } from '../../../../lib/minimax';
import {
  buildMessages, closeBroadcast, openBroadcast, rollForCaller, startBlock,
  type AgentState,
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
 * only the button.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** How long a reply may run, per kind of turn. A ceiling on cost, not just length. */
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

    const { data: created, error } = await supabase
      .from('wbpr_agent_sessions')
      .insert({
        workspace_id: workspace.id,
        created_by: user.id,
        state: { session, date, block: 0, cards: [], caller: null },
      })
      .select('id')
      .single();

    if (error || !created) return json({ error: 'Could not start a sitting.' }, 500);

    return turn(supabase, workspace.id, created.id, openBroadcast(session, date), 'open');
  }

  if (!sessionId) return json({ error: 'No sitting in progress.' }, 400);

  // The session row is fetched through the caller's client, so RLS has already
  // confirmed they own it — there is no second ownership check to write here.
  const { data: sitting } = await supabase
    .from('wbpr_agent_sessions')
    .select('id, block, state, status')
    .eq('id', sessionId)
    .maybeSingle();

  if (!sitting) return json({ error: 'That sitting is not yours or no longer exists.' }, 404);
  if (sitting.status !== 'running') return json({ error: 'That sitting is finished.' }, 409);

  // `state` is a jsonb column, so its type is Json — deliberately wider than
  // what we put in it. The cast is the one place that width is narrowed, and
  // a resumed sitting is the only reader.
  const state = (sitting.state ?? {}) as unknown as AgentState & { session?: number; date?: string };

  if (action === 'block') {
    const next = (sitting.block ?? 0) + 1;
    if (next > 4) return json({ error: 'Four blocks is the night. Close it out.' }, 400);
    return turn(supabase, workspace.id, sitting.id, startBlock(next), 'block', next);
  }

  if (action === 'roll') {
    return turn(supabase, workspace.id, sitting.id, rollForCaller(state), 'roll');
  }

  if (action === 'close') {
    return turn(supabase, workspace.id, sitting.id, closeBroadcast(), 'close');
  }

  if (action === 'say') {
    const said = String(body?.text ?? '').trim();
    if (!said) return json({ error: 'Nothing to say.' }, 400);
    return turn(
      supabase, workspace.id, sitting.id,
      { prompt: said, table: '', state },
      'say'
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
  step: { prompt: string; table: string; state: AgentState },
  kind: string,
  block?: number
) {
  const { data: history } = await supabase
    .from('wbpr_agent_messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .order('position');

  const prior = (history ?? []) as { role: 'user' | 'assistant'; content: string }[];
  const messages = buildMessages(prior, step.prompt);

  const result = await chat(messages, { maxTokens: BUDGET[kind] ?? 700 });

  if (!result.ok) {
    return json(
      {
        error: result.reason === 'unconfigured'
          ? 'The model is not configured — MINIMAX_API_KEY is unset.'
          : `Nothing came back: ${result.reason}.`,
      },
      result.reason === 'unconfigured' ? 503 : 502
    );
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
    reply: result.content,
    table: step.table,
    state: step.state,
    usage: result.usage,
  });
}
