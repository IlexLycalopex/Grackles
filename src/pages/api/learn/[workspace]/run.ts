import type { APIRoute } from 'astro';
import { resolveWorkspace } from '../../../../lib/workspace';
import { REF_PATTERN } from '../../../../lib/commonplace/decks';
import { RESULTS } from '../../../../lib/commonplace/result';
import type { Json } from '../../../../lib/database.types';
import { json } from '../../../../lib/http';

export const prerender = false;

/**
 * A run: start it, record answers, finish it.
 *
 * Thin, as the Blackletter route is. The rules (whose run it is, whether it is
 * finished, one daily go each, the server's clock) are in the cp_* functions,
 * because a rule in this file is a rule a crafted request skips by not using
 * this file. What this adds is shape-checking before a round trip, and a
 * SQLSTATE turned into a sentence.
 */

const SENTENCES: Record<string, string> = {
  GRK40: 'You have already played today’s challenge.',
  GRK41: 'That challenge is not today’s.',
  GRK42: 'That run has already finished.',
};

const int = (v: unknown, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0;
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { supabase, user } = locals;
  if (!user) return json({ error: 'Sign in to save your progress.' }, 401);

  const workspace = await resolveWorkspace(supabase, 'commonplace', params.workspace!, user.id);
  if (!workspace) return json({ error: 'Not found' }, 404);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Malformed request.' }, 400);
  }

  const fail = (error: { code?: string; message: string }, what: string) => {
    const sentence = SENTENCES[error.code ?? ''];
    if (sentence) return json({ error: sentence }, 400);
    console.error(`${what} failed`, error);
    return json({ error: 'Something went wrong saving that.' }, 500);
  };

  switch (body.action) {
    case 'start': {
      const deckRef = String(body.deckRef ?? '');
      if (!/^[a-z0-9-]{1,80}$/.test(deckRef)) return json({ error: 'Unknown deck.' }, 400);
      const { data, error } = await supabase.rpc('cp_start_run', {
        p_workspace: workspace.id,
        p_deck_ref: deckRef,
        p_mode: String(body.mode ?? '').slice(0, 20),
        p_settings: (body.settings ?? {}) as Json,
        p_scope: String(body.scope ?? 'all').slice(0, 40),
        p_pb_key: String(body.pbKey ?? '').slice(0, 300),
        p_total: int(body.total, 1000),
        p_daily: typeof body.daily === 'string' ? body.daily : null,
      });
      if (error) return fail(error, 'cp_start_run');
      return json({ id: data });
    }

    case 'answer': {
      const ref = String(body.ref ?? '');
      const result = String(body.result ?? '');
      if (!REF_PATTERN.test(ref) || !(RESULTS as readonly string[]).includes(result)) {
        return json({ error: 'Malformed answer.' }, 400);
      }
      const { error } = await supabase.rpc('cp_record_answer', {
        p_run: String(body.run ?? ''),
        p_card_ref: ref,
        p_result: result,
        p_attempts: int(body.attempts, 100),
        p_hints: int(body.hints, 100),
        p_ms: int(body.ms, 86_400_000),
        p_state: (body.state ?? null) as Json,
      });
      if (error) return fail(error, 'cp_record_answer');
      return json({ ok: true });
    }

    case 'finish': {
      const { data, error } = await supabase.rpc('cp_finish_run', { p_run: String(body.run ?? '') });
      if (error) return fail(error, 'cp_finish_run');
      return json(data);
    }

    default:
      return json({ error: 'Unknown action.' }, 400);
  }
};
