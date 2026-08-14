import type { SupabaseClient, PostgrestError } from '@supabase/supabase-js';
import type { Database, Json } from '../database.types';
import { PROVIDERS } from './minimax';
import { describeAiError, type FeatureKey, type JobClass } from './features';
import type { ChatMessage, Usage } from './provider';

/**
 * The one door to a provider.
 *
 * Nothing under src/pages imports a provider directly. A job is admitted before
 * anything is spent and settled afterwards whatever happened, including on
 * failure — a call that errored still spent tokens often enough that treating
 * failure as free is how a budget quietly stops working.
 *
 * A single-call feature goes through this too, with a job of one. The overhead
 * is a row; the alternative is a second path that skips the gates, and a second
 * path is exactly how the desk's per-sitting counters came to be the only
 * accounting in the system.
 */

type Client = SupabaseClient<Database>;

/**
 * Where this is running.
 *
 * Read here rather than passed by every caller, because the one that forgets is
 * the one that matters: a preview deployment that calls itself production
 * spends the production allowance and lands in the production quality metrics.
 * process.env over import.meta.env because on Vercel this is a runtime fact,
 * not a build-time one.
 */
function environment(): 'production' | 'preview' | 'development' {
  const env = process.env.VERCEL_ENV ?? import.meta.env.VERCEL_ENV;
  return env === 'production' || env === 'preview' ? env : 'development';
}

export interface JobContext {
  supabase: Client;
  feature: FeatureKey;
  workspaceId: string;
  class?: JobClass;
  /** The worst this job may cost. Null takes the feature's registered default. */
  maxUsd?: number | null;
  maxCalls?: number | null;
  /** Set by a step that fans out. Depth is derived, never passed. */
  parentJobId?: string | null;
  /** A salted hash of the address for an anonymous caller. Never the address. */
  fingerprint?: string | null;
  itemsTotal?: number | null;
  /**
   * For work that must not happen twice. The same key within an hour returns
   * the job that already exists rather than opening a second — which is the
   * whole of the defence against a double-submitted form.
   */
  idempotencyKey?: string | null;
}

export type Opened =
  | { ok: true; jobId: string }
  | { ok: false; code: string; error: string };

export interface Validation {
  status: 'pass' | 'warn' | 'fail';
  findings?: unknown;
}

export interface TurnResult {
  callId: string;
  content: string;
  usage: Usage;
  costUsd: number;
  validation: Validation | null;
  /** True when nothing was sent anywhere. Still a ledger row, still free. */
  cacheHit: boolean;
}

export type Turn =
  | ({ ok: true } & TurnResult)
  | { ok: false; code?: string; error: string; callId?: string };

/** What a feature hands the metered `chat()` for one turn. */
export interface TurnRequest {
  messages: ChatMessage[];
  /**
   * The system prompt as sent, registered once so every call carries the
   * version that produced it. Omitted only by a feature that has none.
   */
  systemPrompt?: string;
  temperature?: number;
  /**
   * A tighter ceiling than the feature's, for a turn that needs less. Clamped
   * to the registered maximum and never above it: the reservation was taken
   * against that number, so a larger one would be spending money that was never
   * held. Asking for less is always allowed and always cheaper.
   */
  maxTokens?: number;
  /**
   * Set for a turn whose answer depends only on its input.
   *
   * The cheapest call is the one that does not happen, and this is the only
   * control in the system that reduces a bill rather than bounding it. Leave it
   * unset for anything whose whole point is to differ each time — a night at
   * the desk, a write-up — where a cache would not save money so much as ruin
   * the feature.
   */
  cacheKey?: string;
  /**
   * Checked before the caller sees the answer, and recorded whichever way it
   * goes. A rule that is only verified when somebody is looking is not a rule.
   */
  validate?: (content: string) => Validation;
}

export interface JobHandle {
  id: string;
  feature: FeatureKey;
  chat(request: TurnRequest): Promise<Turn>;
  /** Adds work to a batch. Returns how many items were added. */
  enqueue(refs: unknown[]): Promise<number>;
  claim(limit?: number): Promise<{ position: number; ref: Json }[]>;
  finishItem(position: number, ok: boolean, callId?: string | null, error?: string | null): Promise<void>;
}

const codeOf = (e: PostgrestError | null) => e?.code ?? '';

/**
 * Admission. Raises nothing — a refusal is an ordinary answer here, because
 * every caller has a sentence to show and none of them wants a stack trace.
 */
