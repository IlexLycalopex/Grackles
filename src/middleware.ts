import { defineMiddleware } from 'astro:middleware';
import { createSupabaseServerClient } from './lib/supabase/server';

/**
 * Attaches a request-scoped Supabase client and the current user to
 * `Astro.locals`, so pages do not each rebuild them.
 *
 * getUser() rather than getSession(): getSession only decodes the cookie,
 * which the client controls, whereas getUser verifies the token with the auth
 * server. The difference matters anywhere a decision is made about who someone
 * is.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const supabase = createSupabaseServerClient(context.cookies, context.request);
  context.locals.supabase = supabase;

  const { data, error } = await supabase.auth.getUser();
  context.locals.user = error ? null : data.user;

  return next();
});
