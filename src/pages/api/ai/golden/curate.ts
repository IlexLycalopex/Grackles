import type { APIRoute } from 'astro';

export const prerender = false;

/**
 * Freeze this sitting as a golden case.
 *
 * Pressed from the desk, because that is where somebody is looking at a reply
 * and thinking "that is exactly right" — which is the only moment anybody ever
 * curates anything. A form on an admin page asking for a transcript in JSON was
 * never going to be used, and the suite sat empty to prove it.
 *
 * Who may do it is decided by ai_curate_desk_case, not here: a golden case
 * carries a frozen copy of somebody's data and the prompt sent with it, so it
 * is a platform-admin action even though the desk is merely owner-only.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const { supabase, user } = locals;
  if (!user) return json({ error: 'Sign in first.' }, 401);

  const body = await request.json().catch(() => null);
  const sessionId = String(body?.session_id ?? '');
  const name = String(body?.name ?? '').trim().slice(0, 120);

  if (!sessionId) return json({ error: 'No sitting.' }, 400);

  const { data, error } = await supabase.rpc('ai_curate_desk_case', {
    p_session: sessionId,
    p_name: name || `Session ${new Date().toISOString().slice(0, 10)}`,
  });

  if (error) {
    return json(
      {
        error: error.code === '42501'
          ? 'Only a platform admin can keep a case.'
          : 'That sitting could not be frozen.',
      },
      error.code === '42501' ? 403 : 400
    );
  }

  return json({ case_id: data });
};
