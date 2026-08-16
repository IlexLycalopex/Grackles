import type { APIRoute } from 'astro';
import { withJob } from '../../lib/ai/job';
import { describeAiError } from '../../lib/ai/features';
import { parseJsonObject } from '../../lib/json';
import {
  cacheKeyFor, checkPlan, runPlan, SEARCH_SYSTEM, SOURCES,
} from '../../lib/ai/search';

export const prerender = false;

/**
 * One question, one call, and the app does the looking.
 *
 * The order of the three steps is the design. The model is asked for a *plan*
 * and never for an answer; the plan is checked against an allowlist before it
 * is allowed near the database; and the query runs on `locals.supabase`, the
 * caller's own client, so the rows that come back are the rows that person
 * could have reached by clicking. There is no path in this file by which a
 * search sees more than its author can.
 *
 * The refusal is deliberately blunt. A plan naming a column that does not exist
 * is rejected whole rather than repaired, because a repaired plan answers a
 * question nobody asked and does it silently — the results look right, which is
 * the worst way to be wrong.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Long enough for a real question, short enough that nobody pastes an essay. */
const LONGEST = 300;

export const POST: APIRoute = async ({ request, locals }) => {
  const { supabase, user } = locals;
  if (!user) return json({ error: 'Sign in first.' }, 401);

  const body = await request.json().catch(() => null);
  const question = String(body?.question ?? '').trim().slice(0, LONGEST);
  if (!question) return json({ error: 'Ask something.' }, 400);

  const ran = await withJob(
    // No workspace: this is the asker's own question, spanning everything they
    // can see, and billed to them. `ai_begin_job` refuses a platform-scope job
    // without a signed-in actor.
    { supabase, feature: 'platform.search', workspaceId: null, class: 'single' },
    job =>
      job.chat({
        messages: [
          { role: 'system', content: SEARCH_SYSTEM },
          { role: 'user', content: question },
        ],
        systemPrompt: SEARCH_SYSTEM,
        temperature: 0,
        // A plan is a pure function of the question and the vocabulary, so the
        // same words cost once. The key is the question alone: the vocabulary
        // is part of the prompt, and a prompt change registers a new version,
        // which the cache already keys on.
        cacheKey: cacheKeyFor(question),
        // Checked before the caller sees it, and recorded either way — so "the
        // model wrote a plan we could not use" is a number rather than an
        // impression.
        validate: content => {
          const checked = checkPlan(parse(content));
          return checked.ok
            ? { status: 'pass' }
            : { status: 'fail', findings: { reason: checked.reason } };
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

  const checked = checkPlan(parse(turn.content));
  if (!checked.ok) {
    // Already counted as a validator failure by the turn above; this is only
    // how it reads on the page.
    return json(
      {
        error: `That question could not be turned into a search — ${checked.reason}.`,
        question,
      },
      422
    );
  }

  const { hits, error } = await runPlan(supabase, checked.plan, checked.source);
  if (error) return json({ error }, 500);

  return json({
    question,
    plan: checked.plan,
    label: checked.source.label,
    cached: turn.cacheHit,
    hits,
  });
};

/** The model was told JSON and nothing else; this is tolerant of it saying more. */
const parse = (content: string): unknown => parseJsonObject<unknown>(content);

/** What can be asked about, for the page to show before anybody asks. */
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return json({ error: 'Sign in first.' }, 401);
  return json({
    sources: SOURCES.map(s => ({ key: s.key, label: s.label, what: s.what, app: s.app })),
  });
};
