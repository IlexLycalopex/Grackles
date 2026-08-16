import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../database.types';
import type { ChatMessage } from './provider';
import type { Validation } from './job';
import { openJob, closeJob, jobHandle } from './job';
import { validateDeskReply, validateWriteup } from './validators/wbpr';
import { validateEnrichment } from './enrich';
import { parseShape } from './json';
import type { AgentState } from '../wbpr-agent';
import type { Edition } from './openlibrary';

/**
 * Replaying a frozen input, and checking the rules still hold.
 *
 * Not checking that the answer matches. Prose identical to last month's would
 * mean the model had stopped being a model, and a suite that demanded it would
 * fail on every legitimate improvement and pass on none of the real problems.
 *
 * What is checked instead is the same thing the validators check on the way
 * past, plus whatever the case says must be true of this particular input —
 * which is how "it used to pick the right edition and now it does not" becomes
 * a failing test rather than a thing somebody notices in six weeks.
 */

type Client = SupabaseClient<Database>;

/** What must hold. Deliberately small: three kinds cover both features. */
export interface Expectations {
  /** The validator's verdict must be at least this good. */
  validator?: 'pass' | 'warn';
  /** The parsed answer must carry these keys with these values. */
  json_contains?: Record<string, unknown>;
  /** The reply must not contain these, case-insensitively. */
  must_not_include?: string[];
}

export interface GoldenInput {
  messages: ChatMessage[];
  /** The system prompt as sent, so the run records which version answered. */
  system?: string;
  /** Whatever this feature's validator needs. Shape depends on the feature. */
  context?: unknown;
}

export interface Finding {
  rule: string;
  detail: string;
}

/**
 * The validator for a feature, rebuilt from a case's frozen context.
 *
 * A case has to carry everything its validator needs, or it stops being frozen:
 * a desk case that read live state would change meaning the next time somebody
 * ran a broadcast.
 */
export function validatorFor(
  feature: string,
  context: unknown
): ((content: string) => Validation) | null {
  if (feature === 'wbpr.desk') {
    const ctx = (context ?? {}) as { state?: AgentState; said?: string };
    if (!ctx.state) return null;
    return content => validateDeskReply(content, ctx.state as AgentState, ctx.said ?? '');
  }

  if (feature === 'wbpr.writeup') {
    const ctx = (context ?? {}) as { state?: AgentState };
    if (!ctx.state) return null;
    return content => {
      const parsed = parseShape(content, (v): v is { blocks?: { position: number }[] } =>
        typeof v === 'object' && v !== null
      );
      return validateWriteup(parsed.ok ? parsed.value : null, ctx.state as AgentState);
    };
  }

  if (feature === 'reading.enrich') {
    const ctx = (context ?? {}) as { candidates?: Edition[] };
    if (!ctx.candidates) return null;
    return content => validateEnrichment(content, ctx.candidates as Edition[]);
  }

  return null;
}

const RANK = { fail: 0, warn: 1, pass: 2 } as const;

/**
 * Whether one answer met a case's expectations.
 *
 * Pure, and separated from everything that talks to a network, because this is
 * the part that decides whether a release ships.
 */
export function checkExpectations(
  content: string,
  expectations: Expectations,
  validation: Validation | null
): Finding[] {
  const findings: Finding[] = [];

  if (expectations.validator) {
    const got = validation?.status ?? 'fail';
    if (RANK[got] < RANK[expectations.validator]) {
      findings.push({
        rule: 'validator',
        detail: `expected at least ${expectations.validator}, got ${got}`,
      });
    }
  }

  if (expectations.json_contains) {
    const parsed = parseShape(content, (v): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null
    );

    if (!parsed.ok) {
      findings.push({ rule: 'json', detail: `no readable JSON (${parsed.reason})` });
    } else {
      for (const [key, want] of Object.entries(expectations.json_contains)) {
        const got = parsed.value[key];
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          findings.push({
            rule: 'json_contains',
            detail: `${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
          });
        }
      }
    }
  }

  for (const phrase of expectations.must_not_include ?? []) {
    if (content.toLowerCase().includes(phrase.toLowerCase())) {
      findings.push({ rule: 'must_not_include', detail: phrase });
    }
  }

  return findings;
}

export interface GoldenCase {
  id: string;
  feature: string;
  name: string;
  input: GoldenInput;
  expectations: Expectations;
}

export interface GoldenOutcome {
  caseId: string;
  name: string;
  passed: boolean;
  findings: Finding[];
  error?: string;
}

/**
 * Run every case for a workspace's platform job.
 *
 * One job for the whole suite rather than one per case: the suite is a single
 * piece of work with a single envelope, and thirty jobs would each hold their
 * own — which is the fan-out mistake the root-envelope rule exists to prevent,
 * arrived at from the other direction.
 *
 * Billed to `platform.golden`, not to the feature under test. Nobody asked for
 * the evaluation, and charging a project's owner for the platform checking its
 * own model would be indefensible on a report they can read.
 */
export async function runGolden(
  supabase: Client,
  workspaceId: string,
  cases: GoldenCase[]
): Promise<{ ok: true; outcomes: GoldenOutcome[] } | { ok: false; error: string }> {
  if (cases.length === 0) return { ok: true, outcomes: [] };

  const opened = await openJob({
    supabase,
    feature: 'platform.golden',
    workspaceId,
    class: 'batch',
    maxCalls: cases.length + 5,
  });

  if (!opened.ok) return { ok: false, error: opened.error };

  const handle = jobHandle(supabase, opened.jobId, 'platform.golden');
  const outcomes: GoldenOutcome[] = [];

  try {
    for (const one of cases) {
      const validate = validatorFor(one.feature, one.input.context);

      const turn = await handle.chat({
        messages: one.input.messages,
        systemPrompt: one.input.system,
        // Never cached. The whole point is to ask the model again — a cached
        // answer would report that nothing had changed, which is exactly the
        // claim the run exists to test.
        temperature: 0,
        validate: validate ?? undefined,
      });

      if (!turn.ok) {
        outcomes.push({
          caseId: one.id, name: one.name, passed: false,
          findings: [{ rule: 'call', detail: turn.error }], error: turn.error,
        });
        // A refusal from the gates means the rest will be refused too.
        if (turn.code?.startsWith('GRK')) break;
        continue;
      }

      const findings = checkExpectations(turn.content, one.expectations, turn.validation);
      outcomes.push({ caseId: one.id, name: one.name, passed: findings.length === 0, findings });

      await supabase.from('ai_golden_runs').insert({
        case_id: one.id,
        job_id: opened.jobId,
        call_id: turn.callId,
        passed: findings.length === 0,
        findings: findings as unknown as Json,
        model: '',
      } as never);
    }
  } finally {
    await closeJob(supabase, opened.jobId, 'done');
  }

  return { ok: true, outcomes };
}
