import type { AppSlug } from './database.types';

/**
 * The registry of apps that live under Grackles.
 *
 * `app_slug` in the database and `path` in the URL are deliberately separate:
 * the enum value is stable storage, the path is short because people type and
 * share it. A workspace at /lp/brothers is app 'listening-party', slug
 * 'brothers'.
 */
export interface AppDefinition {
  slug: AppSlug;
  /** URL segment, e.g. 'lp' → /lp/:workspace */
  path: string;
  name: string;
  /**
   * Whether this app has routes in this repo. The five that do not are still
   * on GitHub Pages; their workspaces carry an `external_url` and the launcher
   * links there instead. `path` is what they will answer to once they move in.
   */
  hosted: boolean;
  tagline?: string;
}

export const APPS: AppDefinition[] = [
  {
    slug: 'listening-party',
    path: 'lp',
    name: 'Listening Party',
    hosted: true,
    tagline: 'One album a week, one year at a time.',
  },
  {
    slug: 'reading-list',
    path: 'reading',
    name: 'Reading List',
    hosted: true,
    tagline: 'Everything read, by year.',
  },
  {
    // The slug is the database's name for the app and stays as it is; `name`
    // is what people read, and the app goes by Cedarhouse.
    slug: 'cigar-lounge',
    path: 'cigars',
    name: 'Cedarhouse',
    hosted: true,
    tagline: 'Humidor and tasting notes.',
  },
  {
    slug: 'wbpr',
    path: 'wbpr',
    name: 'WBPR 1680 AM',
    hosted: true,
    tagline: 'Broadcasting until the signal holds.',
  },
  {
    slug: 'blackletter',
    path: 'blackletter',
    name: 'Blackletter',
    hosted: true,
    tagline: 'Six letters, six guesses, one word a day.',
  },
  // No taglines below: an invented sentence about a site nobody has described
  // yet would read as fact. They get one when they move in.
  { slug: 'atelier-obscura', path: 'atelier', name: 'Atelier Obscura', hosted: false },
  { slug: 'lanternwood', path: 'lanternwood', name: 'Lanternwood', hosted: false },
  { slug: 'spelltome', path: 'spelltome', name: 'Spelltome', hosted: false },
  { slug: 'scoundrel', path: 'scoundrel', name: 'Scoundrel', hosted: false },
];

/**
 * The apps a project can be *started* in, which is a smaller list than the
 * apps a project can *be*. Creating a second Scoundrel is meaningless — there
 * is one site and it is not served from here — so entitlements, the create
 * form and the invite grant picker all work from this list rather than APPS.
 */
export const HOSTED_APPS: AppDefinition[] = APPS.filter(a => a.hosted);

const BY_SLUG = new Map(APPS.map(a => [a.slug, a]));
const BY_PATH = new Map(APPS.map(a => [a.path, a]));

export const appBySlug = (slug: AppSlug) => BY_SLUG.get(slug);
export const appByPath = (path: string) => BY_PATH.get(path);

/** The canonical in-app URL for a workspace, e.g. /lp/brothers */
export function workspaceHref(app: AppSlug, slug: string): string {
  return `/${BY_SLUG.get(app)?.path ?? app}/${slug}`;
}

/** Just enough of a workspace row to know where its front door is. */
export interface Linkable {
  app: AppSlug;
  slug: string;
  external_url: string;
}

/**
 * Where a project actually lives.
 *
 * `external_url` wins over the in-app route whenever it is set, which is what
 * makes migrating a site a one-column update: clear the column and the same
 * workspace, at the same address, starts being served from here. It is checked
 * rather than `hosted` deliberately — the column is the per-project fact, and
 * a hosted app is allowed to point outward during a cutover.
 */
export function projectHref(ws: Linkable): string {
  return ws.external_url || workspaceHref(ws.app, ws.slug);
}

/** A URL that names a project: which app, which project, and what came after. */
export interface ProjectPath {
  app: AppDefinition;
  slug: string;
  /** '/settings' when this is the project's settings page, '' otherwise. */
  prefix: string;
  /** Everything below the project, leading slash included, or '' at its root. */
  rest: string;
}

const SETTINGS = '/settings';

/**
 * Read `/cigars/jamie/the-padron` as "the Cedarhouse at jamie, then a record".
 *
 * Only used by the middleware, and only once a response has already come back
 * 404, to ask whether the address used to belong to something. Returns null
 * for anything that is not shaped like a project — `/dashboard`, `/api/…`, or
 * an app path with nothing after it — so that the lookup it guards never runs
 * for a page that was never going to be a project in the first place.
 *
 * `/settings` in front is the same project at the same address, so it is
 * recognised and handed back: the owner who has just changed an address is the
 * one person certain to have the old settings page open.
 */
export function splitProjectPath(pathname: string): ProjectPath | null {
  const prefix = pathname.startsWith(`${SETTINGS}/`) ? SETTINGS : '';
  const [, first, second, ...rest] = pathname.slice(prefix.length).split('/');
  if (!first || !second) return null;

  const app = BY_PATH.get(first);
  if (!app) return null;

  return { app, slug: second, prefix, rest: rest.length ? `/${rest.join('/')}` : '' };
}
