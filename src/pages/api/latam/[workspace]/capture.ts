import type { APIRoute } from 'astro';
import { fetchPage } from '../../../../lib/latam/page';

export const prerender = false;

/**
 * Phone capture: one POST from HTTP Shortcuts, one line back for its toast.
 *
 *   POST /api/latam/:workspace/capture
 *   Authorization: Bearer lx_…
 *   { "id": "<uuid>", "type": "lesson", "title": "…", "minutes": 45, … }
 *
 * Thin on purpose, like every write route here. Who may capture, what is
 * accepted, how reading is matched and what the toast says are all
 * lx_capture(), where a crafted request cannot skip them. What this file adds
 * is the one thing a database should not do — fetch a shared link and say
 * what it is — and turning a refusal into a sentence and a status.
 *
 * The answer is plain text, because a toast shows the body as it is. The
 * address carries the project's slug only so a person reading their shortcut
 * can see where it points: the token decides the project, and a token for one
 * project sent to another's address still lands in its own.
 */

const STATUS: Record<string, number> = { GRK52: 401, GRK53: 429, GRK54: 422 };

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return text('No capture token. Add one under LatAm › Setup.', 401);

  let entry: Record<string, unknown>;
  try {
    const raw = await request.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
    entry = raw as Record<string, unknown>;
  } catch {
    return text('The body must be a JSON object.', 400);
  }

  // A reading entry with a link is read before it is saved: an article is
  // timed against its length, a book page is matched by its title.
  const link = typeof entry.link === 'string' ? entry.link.trim() : '';
  const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
  if (link && (type === 'reading' || type === 'article')) {
    const page = await fetchPage(link);
    if (page) entry.page = page;
  }

  const { data, error } = await locals.supabase.rpc('lx_capture', { p_token: token, p_entry: entry as never });

  if (error) {
    const status = STATUS[error.code] ?? 500;
    if (status === 500) console.error('lx_capture failed', error);
    return text(status === 500 ? 'Not saved: something went wrong on the server.' : `Not saved: ${error.message}`, status);
  }

  const result = data as { message?: string; duplicate?: boolean };
  return text(result.message ?? 'Logged', result.duplicate ? 200 : 201);
};
