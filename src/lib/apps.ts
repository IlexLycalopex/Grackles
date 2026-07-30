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
  tagline: string;
}

export const APPS: AppDefinition[] = [
  {
    slug: 'listening-party',
    path: 'lp',
    name: 'Listening Party',
    tagline: 'One album a week, one year at a time.',
  },
  {
    slug: 'reading-list',
    path: 'reading',
    name: 'Reading List',
    tagline: 'Everything read, by year.',
  },
  {
    slug: 'cigar-lounge',
    path: 'cigars',
    name: 'Cigar Lounge',
    tagline: 'Humidor and tasting notes.',
  },
];

const BY_SLUG = new Map(APPS.map(a => [a.slug, a]));
const BY_PATH = new Map(APPS.map(a => [a.path, a]));

export const appBySlug = (slug: AppSlug) => BY_SLUG.get(slug);
export const appByPath = (path: string) => BY_PATH.get(path);

/** The canonical URL for a workspace, e.g. /lp/brothers */
export function workspaceHref(app: AppSlug, slug: string): string {
  return `/${BY_SLUG.get(app)?.path ?? app}/${slug}`;
}

/**
 * The eight sites the launcher has always linked to. The three being migrated
 * now point at their new in-app routes; the rest stay on GitHub Pages until
 * they have somewhere better to go.
 */
export interface LauncherLink {
  label: string;
  href: string;
  external: boolean;
}

export const LAUNCHER_LINKS: LauncherLink[] = [
  { label: 'Atelier Obscura', href: 'https://ilexlycalopex.github.io/Atelier-Obscura/', external: true },
  { label: 'Lanternwood', href: 'https://ilexlycalopex.github.io/Lanternwood-Adventures/', external: true },
  { label: 'Spelltome', href: 'http://www.lycalopex.co.uk/', external: true },
  { label: 'Listening Party', href: '/lp/brothers', external: false },
  { label: 'Reading List', href: '/reading/jamie', external: false },
  { label: 'Scoundrel', href: 'https://ilexlycalopex.github.io/scoundrel/', external: true },
  { label: 'Cigar Lounge', href: '/cigars/jamie', external: false },
  { label: 'WBPR 1680 AM', href: 'https://ilexlycalopex.github.io/WBPR/', external: true },
];
