import type { APIRoute } from 'astro';

export const prerender = false;

/**
 * POST only. A GET would let any <img src="/logout"> on any page sign someone
 * out, which is a small but pointless thing to be vulnerable to.
 */
export const POST: APIRoute = async ({ locals, redirect }) => {
  await locals.supabase.auth.signOut();
  return redirect('/');
};
