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

/**
 * The same lookup, but for a route that is about to write. Throws a Response
 * so a page or endpoint can `throw` it directly.
 *
 * This is a courtesy, not a security boundary — the write would be rejected by
 * RLS regardless. It exists so an editor sees a sensible page instead of a
 * database error.
 */
export async function requireWritableWorkspace(
  supabase: SupabaseClient<Database>,
  app: AppSlug,
  slug: string,
  userId: string | null
): Promise<ResolvedWorkspace> {
  const ws = await resolveWorkspace(supabase, app, slug, userId);
  if (!ws) throw new Response('Not found', { status: 404 });

  if (!userId) {
    throw new Response(null, {
      status: 302,
      headers: { Location: `/login?next=/${app}/${slug}` },
    });
  }
  if (!ws.canWrite) throw new Response('Forbidden', { status: 403 });

  return ws;
}
