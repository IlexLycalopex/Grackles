import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { AppSlug, Database, MemberRole, Visibility } from '../database.types';
import { APPS, HOSTED_APPS, appBySlug } from '../apps';
import { describeAdminError, describeGrantError, loadEntitlements } from '../grants';
import { sendInviteEmail } from '../email';
import { slugify } from '../slug';
import { planAccessChanges, accessKey } from './access';

/**
 * The admin console's shared half.
 *
 * Every tab posts to itself, and every tab hands the form to handleAction(),
 * so a control works the same wherever it appears — a role changed from a
 * person's page and from a project's page is one code path, with one set of
 * sentences for what went wrong.
 *
 * All reads and writes go through the admin_ functions, which check
 * app.is_platform_admin() themselves. requireAdmin() is what keeps the page
 * from being drawn; it is not what keeps the data safe.
 */

type Client = SupabaseClient<Database>;
type Fns = Database['public']['Functions'];
export type Person = Fns['admin_people']['Returns'][number];
export type Project = Fns['admin_projects']['Returns'][number];
export type Invite = Fns['admin_invites']['Returns'][number];

export const ROLES: MemberRole[] = ['viewer', 'editor', 'owner'];
export const VISIBILITIES: Visibility[] = ['private', 'unlisted', 'public'];
/** Anything this repo does not serve can be filed as a link. */
export const LINKABLE = APPS.filter(a => !a.hosted);

export interface Outcome {
  error: string | null;
  notice: string | null;
  /** An invitation whose email did not go, so it can be passed on by hand. */
  inviteLink?: string | null;
  redirect?: string;
}

/**
 * 404 rather than 403 for everyone else, matching how a private project
 * behaves: a page that refuses differently from a page that does not exist is
 * a page that confirms it exists.
 */
export async function isAdmin(supabase: Client, user: User | null): Promise<boolean> {
  if (!user) return false;
  const { isPlatformAdmin } = await loadEntitlements(supabase, user.id);
  return isPlatformAdmin;
}

export const notFound = () => new Response('Not found', { status: 404 });

export const personName = (p: { display_name: string | null; email: string }) =>
  p.display_name || p.email;

export const appName = (slug: AppSlug) => appBySlug(slug)?.name ?? slug;

export const when = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export const isLink = (p: { app: AppSlug; external_url: string | null }) =>
  Boolean(p.external_url) || !appBySlug(p.app)?.hosted;

/**
 * What kind of thing a project is, for a subtitle: "link", or its app's name —
 * or nothing when that would only repeat the project's own name, which it
 * usually does ("Listening Party (Listening Party)").
 */
export function projectKind(p: { app: AppSlug; name: string; external_url: string | null }): string {
  const kind = isLink(p) ? 'link' : appName(p.app);
  return kind === p.name ? '' : kind;
}

/** Hosted projects first, then links, each group by app and then name. */
export function sortProjects<T extends { app: AppSlug; name: string; external_url: string | null }>(rows: T[]): T[] {
  const order = new Map(APPS.map((a, i) => [a.slug, i]));
  return [...rows].sort(
    (a, b) =>
      Number(isLink(a)) - Number(isLink(b)) ||
      (order.get(a.app) ?? 99) - (order.get(b.app) ?? 99) ||
      a.name.localeCompare(b.name)
  );
}

/** Every membership on the site, as "workspace:user" → role. One read per person. */
export async function loadMemberships(supabase: Client, people: Person[]) {
  const map = new Map<string, MemberRole>();
  await Promise.all(
    people.map(async p => {
      const { data } = await supabase.rpc('admin_person_projects', { p_user: p.id });
      for (const row of data ?? []) map.set(accessKey(row.workspace_id, p.id), row.role);
    })
  );
  return map;
}

type Result = { error: { code?: string; message: string } | null };

