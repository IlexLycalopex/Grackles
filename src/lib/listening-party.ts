import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

/**
 * Data access for the Listening Party.
 *
 * Replaces the synchronous loaders in the old repo's src/lib/data.ts. Those
 * read YAML at build time and could be plain module constants; these are
 * per-request queries scoped to a workspace, so everything is async and takes
 * an explicit `workspaceId`. There is no ambient "current season" — the caller
 * says what it wants.
 */

export interface Contributor {
  id: string;
  slug: string;
  name: string;
  color: string;
  userId: string | null;
}

export interface Selection {
  id: string;
  week: number;
  yearSlot: number;
  album: string;
  artist: string;
  status: 'completed' | 'upcoming';
  artworkUrl: string;
  links: { wikipedia: string; spotify: string; youtube: string };
  notes: string;
  contributor: Contributor;
  /** Season slug, e.g. '2026'. The artists page spans seasons and needs it. */
  seasonSlug: string;
  /** Season primary key, so the edit form can offer to move a pick. */
  seasonId: string;
}

export interface Season {
  id: string;
  slug: string;
  title: string;
  description: string;
  totalWeeks: number;
  status: string;
  sortOrder: number;
}

export interface SeasonWithPicks extends Season {
  selections: Selection[];
}

const CONTRIBUTOR_COLUMNS = 'id, slug, name, color, user_id';

const SELECTION_COLUMNS = `
  id, week, year_slot, album, artist, status, artwork_url,
  link_wikipedia, link_spotify, link_youtube, notes,
  lp_contributors ( ${CONTRIBUTOR_COLUMNS} ),
  lp_seasons ( id, slug )
`;

type RawContributor = {
  id: string;
  slug: string;
  name: string;
  color: string;
  user_id: string | null;
};

function toContributor(row: RawContributor): Contributor {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    color: row.color,
    userId: row.user_id,
  };
}

/** Stands in for a contributor row that RLS returned but the join lost. */
const UNKNOWN_CONTRIBUTOR: Contributor = {
  id: '',
  slug: 'unknown',
  name: 'Unknown',
  color: '#888888',
  userId: null,
};

function toSelection(row: any): Selection {
  return {
    id: row.id,
    week: row.week,
    yearSlot: row.year_slot,
    album: row.album,
    artist: row.artist,
    status: row.status === 'completed' ? 'completed' : 'upcoming',
    artworkUrl: row.artwork_url ?? '',
    links: {
      wikipedia: row.link_wikipedia ?? '',
      spotify: row.link_spotify ?? '',
      youtube: row.link_youtube ?? '',
    },
    notes: row.notes ?? '',
    contributor: row.lp_contributors ? toContributor(row.lp_contributors) : UNKNOWN_CONTRIBUTOR,
    seasonSlug: row.lp_seasons?.slug ?? '',
    seasonId: row.lp_seasons?.id ?? '',
  };
}

export async function loadContributors(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<Contributor[]> {
  const { data } = await supabase
    .from('lp_contributors')
    .select(CONTRIBUTOR_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('sort_order');

  return (data ?? []).map(toContributor);
}

export async function loadSeasons(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<Season[]> {
  const { data } = await supabase
    .from('lp_seasons')
    .select('id, slug, title, description, total_weeks, status, sort_order')
    .eq('workspace_id', workspaceId)
    .order('sort_order');

  return (data ?? []).map(s => ({
    id: s.id,
    slug: s.slug,
    title: s.title,
    description: s.description,
    totalWeeks: s.total_weeks,
    status: s.status,
    sortOrder: s.sort_order,
  }));
}

/**
 * The season a workspace opens on: the last one marked active, falling back to
 * the last season of any kind. Mirrors how the old index.astro picked the last
 * `status: active` entry in seasons.yaml.
 */
export function pickCurrentSeason(seasons: Season[]): Season | null {
  if (seasons.length === 0) return null;
  const active = seasons.filter(s => s.status === 'active');
  return active.length > 0 ? active[active.length - 1]! : seasons[seasons.length - 1]!;
}

export async function loadSeason(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  seasonSlug: string
): Promise<SeasonWithPicks | null> {
  const { data: season } = await supabase
    .from('lp_seasons')
    .select('id, slug, title, description, total_weeks, status, sort_order')
    .eq('workspace_id', workspaceId)
    .eq('slug', seasonSlug)
    .maybeSingle();

  if (!season) return null;

  const { data: picks } = await supabase
    .from('lp_selections')
    .select(SELECTION_COLUMNS)
    .eq('season_id', season.id)
    .order('week');

  return {
    id: season.id,
    slug: season.slug,
    title: season.title,
    description: season.description,
    totalWeeks: season.total_weeks,
    status: season.status,
    sortOrder: season.sort_order,
    selections: (picks ?? []).map(toSelection),
  };
}

export async function loadAllSelections(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<Selection[]> {
  const { data } = await supabase
    .from('lp_selections')
    .select(SELECTION_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('week');

  return (data ?? []).map(toSelection);
}

export async function loadSelection(
  supabase: SupabaseClient<Database>,
  selectionId: string
): Promise<Selection | null> {
  const { data } = await supabase
    .from('lp_selections')
    .select(SELECTION_COLUMNS)
    .eq('id', selectionId)
    .maybeSingle();

  return data ? toSelection(data) : null;
}

// ── Derived views ───────────────────────────────────────────────────
// Ported from the old src/lib/data.ts so the pages render identically.

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/** The completed pick with the highest week number. */
export function nowPlaying(selections: Selection[]): Selection | null {
  const completed = selections.filter(s => s.status === 'completed');
  if (completed.length === 0) return null;
  return completed.reduce((best, s) => (s.week > best.week ? s : best));
}

/** Completed picks grouped by the year they represent, oldest year first. */
export function groupByYear(selections: Selection[]): [number, Selection[]][] {
  const byYear = new Map<number, Selection[]>();
  for (const sel of selections) {
    if (!byYear.has(sel.yearSlot)) byYear.set(sel.yearSlot, []);
    byYear.get(sel.yearSlot)!.push(sel);
  }
  return [...byYear.entries()].sort(([a], [b]) => a - b);
}

export interface ArtistSummary {
  name: string;
  slug: string;
  picks: Selection[];
}

/** Every artist with at least one completed pick, alphabetical. */
export function groupByArtist(selections: Selection[]): ArtistSummary[] {
  const byArtist = new Map<string, Selection[]>();
  for (const sel of selections) {
    if (sel.status !== 'completed' || !sel.artist) continue;
    if (!byArtist.has(sel.artist)) byArtist.set(sel.artist, []);
    byArtist.get(sel.artist)!.push(sel);
  }
  return [...byArtist.entries()]
    .map(([name, picks]) => ({ name, slug: slugify(name), picks }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