export async function openJob(ctx: JobContext): Promise<Opened> {
  const { data, error } = await ctx.supabase.rpc('ai_begin_job', {
    p_feature: ctx.feature,
    p_workspace: ctx.workspaceId,
    p_class: ctx.class ?? 'single',
    p_max_usd: ctx.maxUsd ?? null,
    p_max_calls: ctx.maxCalls ?? null,
    p_parent: ctx.parentJobId ?? null,
    p_fingerprint: ctx.fingerprint ?? null,
    p_items_total: ctx.itemsTotal ?? null,
    p_environment: environment(),
    p_idempotency_key: ctx.idempotencyKey ?? null,
  });

  if (error || !data) {
    return { ok: false, code: codeOf(error), error: describeAiError(error) };
  }
  return { ok: true, jobId: data as string };
}

export async function closeJob(
  supabase: Client,
  jobId: string,
  status: 'done' | 'cancelled' | 'failed' | 'exhausted',
  error?: string
): Promise<void> {
  // Failing to close is logged rather than thrown. The reaper will release the
  // envelope within ten minutes either way, and turning a completed piece of
  // work into an error because the bookkeeping stumbled helps nobody.
  const { error: closeError } = await supabase.rpc('ai_end_job', {
    p_job: jobId,
    p_status: status,
    p_error: error ?? null,
  });
  if (closeError) console.error('ai: could not close job', { jobId, status, closeError });
}

/**
 * A handle onto a job that is already open.
 *
 * Separate from withJob() because an interactive job outlives the request that
 * created it: a night at the desk is one job and a dozen HTTP round trips, and
 * each of them needs to make a call against a job it did not open.
 */
export function jobHandle(supabase: Client, jobId: string, feature: FeatureKey): JobHandle {
  // Read once per handle, not per call. It is four columns and it cannot change
  // mid-turn in a way that matters — ai_begin_call re-reads the parts that
  // decide whether the call may happen at all.
  let config: Promise<{ provider: string; model: string; maxTokens: number } | null> | null = null;
  const promptVersions = new Map<string, number>();

  const loadConfig = () => {
    config ??= Promise.resolve(
      supabase
        .from('ai_features')
        .select('provider, model, max_tokens')
        .eq('key', feature)
        .maybeSingle()
    ).then(({ data }) =>
      data ? { provider: data.provider, model: data.model, maxTokens: data.max_tokens } : null
    );
    return config;
  };

  const versionFor = async (body: string): Promise<number | null> => {
    const cached = promptVersions.get(body);
    if (cached !== undefined) return cached;
    const { data, error } = await supabase.rpc('ai_register_prompt', {
      p_feature: feature,
      p_body: body,
    });
    if (error || typeof data !== 'number') {
      // Not fatal. A call with no version recorded is a gap in the quality
      // reporting, not a reason to refuse somebody their broadcast.
      console.error('ai: could not register prompt', { feature, error });
      return null;
    }
    promptVersions.set(body, data);
    return data;
  };

  return {
    id: jobId,
    feature,

    async chat(request: TurnRequest): Promise<Turn> {
      const cfg = await loadConfig();
      if (!cfg) return { ok: false, error: describeAiError({ code: 'GRK12' }) };

      const provider = PROVIDERS[cfg.provider];
      if (!provider) return { ok: false, error: describeAiError({ code: 'GRK1C' }) };

      const version = request.systemPrompt ? await versionFor(request.systemPrompt) : null;

      // Before admission, because a hit should not need a reservation it will
      // never use. The function still counts it against the job's call ceiling:
      // a loop serving itself from cache is free but it is still a loop, and
      // the budget cannot stop what costs nothing.
      if (request.cacheKey) {
        const { data: cached, error: cacheError } = await supabase.rpc('ai_cache_take', {
          p_job: jobId,
          p_key: request.cacheKey,
        });

        if (cacheError) {
          return { ok: false, code: codeOf(cacheError), error: describeAiError(cacheError) };
        }
        const hit = cached?.[0];
        if (hit?.content) {
          return {
            ok: true,
            // The hit's own ledger row, so a cached answer is an ordinary turn
            // to everything downstream. Returning null here meant enrichment
            // silently stopped proposing anything for a book it had already
            // looked up — which is exactly the second run somebody does after
            // discarding the first suggestion.
            callId: hit.call_id,
            content: hit.content,
            usage: { prompt_tokens: 0, completion_tokens: 0 },
            costUsd: 0,
            cacheHit: true,
            // Re-checked rather than remembered. A validator that has changed
            // since the answer was stored should get its say, and it is free.
            validation: request.validate ? request.validate(hit.content) : null,
          };
        }
      }

      const { data: callId, error: beginError } = await supabase.rpc('ai_begin_call', {
        p_job: jobId,
        p_prompt_version: version,
      });

      if (beginError || !callId) {
        return { ok: false, code: codeOf(beginError), error: describeAiError(beginError) };
      }

      const result = await provider.complete(request.messages, {
        model: cfg.model,
        // Clamped here, not trusted from the caller.
        maxTokens: Math.min(request.maxTokens ?? cfg.maxTokens, cfg.maxTokens),
        temperature: request.temperature,
      });

      // Settled either way, and with whatever usage came back. A failed call
      // that reports zero tokens is a failed call that looks free.
      if (!result.ok) {
        await settle(supabase, callId as string, result.usage, null, result.reason);
        return {
          ok: false,
          callId: callId as string,
          error: result.reason === 'unconfigured'
            ? 'The model is not configured — MINIMAX_API_KEY is unset.'
            : `Nothing came back: ${result.reason}.`,
        };
      }

      const validation = request.validate ? request.validate(result.content) : null;
      const costUsd = await settle(supabase, callId as string, result.usage, validation, null);

      // Only an answer that passed. Caching a failure would serve it back for
      // thirty days, which turns one bad reply into a persistent one.
      if (request.cacheKey && validation?.status !== 'fail') {
        const { error: putError } = await supabase.rpc('ai_cache_put', {
          p_job: jobId,
          p_key: request.cacheKey,
          p_content: result.content,
          p_prompt_version: version,
        });
        if (putError) console.error('ai: could not cache', { jobId, putError });
      }

      return {
        ok: true,
        callId: callId as string,
        content: result.content,
        usage: result.usage,
        costUsd,
        validation,
        cacheHit: false,
      };
    },

    async enqueue(refs) {
      const { data, error } = await supabase.rpc('ai_enqueue_items', {
        p_job: jobId,
        p_refs: refs as unknown as Json,
      });
      if (error) {
        console.error('ai: could not enqueue', { jobId, error });
        return 0;
      }
      return (data as number) ?? 0;
    },

    async claim(limit = 4) {
      const { data, error } = await supabase.rpc('ai_claim_items', { p_job: jobId, p_limit: limit });
      if (error) {
        console.error('ai: could not claim items', { jobId, error });
        return [];
      }
      return (data ?? []).map(row => ({ position: row.position, ref: row.ref }));
    },

    async finishItem(position, ok, callId = null, error = null) {
      const { error: finishError } = await supabase.rpc('ai_finish_item', {
        p_job: jobId,
        p_position: position,
        p_ok: ok,
        p_call: callId,
        p_error: error,
      });
      if (finishError) console.error('ai: could not finish item', { jobId, position, finishError });
    },
  };
}

