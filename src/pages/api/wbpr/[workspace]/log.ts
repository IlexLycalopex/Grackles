import type { APIRoute } from 'astro';
import { resolveWorkspace } from '../../../../lib/workspace';
import { chat } from '../../../../lib/minimax';
import { oneOf, parseJsonObject } from '../../../../lib/json';
import { buildMessages, LOG_INSTRUCTION, type AgentState } from '../../../../lib/wbpr-agent';
import { broadcastSlug, PHENOMENON_STATUSES, CONFIDENCES, VEIL_STATUSES } from '../../../../lib/wbpr';

export const prerender = false;

/**
 * The one click that turns a night into a record.
 *
 * The division of labour is the whole design. The cards drawn, the dice
 * rolled, the block numbers and the session number are all things this app
 * decided and has been holding in `state` — they are written from there. The
 * model supplies only what it alone knows: the prose, the atmosphere, and
 * which phenomena the night touched.
 *
 * So the model is never asked for a card or a roll. Not because it would
 * refuse, but because it would comply — plausibly, and sometimes wrongly, and
 * the archive would carry a Seven of Clubs that was never drawn.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface LogPayload {
  atmospheric_conditions?: string;
  veil_status?: string;
  veil_intensity?: number;
  veil_at_close?: string;
  dawn_colour?: string;
  personal_notes?: string;
  tags?: string[];
  blocks?: { position: number; notes: string; tracks?: { title?: string; artist?: string }[] }[];
  phenomena?: {
    name: string; status?: string; confidence?: string;
    locations?: string[]; notes?: string; tags?: string[];
  }[];
}

/**
 * The model was told to answer with JSON and nothing else, and `parseJsonObject`
 * is tolerant of it having said a sentence first. Both it and `oneOf` now live
 * in `lib/json.ts` — the cigar lookup asks a model for JSON against a stated
 * shape in the same way, and one copy is one place to fix.
 */
const parseLog = (text: string) => parseJsonObject<LogPayload>(text);

const keyFor = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The form a name reduces to for the purpose of "is this the same thing".
 *
 * Leading articles and a trailing plural are the two ways the model reliably
 * misses: "The Watchers" comes back as "Watchers", "Frost Manifestations" as
 * "Frost Manifestation". Both would mint a second key and split a phenomenon's
 * history in half, which is the one thing the derived catalogue cannot survive.
 */
