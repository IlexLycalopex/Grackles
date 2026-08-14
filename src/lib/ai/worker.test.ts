import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTick } from './worker';

/**
 * The tick loop, against a stubbed database.
 *
 * Everything the worker touches is either a table read or an RPC, and the RPCs
 * are the ones already covered by tests/ai.sh — so what is left to check here
 * is the decisions the loop makes between them: when it ends a job, when it
 * leaves one alone, and whether the quality abort fires at all.
 *
 * That last one is the reason this file exists. A batch that stops itself after
 * twenty bad items is a promise the page makes to somebody spending money, and
 * a filter written slightly wrong would keep that promise silently unkept.
 */

interface Recorded {
  rpc: { name: string; args: Record<string, unknown> }[];
}

/**
 * A chainable stand-in for the query builder.
 *
 * PostgREST's builder is thenable and every filter returns itself, which makes
 * it about fifteen lines to fake convincingly. The alternative is a dependency
 * that fakes it for us, and this is not fifteen lines' worth of dependency.
 */
function stubClient(opts: {
  job: Record<string, unknown> | null;
  pendingCount?: number;
  validatorStatuses?: (string | null)[];
  qualityFloor?: number | null;
  claim?: { position: number; ref: unknown }[];
  after?: Record<string, unknown>;
  recorded: Recorded;
}) {
  const { recorded } = opts;
  let afterCall = 0;

  const result = (table: string) => {
    if (table === 'ai_jobs') {
      // The second read of ai_jobs in a tick is the progress refresh at the end.
      const data = afterCall++ === 0 ? opts.job : (opts.after ?? opts.job);
      return { data, count: null };
    }
    if (table === 'ai_job_items') return { data: [], count: opts.pendingCount ?? 0 };
    if (table === 'ai_calls') {
      return {
        data: (opts.validatorStatuses ?? []).map(s => ({ validator_status: s })),
        count: null,
      };
    }
    if (table === 'ai_features') return { data: { quality_floor: opts.qualityFloor ?? null }, count: null };
    return { data: null, count: null };
  };

  const builder = (table: string): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'not', 'limit', 'order', 'gte']) {
      chain[method] = () => chain;
    }
    chain.maybeSingle = () => Promise.resolve(result(table));
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result(table)).then(resolve);
    return chain;
  };

  return {
    from: (table: string) => builder(table),
    rpc: (name: string, args: Record<string, unknown>) => {
      recorded.rpc.push({ name, args });
      if (name === 'ai_claim_items') return Promise.resolve({ data: opts.claim ?? [], error: null });
      return Promise.resolve({ data: null, error: null });
    },
  } as never;
}

const JOB = {
  id: 'j1',
  status: 'running',
  cancel_requested: false,
  items_total: 100,
  items_done: 10,
  spent_usd: 0.02,
  max_concurrency: 4,
  deadline: new Date(Date.now() + 3600_000).toISOString(),
};

const ok = async () => ({ ok: true });

test('a missing job is done, not an error', async () => {
  const recorded: Recorded = { rpc: [] };
  const result = await runTick(stubClient({ job: null, recorded }), 'j1', 'reading.enrich', ok);
  assert.equal(result.done, true);
  assert.equal(result.status, 'missing');
});

test('a cancelled job ends and makes no calls', async () => {
  // Cancellation is checked here rather than mid-call: a call in flight is
  // already paid for and finishing it costs nothing extra.
  const recorded: Recorded = { rpc: [] };
  const result = await runTick(
    stubClient({ job: { ...JOB, cancel_requested: true }, recorded }),
    'j1', 'reading.enrich', ok
  );
  assert.equal(result.ended, 'cancelled');
  assert.ok(recorded.rpc.some(r => r.name === 'ai_end_job' && r.args.p_status === 'cancelled'));
  assert.ok(!recorded.rpc.some(r => r.name === 'ai_claim_items'));
});

test('a job past its deadline ends', async () => {
  const recorded: Recorded = { rpc: [] };
  const result = await runTick(
    stubClient({ job: { ...JOB, deadline: new Date(Date.now() - 1000).toISOString() }, recorded }),
    'j1', 'reading.enrich', ok
  );
  assert.equal(result.ended, 'failed');
});