async function settle(
  supabase: Client,
  callId: string,
  usage: Usage | undefined,
  validation: Validation | null,
  error: string | null
): Promise<number> {
  const { data, error: settleError } = await supabase.rpc('ai_end_call', {
    p_call: callId,
    p_prompt: usage?.prompt_tokens ?? 0,
    p_completion: usage?.completion_tokens ?? 0,
    p_validator_status: validation?.status ?? null,
    p_validator_findings: (validation?.findings ?? null) as Json | null,
    p_error: error,
  });

  if (settleError) {
    // The tokens are already spent, so this is reported rather than raised —
    // but the ledger is now out of step with what happened, and the reaper will
    // release a reservation that was actually used. Loud in the log, because
    // the alternative is a slow drift nobody can explain later.
    console.error('ai: could not settle call', { callId, settleError });
    return 0;
  }
  return Number(data ?? 0);
}

/**
 * Open, run, close — for work that begins and ends inside one request.
 *
 * The close is in a finally, so a throw in the middle still returns the
 * envelope. Without it the failure that most wants investigating is also the
 * one that quietly holds a budget until the reaper notices.
 */
export async function withJob<T>(
  ctx: JobContext,
  run: (job: JobHandle) => Promise<T>
): Promise<{ ok: true; jobId: string; value: T } | { ok: false; code?: string; error: string }> {
  const opened = await openJob(ctx);
  if (!opened.ok) return opened;

  let status: 'done' | 'failed' = 'done';
  let failure: string | undefined;

  try {
    const value = await run(jobHandle(ctx.supabase, opened.jobId, ctx.feature));
    return { ok: true, jobId: opened.jobId, value };
  } catch (cause) {
    status = 'failed';
    failure = String(cause).slice(0, 500);
    throw cause;
  } finally {
    await closeJob(ctx.supabase, opened.jobId, status, failure);
  }
}
