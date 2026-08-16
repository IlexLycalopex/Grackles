import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../database.types';
import { closeJob, jobHandle, type JobHandle } from './job';
import type { FeatureKey } from './features';

/**
 * One slice of a batch.
 *
 * Called from a request, from a browser pump, or from a cron drain, with no
 * difference in behaviour. That is the whole point of it being one function:
 * the trigger can change later without the job's definition changing with it,
 * and the first unattended job does not need a second worker written for it.
 *
 * A tick claims a few items, runs them, and returns whether there is more to
 * do. It never loops to completion — a four-hundred-item batch cannot run
 * inside one request no matter how it is gated, and pretending otherwise is how
 * a batch becomes a function timeout.
 */

type Client = SupabaseClient<Database>;

export interface TickResult {
  done: boolean;
  itemsDone: number;
  itemsTotal: number;
  spentUsd: number;
  status: string;
  /** Set when the tick ended the job, so a caller can say why it stopped. */
  ended?: 'done' | 'cancelled' | 'exhausted' | 'failed';
}

export type ItemRunner = (
  job: JobHandle,
  ref: Json,
  position: number
) => Promise<{ ok: boolean; callId?: string | null; error?: string }>;

/** How many items to look at before deciding the whole batch is going wrong. */
const QUALITY_SAMPLE = 20;

export async function runTick(
  supabase: Client,
  jobId: string,
  feature: FeatureKey,
  run: ItemRunner
): Promise<TickResult> {
  const { data: job } = await supabase
    .from('ai_jobs')
    .select('id, status, cancel_requested, items_total, items_done, spent_usd, max_concurrency, deadline')
    .eq('id', jobId)
    .maybeSingle();

  if (!job) {
    return { done: true, itemsDone: 0, itemsTotal: 0, spentUsd: 0, status: 'missing' };
  }

  const progress = (status: string, ended?: TickResult['ended']): TickResult => ({
    done: ended !== undefined || status !== 'running',
    itemsDone: job.items_done ?? 0,
    itemsTotal: job.items_total ?? 0,
    spentUsd: Number(job.spent_usd ?? 0),
    status,
    ended,
  });

  if (job.status !== 'queued' && job.status !== 'running') return progress(job.status);

  // Cancellation is checked here rather than mid-call: a call in flight is
  // already paid for and finishing it costs nothing extra.
  if (job.cancel_requested) {
    await closeJob(supabase, jobId, 'cancelled');
    return progress('cancelled', 'cancelled');
  }

  if (new Date(job.deadline) < new Date()) {
    await closeJob(supabase, jobId, 'failed', 'past its deadline');
    return progress('failed', 'failed');
  }

  const handle = jobHandle(supabase, jobId, feature);
  const items = await handle.claim(job.max_concurrency ?? 4);

  if (items.length === 0) {
    // Nothing claimed and nothing left pending is a finished batch. Nothing
    // claimed with items still pending means another tick holds them, so this
    // one simply reports and lets that one get on with it.
    const { count } = await supabase
      .from('ai_job_items')
      .select('position', { count: 'exact', head: true })
      .eq('job_id', jobId)
      .in('status', ['pending', 'running']);

    if ((count ?? 0) === 0) {
      await closeJob(supabase, jobId, 'done');
      return progress('done', 'done');
    }
    return progress('running');
  }

  // Bounded by what was claimed, which is bounded by max_concurrency. A batch
  // firing four hundred calls at a provider at once is a rate-limit ban rather
  // than a bill.
  await Promise.all(
    items.map(async item => {
      try {
        const outcome = await run(handle, item.ref, item.position);
        await handle.finishItem(item.position, outcome.ok, outcome.callId ?? null, outcome.error ?? null);
      } catch (cause) {
        // An item that throws is an item that failed, not a batch that died.
        // Three attempts and it is dropped; the 380 good records behind it are
        // the reason this is caught here rather than allowed to propagate.
        await handle.finishItem(item.position, false, null, String(cause).slice(0, 300));
      }
    })
  );

  // ── Fail fast on quality ────────────────────────────────────────────
  // The feature-level floor is a trailing average across everything, which is
  // the right instrument for a slow drift and far too slow for this: four
  // hundred items producing nonsense should stop at twenty, and the average
  // will not have moved enough to notice until most of the money is gone.
  const { data: sample } = await supabase
    .from('ai_calls')
    .select('validator_status')
    .eq('job_id', jobId)
    .not('validator_status', 'is', null)
    .limit(QUALITY_SAMPLE);

  if (sample && sample.length >= QUALITY_SAMPLE) {
    const failed = sample.filter(c => c.validator_status === 'fail').length;
    const { data: feat } = await supabase
      .from('ai_features')
      .select('quality_floor')
      .eq('key', feature)
      .maybeSingle();

    const floor = feat?.quality_floor;
    if (floor !== null && floor !== undefined && failed / sample.length > Number(floor)) {
      await closeJob(
        supabase,
        jobId,
        'exhausted',
        `stopped after ${sample.length} items — ${failed} failed validation`
      );
      return progress('exhausted', 'exhausted');
    }
  }

  const { data: after } = await supabase
    .from('ai_jobs')
    .select('items_done, items_total, spent_usd, status')
    .eq('id', jobId)
    .maybeSingle();

  return {
    done: false,
    itemsDone: after?.items_done ?? 0,
    itemsTotal: after?.items_total ?? 0,
    spentUsd: Number(after?.spent_usd ?? 0),
    status: after?.status ?? 'running',
  };
}