const canonical = (name: string) =>
  keyFor(name).replace(/^the-/, '').replace(/s$/, '');

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { supabase, user } = locals;
  if (!user) return json({ error: 'Sign in first.' }, 401);

  const workspace = await resolveWorkspace(supabase, 'wbpr', params.workspace!, user.id);
  if (!workspace) return json({ error: 'Not found.' }, 404);
  if (!workspace.isOwner) {
    return json({ error: 'Only the owner of this project can write up a broadcast.' }, 403);
  }

  const body = await request.json().catch(() => null);
  const sessionId = String(body?.session_id ?? '');
  if (!sessionId) return json({ error: 'No sitting to write up.' }, 400);

  const { data: sitting } = await supabase
    .from('wbpr_agent_sessions')
    .select('id, status, state, prompt_tokens, completion_tokens, calls')
    .eq('id', sessionId)
    .maybeSingle();

  if (!sitting) return json({ error: 'That sitting is not yours or no longer exists.' }, 404);
  if (sitting.status !== 'running') return json({ error: 'That sitting is already written up.' }, 409);

  const state = (sitting.state ?? {}) as unknown as AgentState & { session?: number; date?: string };
  const session = state.session;
  const date = state.date;
  if (!session || !date) return json({ error: 'That sitting has no session number.' }, 409);

  const { data: history } = await supabase
    .from('wbpr_agent_messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .order('position');

  const prior = (history ?? []) as { role: 'user' | 'assistant'; content: string }[];
  if (prior.length === 0) return json({ error: 'Nothing was broadcast.' }, 400);

  // The one turn worth a large budget: it is writing the whole night up, and a
  // truncated JSON object is a failed write-up rather than a short one.
  const result = await chat(buildMessages(prior, LOG_INSTRUCTION), { maxTokens: 2000, temperature: 0.6 });

  if (!result.ok) {
    return json(
      {
        error: result.reason === 'unconfigured'
          ? 'The model is not configured — MINIMAX_API_KEY is unset.'
          : `The write-up failed: ${result.reason}.`,
      },
      result.reason === 'unconfigured' ? 503 : 502
    );
  }

  const log = parseLog(result.content);
  if (!log) {
    // The transcript survives, so this is retryable rather than fatal — and the
    // tokens are recorded either way, because they were spent either way.
    console.error('wbpr log: unparseable write-up', { sample: result.content.slice(0, 400) });
    await billed(supabase, sessionId, sitting, result.usage);
    return json({ error: 'The write-up came back unreadable. Try again.' }, 502);
  }

  // ── The broadcast ──────────────────────────────────────────────────
  const { data: broadcast, error: broadcastError } = await supabase
    .from('wbpr_broadcasts')
    .insert({
      workspace_id: workspace.id,
      session,
      slug: broadcastSlug(session),
      date,
      atmospheric_conditions: String(log.atmospheric_conditions ?? '').slice(0, 2000),
      veil_status: oneOf(log.veil_status, VEIL_STATUSES, 'Thin'),
      veil_intensity:
        Number.isInteger(log.veil_intensity) && log.veil_intensity! >= 1 && log.veil_intensity! <= 10
          ? log.veil_intensity!
          : null,
      veil_at_close: String(log.veil_at_close ?? '').slice(0, 200),
      dawn_colour: String(log.dawn_colour ?? '').slice(0, 200),
      personal_notes: String(log.personal_notes ?? ''),
      tags: Array.isArray(log.tags) ? log.tags.map(String).slice(0, 20) : [],
    })
    .select('id, slug')
    .single();

  if (broadcastError || !broadcast) {
    await billed(supabase, sessionId, sitting, result.usage);
    return json(
      {
        error: broadcastError?.code === '23505'
          ? `Session ${session} is already in the archive. Change its number and try again.`
          : 'The broadcast could not be written.',
      },
      409
    );
  }

  // ── Blocks, from our record of the table ───────────────────────────
  const notesFor = new Map(
    (log.blocks ?? []).map(b => [Number(b.position), String(b.notes ?? '')])
  );
  const tracksFor = new Map(
    (log.blocks ?? []).map(b => [Number(b.position), b.tracks ?? []])
  );

  const played = (state.blocks ?? []).filter(b => b.position >= 1 && b.position <= 4);

  for (const record of played) {
    const caller = record.caller;
    const type = oneOf(caller?.result, ['none', 'standard', 'phenomenon', 'emergency'] as const, 'none');
    const hasCaller = type !== 'none';

    const { data: block } = await supabase
      .from('wbpr_blocks')
      .insert({
        workspace_id: workspace.id,
        broadcast_id: broadcast.id,
        position: record.position,
        caller_type: type,
        caller_card: hasCaller ? (caller?.card ?? '') : '',
        caller_card_meaning: hasCaller ? (caller?.topic ?? '') : '',
        // The die we rolled. It has been in the sitting's state all along and
        // was being thrown away at write-up — a block that came back "no
        // caller" could not say whether that was a 1, a 2 or a 3.
        caller_roll: caller?.die ?? null,
        notes: notesFor.get(record.position) ?? '',
      })
      .select('id')
      .single();

    if (!block) continue;

    // The cards are ours, verbatim. This is the line that makes the archive
    // agree with what actually happened at the table.
    if (record.cards.length > 0) {
      await supabase.from('wbpr_prompts').insert(
        record.cards.map((c, i) => ({
          workspace_id: workspace.id,
          block_id: block.id,
          position: i + 1,
          card: c.name,
          tone: c.tone,
        }))
      );
    }

    // The playlist, which is the one thing in the write-up that is neither
    // ours nor the model's invention — it is what the DJ said he was playing,
    // transcribed back out of the conversation. Without this the soundtrack
    // page never hears about the night at all.
    const playlist = (tracksFor.get(record.position) ?? [])
      .filter(t => t?.title)
      .map((t, i) => ({
        workspace_id: workspace.id,
        block_id: block.id,
        position: i + 1,
        title: String(t.title).slice(0, 300),
        artist: String(t.artist ?? '').slice(0, 300),
      }));

    if (playlist.length > 0) {
      await supabase.from('wbpr_tracks').insert(playlist);
    }
  }

  // ── Phenomena ──────────────────────────────────────────────────────
  // Everything the archive already knows, so a night that touches the frost
  // again lands on the existing key rather than starting a parallel history
  // under a name one letter different.
  const { data: seen } = await supabase
    .from('wbpr_phenomena')
    .select('key, name')
    .eq('workspace_id', workspace.id);

  const established = new Map<string, { key: string; name: string }>();
  for (const row of (seen ?? []) as { key: string; name: string }[]) {
    established.set(canonical(row.name), { key: row.key, name: row.name });
  }

  const phenomena = (log.phenomena ?? [])
    .filter(p => p?.name)
    .map(p => {
      // The stored spelling wins when it is recognisably the same thing. The
      // model's variant is not more correct for being newer.
      const match = established.get(canonical(String(p.name)));
      return { ...p, key: match?.key ?? keyFor(String(p.name)), name: match?.name ?? String(p.name) };
    })
    .map(p => ({
      workspace_id: workspace.id,
      broadcast_id: broadcast.id,
      key: p.key,
      name: p.name,
      status: oneOf(p.status, PHENOMENON_STATUSES, 'Active'),
      confidence: oneOf(p.confidence, CONFIDENCES, 'Unconfirmed'),
      locations: Array.isArray(p.locations) ? p.locations.map(String) : [],
      notes: String(p.notes ?? ''),
      tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
    }))
    // One row per phenomenon per night; a model that names the same thing twice
    // would otherwise trip the unique index and lose the rest of the list.
    .filter((p, i, all) => all.findIndex(q => q.key === p.key) === i)
    .filter(p => p.key);

  if (phenomena.length > 0) {
    await supabase.from('wbpr_phenomena').insert(phenomena);
  }

  await supabase
    .from('wbpr_agent_sessions')
    .update({
      status: 'logged',
      broadcast_id: broadcast.id,
      prompt_tokens: (sitting.prompt_tokens ?? 0) + result.usage.prompt_tokens,
      completion_tokens: (sitting.completion_tokens ?? 0) + result.usage.completion_tokens,
      calls: (sitting.calls ?? 0) + 1,
    })
    .eq('id', sessionId);

  return json({
    slug: broadcast.slug,
    href: `/wbpr/${workspace.slug}/${broadcast.slug}`,
    blocks: played.length,
    phenomena: phenomena.length,
  });
};

/** Record what a failed write-up cost. The tokens went either way. */
async function billed(
  supabase: App.Locals['supabase'],
  sessionId: string,
  sitting: { prompt_tokens: number; completion_tokens: number; calls: number },
  usage: { prompt_tokens: number; completion_tokens: number }
) {
  await supabase
    .from('wbpr_agent_sessions')
    .update({
      prompt_tokens: (sitting.prompt_tokens ?? 0) + usage.prompt_tokens,
      completion_tokens: (sitting.completion_tokens ?? 0) + usage.completion_tokens,
      calls: (sitting.calls ?? 0) + 1,
    })
    .eq('id', sessionId);
}
