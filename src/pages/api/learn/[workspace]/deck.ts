import type { APIRoute } from 'astro';
import { resolveWorkspace } from '../../../../lib/workspace';
import { checkCards, type CardDraft } from '../../../../lib/commonplace/csv';
import { deckSettings } from '../../../../lib/commonplace/server';
import { slugify } from '../../../../lib/slug';
import type { Json } from '../../../../lib/database.types';
import { json } from '../../../../lib/http';

export const prerender = false;

/**
 * Saving a flashcard deck, whole. Deleting one is a form on the deck's page.
 *
 * The editor sends every card every time. cp_save_deck() keeps the ids of the
 * cards it already has, which is what keeps people's progress attached to a
 * card through an edit. The checks here are the editor's own checks run again,
 * because the editor is a page and a page can be skipped.
 */

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { supabase, user } = locals;
  if (!user) return json({ error: 'Sign in first.' }, 401);

  const workspace = await resolveWorkspace(supabase, 'commonplace', params.workspace!, user.id);
  if (!workspace) return json({ error: 'Not found' }, 404);
  if (!workspace.canWrite) return json({ error: 'Only editors can change decks here.' }, 403);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Malformed request.' }, 400);
  }

  const title = String(body.title ?? '').trim();
  if (!title) return json({ error: 'Give the deck a name.' }, 400);
  let slug = slugify(String(body.slug ?? '') || title).slice(0, 60) || 'deck';
  // /cards/new is the editor, so a deck cannot live there.
  if (slug === 'new') slug = 'new-deck';

  const raw = Array.isArray(body.cards) ? body.cards : [];
  const cards: CardDraft[] = raw.map((c: Record<string, unknown>) => ({
    id: typeof c.id === 'string' ? c.id : undefined,
    prompt: String(c.prompt ?? '').trim(),
    answer: String(c.answer ?? '').trim(),
    accepts: Array.isArray(c.accepts) ? c.accepts.map(String).map(s => s.trim()).filter(Boolean) : [],
    hint: String(c.hint ?? '').trim(),
    notes: String(c.notes ?? '').trim(),
    tags: Array.isArray(c.tags) ? c.tags.map(String).map(s => s.trim()).filter(Boolean) : [],
    reverse: c.reverse === true,
  }));
  const problems = checkCards(cards);
  if (problems.length) {
    return json({ error: `Card ${problems[0].line}: ${problems[0].message}`, problems }, 400);
  }

  const { data, error } = await supabase.rpc('cp_save_deck', {
    p_workspace: workspace.id,
    p_id: typeof body.id === 'string' && body.id ? body.id : null,
    p_slug: slug,
    p_title: title,
    p_settings: deckSettings(body.settings) as unknown as Json,
    p_cards: cards as unknown as Json,
  });
  if (error) {
    if (error.code === 'GRK04') return json({ error: 'Another deck here already uses that address. Try a different name.' }, 400);
    if (error.code === 'GRK43') return json({ error: 'A deck holds at most 2,000 cards.' }, 400);
    console.error('cp_save_deck failed', error);
    return json({ error: 'Something went wrong saving the deck.' }, 500);
  }
  return json({ id: data, slug });
};