export async function handleAction(
  supabase: Client,
  user: User,
  form: FormData,
  origin: string
): Promise<Outcome> {
  const action = String(form.get('action') ?? '');
  const str = (k: string) => String(form.get(k) ?? '').trim();
  const role = (k: string): MemberRole =>
    ROLES.includes(str(k) as MemberRole) ? (str(k) as MemberRole) : 'viewer';

  const run = async (call: PromiseLike<Result>, said: string): Promise<Outcome> => {
    const { error } = await call;
    return error ? { error: describeAdminError(error), notice: null } : { error: null, notice: said };
  };

  // Names for the sentences, so a notice says "Nick is now an editor of
  // Commonplace" rather than "Role changed", which after an in-place save is
  // the only confirmation there is.
  const [{ data: people }, { data: projects }] = await Promise.all([
    supabase.rpc('admin_people'),
    supabase.rpc('admin_projects'),
  ]);
  const who = (id: string) => {
    const p = (people ?? []).find(x => x.id === id);
    return p ? personName(p) : 'They';
  };
  const what = (id: string) => (projects ?? []).find(x => x.id === id)?.name ?? 'that project';

  switch (action) {
    case 'admin': {
      const on = form.get('is_admin') !== null;
      const out = await run(
        supabase.rpc('admin_set_platform_admin', { p_user: str('user_id'), p_is_admin: on }),
        on ? `${who(str('user_id'))} is now a platform admin.` : `${who(str('user_id'))} is no longer a platform admin.`
      );
      // Every read on the page would now be refused, and a 404 in answer to
      // your own save reads as something having broken.
      if (!out.error && !on && str('user_id') === user.id) out.redirect = '/dashboard';
      return out;
    }

    case 'grant': {
      const max = Math.max(0, Math.min(20, Number(str('max')) || 0));
      return run(
        supabase.rpc('admin_set_grant', { p_user: str('user_id'), p_app: str('app') as AppSlug, p_max: max }),
        max > 0
          ? `${who(str('user_id'))} may start ${max} ${appName(str('app') as AppSlug)} project${max === 1 ? '' : 's'}.`
          : `${who(str('user_id'))} may no longer start a ${appName(str('app') as AppSlug)}.`
      );
    }

    case 'member-add':
      return run(
        supabase.rpc('admin_add_member', {
          p_workspace: str('workspace_id'), p_user: str('user_id'), p_role: role('role'),
        }),
        `${who(str('user_id'))} added to ${what(str('workspace_id'))} as ${role('role')}.`
      );

    case 'member-role':
      return run(
        supabase.rpc('admin_set_member_role', {
          p_workspace: str('workspace_id'), p_user: str('user_id'), p_role: role('role'),
        }),
        `${who(str('user_id'))} is now ${role('role') === 'owner' ? 'an owner' : `a ${role('role')}`} of ${what(str('workspace_id'))}.`
      );

    case 'member-remove':
      return run(
        supabase.rpc('admin_remove_member', { p_workspace: str('workspace_id'), p_user: str('user_id') }),
        `${who(str('user_id'))} removed from ${what(str('workspace_id'))}.`
      );

    case 'visibility': {
      const v = VISIBILITIES.includes(str('visibility') as Visibility) ? (str('visibility') as Visibility) : 'private';
      return run(
        supabase.rpc('admin_set_visibility', { p_workspace: str('workspace_id'), p_visibility: v }),
        `${what(str('workspace_id'))} is now ${v}.`
      );
    }

    case 'revoke-invite':
      return run(supabase.rpc('admin_revoke_invite', { p_invite: str('invite_id') }), 'Invitation revoked.');

    case 'resend-invite': {
      // Read straight from the table: invites_read admits a platform admin,
      // and the token is what the email is for. Resending keeps the token, so
      // a link already passed on by hand keeps working.
      const { data: inv } = await supabase
        .from('workspace_invites')
        .select('email, role, token, expires_at, grant_apps, workspace_id')
        .eq('id', str('invite_id'))
        .is('accepted_at', null)
        .maybeSingle();
      if (!inv) return { error: 'That invitation is no longer waiting.', notice: null };
      const project = (projects ?? []).find(p => p.id === inv.workspace_id) ?? null;
      const url = `${origin}/invite/${inv.token}`;
      const sent = await sendInviteEmail({
        to: inv.email,
        inviteUrl: url,
        workspaceName: project?.name ?? null,
        appName: project ? appName(project.app) : null,
        role: inv.role,
        invitedBy: user.email!,
        expiresAt: inv.expires_at,
        grantedApps: (inv.grant_apps ?? []).map(appName),
      });
      return sent.ok
        ? { error: null, notice: `Invitation to ${inv.email} sent again.` }
        : { error: `Could not send to ${inv.email} (${sent.reason}). Copy the link instead.`, notice: null, inviteLink: url };
    }

    case 'invite':
      return invite(supabase, user, form, origin, people ?? [], projects ?? []);

    case 'add-link': {
      const name = str('name');
      const url = str('url');
      const slug = slugify(str('slug') || name);
      const app = LINKABLE.some(a => a.slug === str('app')) ? (str('app') as AppSlug) : 'external';
      if (!name) return { error: 'Give the link a name. It is what appears on the launcher.', notice: null };
      if (!slug) return { error: 'That name has no letters or numbers in it, so it cannot become an address. Set one.', notice: null };
      if (!/^https?:\/\//.test(url)) return { error: 'A link has to point at an http:// or https:// address.', notice: null };
      const { error } = await supabase.rpc('add_link', {
        p_name: name, p_url: url, p_slug: slug, p_app: app,
        p_visibility: str('visibility') === 'private' ? 'private' : 'public',
      });
      return error
        ? { error: describeGrantError(error), notice: null }
        : { error: null, notice: `${name} is on the launcher.` };
    }

    case 'access': {
      const current = await loadMemberships(supabase, people ?? []);
      const plan = planAccessChanges(current, [...form.entries()].map(([k, v]) => [k, String(v)]));
      if (plan.length === 0) return { error: null, notice: 'Nothing had changed.' };

      const done: string[] = [];
      const failed: string[] = [];
      for (const c of plan) {
        const call =
          c.kind === 'add'
            ? supabase.rpc('admin_add_member', { p_workspace: c.workspace, p_user: c.user, p_role: c.role })
            : c.kind === 'role'
              ? supabase.rpc('admin_set_member_role', { p_workspace: c.workspace, p_user: c.user, p_role: c.role })
              : supabase.rpc('admin_remove_member', { p_workspace: c.workspace, p_user: c.user });
        const { error } = await call;
        const label =
          c.kind === 'remove'
            ? `${who(c.user)} out of ${what(c.workspace)}`
            : `${who(c.user)} ${c.role} of ${what(c.workspace)}`;
        if (error) failed.push(`${label}: ${describeAdminError(error)}`);
        else done.push(label);
      }
      return {
        error: failed.length ? `Not applied: ${failed.join(' ')}` : null,
        notice: done.length ? `Applied ${done.length} change${done.length === 1 ? '' : 's'}: ${done.join('; ')}.` : null,
      };
    }
  }

  return { error: null, notice: null };
}

/**
 * Bring somebody in. An address that already has an account is added
 * directly — an invitation would be a round trip through their inbox to the
 * same rows — and anybody else is sent an invitation.
 */
async function invite(
  supabase: Client,
  user: User,
  form: FormData,
  origin: string,
  people: Person[],
  projects: Project[]
): Promise<Outcome> {
  const str = (k: string) => String(form.get(k) ?? '').trim();
  const email = str('email').toLowerCase();
  const role = ROLES.includes(str('role') as MemberRole) ? (str('role') as MemberRole) : 'viewer';
  const grantApps = form.getAll('grant_apps').map(String)
    .filter((a): a is AppSlug => HOSTED_APPS.some(h => h.slug === a));
  const project = projects.find(p => p.id === str('workspace_id')) ?? null;
  const existing = people.find(p => p.email.toLowerCase() === email) ?? null;

  if (!email || !email.includes('@')) {
    return { error: 'Enter the email address they sign in with.', notice: null };
  }
  if (!project && grantApps.length === 0) {
    return { error: 'Choose a project for them, an app they may start, or both.', notice: null };
  }

  if (existing) {
    const done: string[] = [];
    if (project) {
      const { error } = await supabase.rpc('admin_add_member', {
        p_workspace: project.id, p_user: existing.id, p_role: role,
      });
      if (error) return { error: describeAdminError(error), notice: null };
      done.push(`added to ${project.name} as ${role}`);
    }
    for (const app of grantApps) {
      // Topped up to one rather than set to one: somebody already allowed
      // three should not lose two by being invited again.
      if ((existing.grants?.[app] ?? 0) > 0) continue;
      const { error } = await supabase.rpc('admin_set_grant', { p_user: existing.id, p_app: app, p_max: 1 });
      if (error) return { error: describeAdminError(error), notice: null };
      done.push(`may start a ${appName(app)}`);
    }
    return {
      error: null,
      notice: done.length
        ? `${personName(existing)} already has an account, so no invitation was needed: ${done.join(', ')}.`
        : `${personName(existing)} already had all of that.`,
    };
  }

  const { data: created, error } = await supabase
    .from('workspace_invites')
    .insert({ workspace_id: project?.id ?? null, email, role, grant_apps: grantApps, invited_by: user.id })
    .select('token, expires_at')
    .single();

  if (error?.code === '23505') {
    return {
      error: project
        ? `${email} already has an invitation to ${project.name} waiting. It is on the Invitations tab.`
        : `${email} already has an invitation waiting. It is on the Invitations tab.`,
      notice: null,
    };
  }
  if (error || !created) return { error: error?.message ?? 'The invitation was not saved.', notice: null };

  const url = `${origin}/invite/${created.token}`;
  const sent = await sendInviteEmail({
    to: email,
    inviteUrl: url,
    workspaceName: project?.name ?? null,
    appName: project ? appName(project.app) : null,
    role,
    invitedBy: user.email!,
    expiresAt: created.expires_at,
    grantedApps: grantApps.map(appName),
  });
  return sent.ok
    ? { error: null, notice: `Invitation sent to ${email}.` }
    : {
        error: null,
        notice: `Invitation saved for ${email}, but the email did not go (${sent.reason}). Send them this link:`,
        inviteLink: url,
      };
}
