import type { APIRoute } from 'astro';

export const prerender = false;

/**
 * Accepting an invite. All the checking — is the token real, unexpired,
 * unused, and addressed to this person — happens inside accept_invite(), so
 * there is one implementation of the rule rather than one here and one in the
 * database.
 */
export const POST: APIRoute = async ({ params, locals, redirect }) => {
  if (!locals.user) {
    return redirect(`/login?next=/dashboard`);
  }

  const { data, error } = await locals.supabase.rpc('accept_invite', {
    invite_token: params.token!,
  });

  if (error) {
    return redirect(`/dashboard?invite=failed`);
  }

  return redirect(`/dashboard?joined=${data}`);
};

/** A GET lands here when someone clicks the link in the invite email. */
export const GET: APIRoute = async ({ params, locals, redirect }) => {
  if (!locals.user) {
    return redirect(`/login?next=/invite/${params.token}`);
  }
  // Signed in already — accept and go.
  const { error } = await locals.supabase.rpc('accept_invite', {
    invite_token: params.token!,
  });
  return redirect(error ? '/dashboard?invite=failed' : '/dashboard');
};
