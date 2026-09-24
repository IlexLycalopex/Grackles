import type { APIRoute } from 'astro';
import { resolveWorkspace } from '../../../../../lib/workspace';
import { loadDeck } from '../../../../../lib/commonplace/server';
import { toCsv } from '../../../../../lib/commonplace/csv';

export const prerender = false;

/** A deck as CSV, in the same columns the importer reads, so the two round-trip. */
export const GET: APIRoute = async ({ params, locals }) => {
  const { supabase, user } = locals;
  const workspace = await resolveWorkspace(supabase, 'commonplace', params.workspace!, user?.id ?? null);
  if (!workspace || !user) return new Response('Not found', { status: 404 });
  const found = await loadDeck(supabase, workspace.id, params.deck!);
  if (!found) return new Response('Not found', { status: 404 });

  return new Response(toCsv(found.cards), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${found.deck.slug}.csv"`,
    },
  });
};
