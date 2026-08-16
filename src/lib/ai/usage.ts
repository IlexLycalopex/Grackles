import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';

/**
 * Reading the ledger, for the pages that show it.
 *
 * Everything here is a read. The money moves in the functions and nowhere
 * else, so nothing in this file can change a total — it can only fail to
 * report one, which is a bug with a much smaller blast radius.
 */

type Client = SupabaseClient<Database>;

/** USD, as a person reads it. Four decimals, because a turn costs fractions of a cent. */
export function money(usd: number): string {
  if (!usd) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export interface UsageRow {
  feature: string;
  feature_name: string;
  workspace_id: string | null;
  workspace_name: string | null;
  role: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  failures: number;
  validator_failures: number;
}

export interface Allowance {
  /** What the payer may spend this month, from their row or the platform default. */
  limitUsd: number;
  committedUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  enabled: boolean;
  /** False when there is no budget row at all, which is a refusal rather than a zero. */
  granted: boolean;
  resets: string;
}

const firstOfNextMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
};

export async function loadAllowance(supabase: Client, userId: string): Promise<Allowance> {
  const period = new Date().toISOString().slice(0, 7) + '-01';

  const [{ data: budget }, { data: platform }, { data: period_ }] = await Promise.all([
    supabase.from('ai_budgets').select('monthly_usd, enabled').eq('user_id', userId).maybeSingle(),
    supabase.from('ai_platform_settings').select('default_monthly_usd').maybeSingle(),
    supabase
      .from('ai_periods')
      .select('reserved_usd, committed_usd')
      .eq('payer_id', userId)
      .eq('period', period)
      .maybeSingle(),
  ]);

  const limitUsd = Number(budget?.monthly_usd ?? platform?.default_monthly_usd ?? 0);
  const committedUsd = Number(period_?.committed_usd ?? 0);
  const reservedUsd = Number(period_?.reserved_usd ?? 0);

  return {
    limitUsd,
    committedUsd,
    reservedUsd,
    // Reserved counts against what is left, or two concurrent calls could both
    // be told they fit into the last cent.
    remainingUsd: Math.max(0, limitUsd - committedUsd - reservedUsd),
    enabled: budget?.enabled ?? false,
    // No row is a refusal, not an unlimited default, and the page has to say so
    // in those words or somebody will read a $0 spend as headroom.
    granted: Boolean(budget),
    resets: firstOfNextMonth(),
  };
}

export async function loadMyUsage(supabase: Client, period?: string): Promise<UsageRow[]> {
  const { data, error } = await supabase.rpc('my_ai_usage', { p_period: period ?? null });
  if (error) {
    console.error('ai: could not read usage', error);
    return [];
  }
  return (data ?? []) as UsageRow[];
}

export interface JobRow {
  id: string;
  feature: string;
  class: string;
  status: string;
  spent_usd: number;
  max_usd: number;
  calls_made: number;
  items_done: number;
  items_total: number | null;
  created_at: string;
  workspace_id: string;
  actor_id: string | null;
  payer_id: string;
}

/**
 * Jobs, not calls, at the top level.
 *
 * Nobody thinks in calls. The list is what was asked for — a night at the desk,
 * a write-up — and the calls are the detail underneath one of them.
 */
export async function loadJobs(
  supabase: Client,
  options: { workspaceId?: string; limit?: number } = {}
): Promise<JobRow[]> {
  let query = supabase
    .from('ai_jobs')
    .select(
      'id, feature, class, status, spent_usd, max_usd, calls_made, items_done, items_total, created_at, workspace_id, actor_id, payer_id'
    )
    .order('created_at', { ascending: false })
    .limit(options.limit ?? 25);

  if (options.workspaceId) query = query.eq('workspace_id', options.workspaceId);

  const { data } = await query;
  return (data ?? []) as JobRow[];
}

export interface CallRow {
  id: string;
  feature: string;
  status: string;
  cost_usd: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  validator_status: string | null;
  prompt_version: number | null;
  cache_hit: boolean;
  error: string | null;
  created_at: string;
}

export async function loadCalls(
  supabase: Client,
  options: { workspaceId?: string; jobId?: string; limit?: number } = {}
): Promise<CallRow[]> {
  let query = supabase
    .from('ai_calls')
    .select(
      'id, feature, status, cost_usd, prompt_tokens, completion_tokens, validator_status, prompt_version, cache_hit, error, created_at'
    )
    .order('created_at', { ascending: false })
    .limit(options.limit ?? 50);

  if (options.workspaceId) query = query.eq('workspace_id', options.workspaceId);
  if (options.jobId) query = query.eq('job_id', options.jobId);

  const { data } = await query;
  return (data ?? []) as CallRow[];
}

/**
 * What a project spent today, against its own ceiling.
 *
 * Summed from the ledger rather than kept as a counter: it is one indexed read
 * on a page nobody loads in a loop, and a second counter is a second thing that
 * can disagree with the first.
 */
export async function spentToday(supabase: Client, workspaceId: string): Promise<number> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);

  const { data } = await supabase
    .from('ai_calls')
    .select('cost_usd')
    .eq('workspace_id', workspaceId)
    .gte('created_at', midnight.toISOString());

  return (data ?? []).reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);
}