test('nothing claimed and nothing pending finishes the job', async () => {
  const recorded: Recorded = { rpc: [] };
  const result = await runTick(
    stubClient({ job: JOB, claim: [], pendingCount: 0, recorded }),
    'j1', 'reading.enrich', ok
  );
  assert.equal(result.ended, 'done');
});

test('nothing claimed but items still pending leaves the job alone', async () => {
  // Another tick holds them — a cron drain and an open tab both running is the
  // normal case, not a fault.
  const recorded: Recorded = { rpc: [] };
  const result = await runTick(
    stubClient({ job: JOB, claim: [], pendingCount: 7, recorded }),
    'j1', 'reading.enrich', ok
  );
  assert.equal(result.done, false);
  assert.ok(!recorded.rpc.some(r => r.name === 'ai_end_job'));
});

test('an item that throws is failed, not allowed to kill the batch', async () => {
  // 380 good records behind one malformed one is the failure this prevents.
  const recorded: Recorded = { rpc: [] };
  await runTick(
    stubClient({ job: JOB, claim: [{ position: 3, ref: {} }], pendingCount: 5, recorded }),
    'j1', 'reading.enrich',
    async () => { throw new Error('boom'); }
  );

  const finish = recorded.rpc.find(r => r.name === 'ai_finish_item');
  assert.ok(finish);
  assert.equal(finish.args.p_ok, false);
  assert.match(String(finish.args.p_error), /boom/);
});

test('a batch failing its check stops itself', async () => {
  // The feature-level floor is a trailing average across everything, which is
  // far too slow for this: four hundred items producing nonsense should stop at
  // twenty, and the average will not have moved by then.
  const recorded: Recorded = { rpc: [] };
  const result = await runTick(
    stubClient({
      job: JOB,
      claim: [{ position: 1, ref: {} }],
      pendingCount: 300,
      validatorStatuses: Array(20).fill('fail'),
      qualityFloor: 0.15,
      recorded,
    }),
    'j1', 'reading.enrich', ok
  );

  assert.equal(result.ended, 'exhausted');
  assert.ok(recorded.rpc.some(r => r.name === 'ai_end_job' && r.args.p_status === 'exhausted'));
});

test('a batch inside its floor carries on', async () => {
  const recorded: Recorded = { rpc: [] };
  const result = await runTick(
    stubClient({
      job: JOB,
      claim: [{ position: 1, ref: {} }],
      pendingCount: 300,
      validatorStatuses: [...Array(2).fill('fail'), ...Array(18).fill('pass')],
      qualityFloor: 0.15,
      after: { ...JOB, items_done: 11 },
      recorded,
    }),
    'j1', 'reading.enrich', ok
  );

  assert.equal(result.done, false);
  assert.ok(!recorded.rpc.some(r => r.name === 'ai_end_job'));
});

test('too small a sample never trips the abort', async () => {
  // Below twenty a single bad run would stop a working batch, and the cure
  // would be worse than the fault.
  const recorded: Recorded = { rpc: [] };
  const result = await runTick(
    stubClient({
      job: JOB,
      claim: [{ position: 1, ref: {} }],
      pendingCount: 300,
      validatorStatuses: Array(6).fill('fail'),
      qualityFloor: 0.15,
      after: { ...JOB, items_done: 11 },
      recorded,
    }),
    'j1', 'reading.enrich', ok
  );

  assert.equal(result.done, false);
});

test('a feature with no floor is never aborted on quality', async () => {
  const recorded: Recorded = { rpc: [] };
  const result = await runTick(
    stubClient({
      job: JOB,
      claim: [{ position: 1, ref: {} }],
      pendingCount: 300,
      validatorStatuses: Array(30).fill('fail'),
      qualityFloor: null,
      after: { ...JOB, items_done: 11 },
      recorded,
    }),
    'j1', 'reading.enrich', ok
  );

  assert.equal(result.done, false);
});
