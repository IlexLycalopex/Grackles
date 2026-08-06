import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppSlug, Database } from './database.types';
import { HOSTED_APPS } from './apps';

/**
 * Who may create a project, and of which app.
 *
 * Membership of a project and the right to run one of your own are separate
 * facts: someone can be a viewer of a Cigar Lounge without being able to make
 * one, and can be able to make one without being a member of anything. The
 * database is the authority — `workspaces_insert` and `create_workspace()`
 * both check `app.can_create()`. Everything here is so the interface can offer
 * the right things rather than presenting a form that is going to be refused.
 */

export interface CreatableApp {
  app: AppSlug;
  /** null when unlimited, i.e. the viewer is a platform admin. */
  remaining: number | null;
}

export interface Entitlements {
  isPlatformAdmin: boolean;
  /** Apps this user may create a project in right now, quota accounted for. */
  creatable: CreatableApp[];
}

const NONE: Entitlements = { isPlatformAdmin: false, creatable: [] };

/**
 * What this user may create.
 *
 * Three reads rather than one RPC per app: the grants, the projects they own
 * (to spend against the quota), and their admin flag. `app_grants` is readable
 * only by its owner and `workspaces` only where RLS allows, so neither query
 * needs a user filter — but the owned count does, because `workspaces_read`
 * also returns every public and unlisted project on the site.
 */
export async function loadEntitlements(
  supabase: SupabaseClient<Database>,
  userId: string | null
): Promise<Entitlements> {
  if (!userId) return NONE;

  const [{ data: profile }, { data: grants }, { data: owned }] = await Promise.all([
    supabase.from('profiles').select('is_platform_admin').eq('id', userId).maybeSingle(),
    supabase.from('app_grants').select('app, max_workspaces'),
    supabase.from('workspaces').select('app').eq('owner_id', userId),
  ]);

  const isPlatformAdmin = profile?.is_platform_admin ?? false;

  // Hosted apps only. `app.can_create()` says yes to an admin for every value
  // of the enum, including the five that are still on GitHub Pages — and a
  // second Scoundrel would be a workspace with nothing behind it. The database
  // would allow it; this is what stops it being offered.
  if (isPlatformAdmin) {
    return { isPlatformAdmin, creatable: HOSTED_APPS.map(a => ({ app: a.slug, remaining: null })) };
  }

  // Quota counts what you created, not what you own the role for — being made
  // co-owner of someone else's project does not spend your own allowance.
  const ownedByApp = new Map<AppSlug, number>();
  for (const row of owned ?? []) {
    ownedByApp.set(row.app, (ownedByApp.get(row.app) ?? 0) + 1);
  }

  const creatable = (grants ?? []).flatMap(({ app, max_workspaces }) => {
    const remaining = max_workspaces - (ownedByApp.get(app) ?? 0);
    return remaining > 0 ? [{ app, remaining }] : [];
  });

  return { isPlatformAdmin, creatable };
}

/**
 * The custom SQLSTATEs the invite and creation functions raise, as sentences.
 *
 * The functions carry their own messages, but those name columns and values —
 * fine in a log, wrong on a page. Anything unrecognised falls through to the
 * database's own wording rather than a generic apology, because an unexpected
 * failure is more useful legible than tidy.
 */
const MESSAGES: Record<string, string> = {
  GRK01: 'That invitation is no longer valid — it may have expired or already been used.',
  GRK02: 'That invitation was sent to a different email address. Sign in with that address, or ask whoever invited you to send it again.',
  GRK03: 'You do not have permission to create another project in that app.',
  GRK04: 'That address is already taken — try a different one.',
};

export function describeGrantError(error: { code?: string; message: string }): string {
  return (error.code && MESSAGES[error.code]) || error.message;
}
