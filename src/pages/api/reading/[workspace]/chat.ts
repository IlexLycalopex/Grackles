import type { APIRoute } from 'astro';
import { resolveWorkspace } from '../../../../lib/workspace';
import { withJob } from '../../../../lib/ai/job';
import { describeAiError } from '../../../../lib/ai/features';
import { runPlan, SOURCES } from '../../../../lib/ai/search';
import {
  ACTION_LABELS, buildChatTurn, chatCacheKey, CHAT_ACTIONS, CHAT_SYSTEM, readChatTurn,
  type ChatAction, type ChatHistoryEntry,
} from '../../../../lib/ai/chat';

export const prerender = false;

/**
 * One turn of a conversation with the reading list.
 *
 * The order of the steps is the design, and it is the search route's order with
 * one thing added: the model is asked for a *plan* and never for an answer; the
 * plan is checked against an allowlist before it goes near the database; the
 * query runs on the caller's own client so RLS decides what comes back; and any
 * action is *offered* rather than performed.
 *
 * Nothing in this file writes. The action leaves here as a name and a count, and
 * becomes a change only when somebody presses the button on the page — which
 * posts to the library, through the same bulk path they could have used by hand.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const LONGEST = 300;

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { supabase, user } = locals;
  if (!user) return json({ error: 'Sign in first.' }, 401);

  const workspace = await resolveWorkspace(supabase, 'reading-list', params.workspace!, user.id);
  if (!workspace) return json({ error: 'Not found.' }, 404);
  // A courtesy check; `ai_begin_job` refuses below the feature's min_role anyway.
  // Gated on write rather than read because a turn may end in a button, and
  // offering somebody an action they would be refused is worse than not asking.
  if (!workspace.canWrite) return json({ error: 'You may not change this project.' }, 403);

  const body = await request.json().catch(() => null);
  const question = String(body?.question ?? '').trim().slice(0, LONGEST);
  if (!question) return json({ error: 'Ask something.' }, 400);

  /**
   * The conversation so far, as the browser has it.
   *
   * Questions and what the model said it would do — never results. Trusted only
   * as far as it is fenced: it goes back inside the untrusted markers like the
   * question does, and nothing is decided by it.
   */
  const history: ChatHistoryEntry[] = Array.isArray(body?.history)
    ? body.history
        .filter((h: unknown): h is ChatHistoryEntry =>
          !!h && typeof h === 'object' &&
          typeof (h as ChatHistoryEntry).question === 'string' &&
          typeof (h as ChatHistoryEntry).said === 'string')
        .slice(-12)
    : [];

  const ran = await withJob(
    { supabase, feature: 'reading.chat', workspaceId: workspace.id, class: 'single' },
    job =>
      job.chat({
        messages: [
          { role: 'system', content: CHAT_SYSTEM },
          { role: 'user', content: buildChatTurn(question, history) },
        ],
        systemPrompt: CHAT_SYSTEM,
        temperature: 0,
        cacheKey: chatCacheKey(question, history),
        // Checked before the caller sees it and recorded either way, so "the
        // model wrote something we could not use" is a number rather than an
        // impression.
        validate: content => {
          const read = readChatTurn(content);
          return read.ok ? { status: 'pass' } : { status: 'fail', findings: { reason: read.reason } };
        },
      })
  );

  if (!ran.ok) {
    return json(
      { error: describeAiError({ code: ran.code, message: ran.error }) },
      ran.code === 'GRK15' || ran.code === 'GRK16' || ran.code === 'GRK18' ? 402 : 403
    );
  }

  const turn = ran.value;
  if (!turn.ok) {
    return json({ error: turn.error }, turn.error.includes('not configured') ? 503 : 502);
  }

  const read = readChatTurn(turn.content);
  if (!read.ok) {
    return json({ error: `That could not be turned into a search — ${read.reason}.` }, 422);
  }

  // Nothing to look up: a greeting, a refusal, a question about how this works.
  if (!read.plan?.ok) {
    return json({ question, say: read.turn.say, hits: [], cached: turn.cacheHit });
  }

  const { hits, error } = await runPlan(supabase, read.plan.plan, read.plan.source);
  if (error) return json({ error }, 500);

  const act = read.turn.act;

  return json({
    question,
    say: read.turn.say,
    label: read.plan.source.label,
    plan: read.plan.plan,
    cached: turn.cacheHit,
    hits,
    // The offer, not the doing. The ids travel so the button posts exactly what
    // was shown — a second search at press time could act on a different set
    // than the one somebody looked at and agreed to.
    offer: act && hits.length
      ? { action: act, label: ACTION_LABELS[act], count: hits.length, ids: hits.map(h => h.id) }
      : null,
  });
};

/** What the window can be asked about, before anybody asks. */
export const GET: APIRoute = async ({ params, locals }) => {
  const { supabase, user } = locals;
  if (!user) return json({ error: 'Sign in first.' }, 401);
  const workspace = await resolveWorkspace(supabase, 'reading-list', params.workspace!, user.id);
  if (!workspace) return json({ error: 'Not found.' }, 404);

  return json({
    actions: CHAT_ACTIONS.map(a => ({ action: a, label: ACTION_LABELS[a] })),
    sources: SOURCES.filter(s => s.app === 'reading-list').map(s => ({ key: s.key, what: s.what })),
  });
};
