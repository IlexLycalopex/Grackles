import type { APIRoute } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import { workspaceHref } from '../../lib/apps';
import type { AppSlug, Database, MemberRole } from '../../lib/database.types';

export const prerender = false;

/**
 * Accepting an invite. All the checking — is the token real, unexpired,
 * unused, and addressed to this person — happens inside accept_invite(), so
 * there is one implementation of the rule rather than one here and one in the
 * database.
 *
 * An invitation carries membership of a project, the right to create one of
 * your own, or both, so where someone lands afterwards depends on what they
 * were actually given.
 */

interface Accepted {
  workspace_id: string | null;
  role: MemberRole | null;
  granted_apps: AppSlug[];
}

/**
 * Where to send someone once the invitation is redeemed.
 *
 * Joining a project means going to the project — the dashboard would be a
 * detour past the thing they were invited to. Being granted the right to
 * create one means going to the form that creates it, because an otherwise
 * empty dashboard explains nothing about what just happened.
 */
async function destination(
  supabase: SupabaseClient<Database>,
  accepted: Accepted
): Promise<string> {
  if (accepted.workspace_id) {
    const { data } = await supabase
      .from('workspaces')
      .select('app, slug')
      .eq('id', accepted.workspace_id)
      .maybeSingle();

    // Readable now that the membership row exists. If it somehow is not, the
    // dashboard still lists it, so that is the safe fallback rather than a 404.
    return data ? `${workspaceHref(data.app, data.slug)}?joined=1` : '/dashboard?joined=1';
  }

  if (accepted.granted_apps.length > 0) {
    return `/new?granted=${encodeURIComponent(accepted.granted_apps.join(','))}`;
  }

  return '/dashboard';
}

/**
 * A failure passes the SQLSTATE on rather than a message, so the landing page
 * can word it. GRK02 — invited at a different address — is the one people
 * actually hit, and "failed" is no help at all when the fix is to sign in as
 * someone else.
 */
const failure = (code: string | undefined) =>
  `/dashboard?invite=failed${code ? `&reason=${encodeURIComponent(code)}` : ''}`;

async function accept(
  supabase: SupabaseClient<Database>,
  token: string
): Promise<string> {
  const { data, error } = await supabase.rpc('accept_invite', { invite_token: token });
  return error ? failure(error.code) : destination(supabase, data as Accepted);
}

/** Accepting from the dashboard's invitation card. */
export const POST: APIRoute = async ({ params, locals, redirect }) => {
  if (!locals.user) return redirect(`/login?next=/invite/${params.token}`);
  return redirect(await accept(locals.supabase, params.token!));
};

/** A GET lands here when someone clicks the link in the invite email. */
export const GET: APIRoute = async ({ params, locals, redirect }) => {
  if (!locals.user) return redirect(`/login?next=/invite/${params.token}`);
  return redirect(await accept(locals.supabase, params.token!));
};
