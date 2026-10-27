import { defineMiddleware } from 'astro:middleware';
import type { APIContext } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from './lib/supabase/server';
import { splitProjectPath } from './lib/apps';
import type { Database } from './lib/database.types';

/**
 * Where a project used to live, if this address is one it has left.
 *
 * Asked only of a request that has already come back 404, which is what keeps
 * it off every other page on the site: the ordinary cost of this is nothing,
 * and the cost of a miss is one indexed lookup on a page that was going to be
 * an error anyway.
 *
 * The embedded join is governed by `workspaces_read`, so a private project's
 * old address forwards for its members and 404s for everybody else. That is
 * the same answer the project itself gives, which is the point — a redirect
 * that fires for strangers would announce that something is there.
 */
async function forwardingAddress(
  supabase: SupabaseClient<Database>,
  pathname: string
): Promise<string | null> {
  const here = splitProjectPath(pathname);
  if (!here) return null;

  const { data } = await supabase
    .from('workspace_slug_history')
    .select('workspaces(slug)')
    .eq('app', here.app.slug)
    .eq('slug', here.slug)
    .maybeSingle();

  const slug = data?.workspaces?.slug;
  return slug ? `${here.prefix}/${here.app.path}/${slug}${here.rest}` : null;
}

/**
 * Headers every response carries.
 *
 * `frame-ancestors 'none'` (and X-Frame-Options for older browsers) because
 * nothing here is meant to be embedded, and a page that can be framed is a
 * page whose buttons — delete a project, change someone's role — can be
 * clicked through somebody else's site. The referrer policy keeps an
 * invitation token in /invite/<token> from travelling to any image host the
 * page loads. No script policy: the pages rely on inline scripts, and a CSP
 * strict enough to matter would need each one hashed first.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function secured(response: Response): Response {
  const apply = (r: Response) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!r.headers.has(name)) r.headers.set(name, value);
    }
    return r;
  };
  try {
    return apply(response);
  } catch {
    // A Response.redirect() has immutable headers. Rebuilt rather than sent
    // bare, so a redirect is covered like everything else.
    return apply(new Response(response.body, response));
  }
}

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

  return secured(await forwarded(context, next, supabase));
});

/** The page itself, or its new address if it has moved and this one 404s. */
async function forwarded(
  context: APIContext,
  next: () => Promise<Response>,
  supabase: SupabaseClient<Database>
): Promise<Response> {
  const response = await next();
  if (response.status !== 404) return response;

  // An address that has moved keeps answering. Renaming a project is offered
  // on its settings page, and an address is the thing people have written
  // down — the one part of a project that is not ours to invalidate.
  //
  // 308 rather than 301: both are permanent, and only 308 keeps the method, so
  // a form submitted from a page that was open when the address changed still
  // saves instead of silently becoming a GET that discards it.
  const moved = await forwardingAddress(supabase, context.url.pathname);
  return moved ? context.redirect(moved + context.url.search, 308) : response;
}
