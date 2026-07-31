import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppSlug, Database, MemberRole, Visibility } from './database.types';

export interface ResolvedWorkspace {
  id: string;
  app: AppSlug;
  slug: string;
  name: string;
  description: string;
  visibility: Visibility;
  /** null when the viewer is not a member — i.e. reading a public workspace. */
  role: MemberRole | null;
  canWrite: boolean;
  isOwner: boolean;
}

/**
 * Look a workspace up by app and slug.
 *
 * Returns null when it does not exist *or* the viewer may not see it — the two
 * are deliberately indistinguishable, so a private workspace 404s rather than
 * announcing itself with a 403.
 *
 * No visibility check happens here: the select simply returns nothing when RLS
 * says no. That is the point of doing it in the database.
 */
export async function resolveWorkspace(
  supabase: SupabaseClient<Database>,
  app: AppSlug,
  slug: string,
  userId: string | null
): Promise<ResolvedWorkspace | null> {
  const { data: ws } = await supabase
    .from('workspaces')
    .select('id, app, slug, name, description, visibility')
    .eq('app', app)
    .eq('slug', slug)
    .maybeSingle();

  if (!ws) return null;

  // Filter by user explicitly. An earlier version leaned on RLS to return only
  // the caller's row, which was wrong twice over: the members_read policy also
  // exposes the roster to anyone who can read the workspace, so a public
  // workspace handed its owner's row to anonymous visitors — and once a
  // workspace has two members, maybeSingle() errors on the multi-row result.
  let role: MemberRole | null = null;

  if (userId) {
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', ws.id)
      .eq('user_id', userId)
      .maybeSingle();

    role = membership?.role ?? null;
  }

  return {
    ...ws,
    role,
    canWrite: role === 'owner' || role === 'editor',
    isOwner: role === 'owner',
  };
}

export type WriteGate =
  | { ok: true; workspace: ResolvedWorkspace }
  | { ok: false; response: Response };

/**
 * The same lookup, for a route that exists in order to write.
 *
 * Every create and edit page opens with the same three checks in the same
 * order, and the order is the point: a workspace that may not be seen 404s
 * before anything else happens, so a private project never reveals itself by
 * redirecting an anonymous visitor to the login page.
 *
 * This is a courtesy, not a security boundary — RLS rejects the write whether
 * or not the page checked. It exists so an editor gets a sensible page instead
 * of a database error, and so a viewer following a stale link is told rather
 * than shown a form that cannot save.
 *
 * It returns the failure rather than throwing it: Astro renders a `return`ed
 * Response from a page, and a thrown one is an unhandled error.
 */
export async function requireWrite(
  supabase: SupabaseClient<Database>,
  app: AppSlug,
  slug: string,
  userId: string | null,
  /** Where to come back to after signing in — the current path and query. */
  returnTo: string
): Promise<WriteGate> {
  const workspace = await resolveWorkspace(supabase, app, slug, userId);

  if (!workspace) {
    return { ok: false, response: new Response('Not found', { status: 404 }) };
  }
  if (!userId) {
    return {
      ok: false,
      response: new Response(null, {
        status: 302,
        headers: { Location: `/login?next=${encodeURIComponent(returnTo)}` },
      }),
    };
  }
  if (!workspace.canWrite) {
    return { ok: false, response: new Response('Forbidden', { status: 403 }) };
  }

  return { ok: true, workspace };
}
