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
    slug: 'cigar-lounge',
    path: 'cigars',
    name: 'Cigar Lounge',
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
