import type { APIRoute } from 'astro';

export const prerender = false;

/**
 * Where the magic link lands. Supabase sends the user here with a one-time
 * `code`, which is traded for a session; @supabase/ssr writes the cookies
 * through the client created in middleware.
 */
export const GET: APIRoute = async ({ url, locals, redirect }) => {
  const code = url.searchParams.get('code');
  const rawNext = url.searchParams.get('next');
  // Same guard as the login form: only same-origin, absolute paths.
  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/dashboard';

  if (!code) {
    return redirect('/login?error=missing-code');
  }

  const { error } = await locals.supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // Expired or already-used links land here. Sending them back to /login is
    // friendlier than an error page — they can just ask for another.
    return redirect('/login?error=link-expired');
  }

  return redirect(next);
};
