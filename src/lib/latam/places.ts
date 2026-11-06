import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { withJob } from '../ai/job';
import { describeAiError } from '../ai/features';
import {
  buildResearchTurn,
  forbiddenFields,
  readResearch,
  RESEARCH_SYSTEM,
  verify,
  type Brief,
  type Suggestion,
} from './research';

type Db = SupabaseClient<Database>;
export type Place = Database['public']['Tables']['lx_places']['Row'];
export type Theme = Database['public']['Tables']['lx_themes']['Row'];
export type Item = Database['public']['Tables']['lx_items']['Row'];
export type ResearchRow = Database['public']['Tables']['lx_research']['Row'];

export const PLACE_STATUSES = [
  { value: 'learning', label: 'Learning about' },
  { value: 'want', label: 'Want to go' },
  { value: 'been', label: 'Been' },
  { value: '', label: 'Not started' },
] as const;

export const statusLabel = (s: string) => PLACE_STATUSES.find(x => x.value === s)?.label ?? s;

export const KIND_LABELS: Record<string, string> = {
  region: 'Region',
  city: 'City',
  town: 'Town',
  park: 'Park',
  river: 'River',
  lake: 'Lake',
  site: 'Site',
  route: 'Route',
};

export async function loadPlaces(db: Db, ws: string): Promise<Place[]> {
  const { data } = await db.from('lx_places').select('*').eq('workspace_id', ws).order('name');
  return data ?? [];
}

export async function loadThemes(db: Db, ws: string): Promise<Theme[]> {
  const { data } = await db.from('lx_themes').select('*').eq('workspace_id', ws).order('sort').order('name');
  return data ?? [];
}

/** Minutes logged here and listened in JPOD for one tag, all time. */
export async function minutesForTag(db: Db, ws: string, jpod: string | null, tag: string) {
  const [{ data: rows }, pod] = await Promise.all([
    db.from('lx_activities').select('minutes').eq('workspace_id', ws).contains('tags', [tag]),
    jpod
      ? db.rpc('jp_seconds_since', { p_workspace: jpod, p_from: '1900-01-01', p_tag: tag })
      : Promise.resolve({ data: 0 }),
  ]);
  return {
    latam: (rows ?? []).reduce((s, r) => s + r.minutes, 0),
    podcasts: Math.round(Number(pod.data ?? 0) / 60),
  };
}

export interface ResearchView {
  id: string;
  created_at: string;
  brief: Brief;
  suggestions: Suggestion[];
  dropped: number;
}

export const asResearch = (r: ResearchRow): ResearchView => ({
  id: r.id,
  created_at: r.created_at,
  brief: r.brief as unknown as Brief,
  suggestions: (Array.isArray(r.suggestions) ? r.suggestions : []) as unknown as Suggestion[],
  dropped: r.dropped,
});

/**
 * One deep dive: a metered call, the proposals checked, the result saved.
 * Returns the saved row's id, or a sentence saying why not.
 */
export async function runResearch(
  db: Db,
  userId: string,
  place: Place,
  regionName: string
): Promise<{ ok: true; id: string; kept: number; dropped: number } | { ok: false; error: string }> {
  const outcome = await withJob(
    {
      supabase: db,
      feature: 'latam.research',
      workspaceId: place.workspace_id,
      class: 'single',
      // A double press within the minute is one dive, not two bills.
      idempotencyKey: `research:${place.id}:${new Date().toISOString().slice(0, 16)}`,
    },
    async job => {
      const turn = await job.chat({
        messages: [
          { role: 'system', content: RESEARCH_SYSTEM },
          {
            role: 'user',
            content: buildResearchTurn({ name: place.name, kind: place.kind, province: place.province, regionName }),
          },
        ],
        systemPrompt: RESEARCH_SYSTEM,
        temperature: 0.4,
        validate: content => {
          if (!readResearch(content)) return { status: 'fail', findings: [{ rule: 'unreadable' }] };
          const smuggled = forbiddenFields(content);
          return smuggled.length
            ? { status: 'warn', findings: smuggled.map(f => ({ rule: 'forbidden-field', detail: f })) }
            : { status: 'pass' };
        },
      });
      if (!turn.ok) return { ok: false as const, error: turn.error };
      const read = readResearch(turn.content);
      if (!read) return { ok: false as const, error: 'The answer could not be read. Try again.' };
      return { ok: true as const, read, callId: turn.callId };
    }
  );

  if (!outcome.ok) return { ok: false, error: describeAiError({ code: outcome.code, message: outcome.error }) };
  if (!outcome.value.ok) return { ok: false, error: outcome.value.error };

  const { read, callId } = outcome.value;
  const { kept, dropped } = await verify(read.proposals);

  const { data, error } = await db
    .from('lx_research')
    .insert({
      workspace_id: place.workspace_id,
      place_id: place.id,
      created_by: userId,
      brief: read.brief as never,
      suggestions: kept as never,
      dropped,
      ai_call_id: callId,
    })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: 'The research ran but could not be saved.' };
  return { ok: true, id: data.id, kept: kept.length, dropped };
}
