import type { APIRoute } from 'astro';
import { resolveWorkspace } from '../../../../lib/workspace';
import { contentHash, judge, parseUpload, summarise, type ExistingEntry } from '../../../../lib/library-import';
import type { Json } from '../../../../lib/database.types';

export const prerender = false;

/**
 * Stage an upload.
 *
 * Parses, judges and writes rows. It does not write a single library entry —
 * that is `rl_apply_import`, after a person has looked at what this found. The
 * separation is the whole design: an import that half-lands across several
 * hundred books leaves somebody working out which half.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Bigger than any plausible shelf list, small enough not to be a way in. */
const MOST_BYTES = 4_000_000;

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { supabase, user } = locals;
  if (!user) return json({ error: 'Sign in first.' }, 401);

  const workspace = await resolveWorkspace(supabase, 'reading-list', params.workspace!, user.id);
  if (!workspace) return json({ error: 'Not found.' }, 404);
  if (!workspace.canWrite) return json({ error: 'You may not change this project.' }, 403);

  const form = await request.formData();
  const file = form.get('file');
  const pasted = String(form.get('pasted') ?? '');
  const readDefault = form.get('read_default') !== null;

  const text = file instanceof File && file.size ? await file.text() : pasted;
  const filename = file instanceof File && file.size ? file.name : 'pasted';

  if (!text.trim()) return json({ error: 'Choose a file, or paste the list in.' }, 400);
  if (text.length > MOST_BYTES) return json({ error: 'That file is too large to import in one go.' }, 400);

  const parsed = parseUpload(text);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  // The same file twice is the same batch. Checked here so the second
  // submission gets sent to the review it already has rather than a refusal —
  // the unique index is what actually holds, this is what makes it kind.
  const hash = await contentHash(text);
  const { data: already } = await supabase
    .from('rl_import_batches')
    .select('id, status')
    .eq('workspace_id', workspace.id)
    .eq('content_hash', hash)
    .maybeSingle();

  if (already) {
    return json({ batch_id: already.id, existing: true, status: already.status });
  }

  // Judging needs the library as it stands. Read whole rather than queried per
  // row: several hundred rows against several hundred entries is one round trip
  // either way, and the near-miss check has to see every entry to find one.
  const { data: entries, error: entriesError } = await supabase
    .from('rl_library')
    .select('id, title, author, series_index, work_key')
    .eq('workspace_id', workspace.id);

  if (entriesError) return json({ error: 'Could not read the library.' }, 500);

  const judged = judge(parsed.rows, (entries ?? []) as ExistingEntry[]);

  const { data: batch, error: batchError } = await supabase
    .from('rl_import_batches')
    .insert({
      workspace_id: workspace.id,
      filename,
      content_hash: hash,
      rows_total: judged.length,
      read_default: readDefault,
      uploaded_by: user.id,
    })
    .select('id')
    .single();

  if (batchError || !batch) return json({ error: 'Could not start that import.' }, 500);

  const { error: rowsError } = await supabase.from('rl_import_rows').insert(
    judged.map(row => ({
      batch_id: batch.id,
      workspace_id: workspace.id,
      position: row.position,
      raw: row.raw as unknown as Json,
      title: row.title,
      author: row.author,
      work_key: row.work_key,
      verdict: row.verdict,
      match_library_id: row.match_library_id,
      decision: row.decision,
      read_decision: row.read_decision,
      ...row.values,
    }))
  );

  if (rowsError) {
    // A batch with no rows is a dead end on the review screen, and the file can
    // simply be uploaded again once whatever this was is fixed.
    console.error('import: could not stage rows', rowsError);
    await supabase.from('rl_import_batches').delete().eq('id', batch.id);
    return json({ error: 'That file could not be staged.' }, 500);
  }

  return json({
    batch_id: batch.id,
    rows: judged.length,
    unmapped: parsed.unmapped,
    counts: summarise(judged),
  });
};
