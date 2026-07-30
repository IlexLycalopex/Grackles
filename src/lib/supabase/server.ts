import { createServerClient, parseCookieHeader, type CookieOptions } from '@supabase/ssr';
import type { AstroCookies } from 'astro';
import type { Database } from '../database.types';

/**
 * Supabase client bound to the request's cookies.
 *
 * Every query made through it runs as the signed-in user, so RLS is what
 * decides what comes back — there is no separate authorisation layer in the
 * app, and there should not be one. If a page can see a row, the database
 * said so.
 *
 * Anonymous visitors get a client with no session, which is exactly right:
 * they still see workspaces marked public.
 */
export function createSupabaseServerClient(cookies: AstroCookies, request: Request) {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const key = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error(
      'PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set — see .env.example'
    );
  }

  // AstroCookies has get/set but no getAll, so the incoming set is read from
  // the raw header. Anything written during this request is layered on top:
  // getUser() can rotate the session, and a later read in the same request
  // must see the new value rather than the one the browser sent.
  const written = new Map<string, string>();

  return createServerClient<Database>(url, key, {
    cookies: {
      getAll() {
        const incoming = parseCookieHeader(request.headers.get('cookie') ?? '')
          .filter((c): c is { name: string; value: string } => c.value !== undefined);

        const merged = new Map(incoming.map(c => [c.name, c.value]));
        for (const [name, value] of written) merged.set(name, value);

        return [...merged].map(([name, value]) => ({ name, value }));
      },
      setAll(toSet) {
        for (const { name, value, options } of toSet) {
          written.set(name, value);
          cookies.set(name, value, {
            ...(options as CookieOptions),
            // The browser never needs to read the session, so keep it out of
            // reach of any script on the page.
            httpOnly: true,
            sameSite: 'lax',
            secure: import.meta.env.PROD,
            path: '/',
          });
        }
      },
    },
  });
}
