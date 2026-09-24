import placesJson from '../../data/gazetteer/places.json' with { type: 'json' };

/**
 * The built-in decks, and the facts they are made of.
 *
 * A card is a fact, not a row in a deck (docs/commonplace-spec.md, "The rule
 * that shapes everything"). France is one fact whether it is asked in Europe,
 * the world or a capitals round, so a deck here is only a selection: which map
 * it is drawn on, which places it includes, and whether it asks for names or
 * capitals. Every card reference it produces is shared with every other deck
 * that includes the same place.
 */

export interface Place {
  name: string;
  accepts: string[];
  continents: string[];
  region: string;
  tags: string[];
  capital: { name: string; accepts: string[]; also: string[] } | null;
  neighbours: string[];
}

export const PLACES = placesJson as Record<string, Place>;

export type MapId =
  | 'world' | 'europe' | 'africa' | 'asia' | 'north-america' | 'south-america' | 'oceania' | 'us-states';

/** What a map deck asks about a place: its name, or its capital. */
export type Topic = 'places' | 'capitals';

export interface MapDeck {
  kind: 'map';
  slug: string;
  title: string;
  map: MapId;
  topic: Topic;
  /** Continent id in places.json; null for the whole world. */
  continent: string | null;
  /** Regions offered as scopes, in the order they are listed. */
  regions: string[];
  blurb: string;
}

export { REGION_LABEL } from './regions.ts';

const CONTINENTS: { id: string; map: MapId; title: string; regions: string[] }[] = [
  { id: 'europe', map: 'europe', title: 'Europe', regions: ['northern-europe', 'western-europe', 'southern-europe', 'eastern-europe', 'balkans', 'nordic', 'baltics'] },
  { id: 'africa', map: 'africa', title: 'Africa', regions: ['north-africa', 'west-africa', 'central-africa', 'east-africa', 'southern-africa'] },
  { id: 'asia', map: 'asia', title: 'Asia', regions: ['middle-east', 'caucasus', 'central-asia', 'south-asia', 'southeast-asia', 'east-asia'] },
  { id: 'north-america', map: 'north-america', title: 'North and Central America', regions: ['northern-america', 'central-america', 'caribbean'] },
  { id: 'south-america', map: 'south-america', title: 'South America', regions: [] },
  { id: 'oceania', map: 'oceania', title: 'Oceania', regions: ['australasia', 'melanesia', 'micronesia', 'polynesia'] },
];

export const MAP_DECKS: MapDeck[] = [
  {
    kind: 'map', slug: 'us-states', title: 'US states', map: 'us-states', topic: 'places',
    continent: 'us', regions: ['new-england', 'mid-atlantic', 'midwest', 'south', 'west'],
    blurb: 'All fifty, with the District of Columbia as an extra.',
  },
  {
    kind: 'map', slug: 'us-capitals', title: 'US state capitals', map: 'us-states', topic: 'capitals',
    continent: 'us', regions: ['new-england', 'mid-atlantic', 'midwest', 'south', 'west'],
    blurb: 'Fifty state capitals, from Montgomery to Cheyenne.',
  },
  ...CONTINENTS.map(c => ({
    kind: 'map' as const, slug: c.id, title: c.title, map: c.map, topic: 'places' as const,
    continent: c.id, regions: c.regions, blurb: `The countries of ${c.title}.`,
  })),
  {
    kind: 'map', slug: 'world', title: 'The world', map: 'world', topic: 'places',
    continent: null, regions: [], blurb: 'Every country on one map.',
  },
  ...CONTINENTS.map(c => ({
    kind: 'map' as const, slug: `${c.id}-capitals`, title: `${c.title}: capitals`, map: c.map,
    topic: 'capitals' as const, continent: c.id, regions: c.regions,
    blurb: `The capital cities of ${c.title}.`,
  })),
  {
    kind: 'map', slug: 'world-capitals', title: 'World capitals', map: 'world', topic: 'capitals',
    continent: null, regions: [], blurb: 'The capital of every country.',
  },
];

export const deckBySlug = (slug: string) => MAP_DECKS.find(d => d.slug === slug);

export interface Inclusion {
  territories: boolean;
  disputed: boolean;
}

export const DEFAULT_INCLUSION: Inclusion = { territories: false, disputed: true };

/**
 * The places a deck includes. Capitals decks leave out anything without a
 * capital to ask for (territories, DC, Western Sahara) whatever the switches
 * say, because there is no card to play.
 */
export function deckPlaceKeys(deck: MapDeck, inc: Inclusion = DEFAULT_INCLUSION): string[] {
  return Object.entries(PLACES)
    .filter(([key, p]) => {
      const isState = key.startsWith('US-');
      if (deck.continent === 'us') {
        if (!isState) return false;
      } else if (isState) {
        return false;
      } else if (deck.continent && !p.continents.includes(deck.continent)) {
        return false;
      }
      if (deck.topic === 'capitals' && (!p.capital || p.tags.includes('territory'))) return false;
      if (!inc.territories && p.tags.includes('territory')) return false;
      if (!inc.disputed && p.tags.includes('disputed')) return false;
      return true;
    })
    .map(([key]) => key)
    .sort();
}

/** Whether a place falls inside a region scope. Regions and tags share a namespace. */
export const inRegion = (key: string, region: string) => {
  const p = PLACES[key];
  return !!p && (p.region === region || p.tags.includes(region));
};

// ── Card references ───────────────────────────────────────────────────
//
//   place:FRA:name       this shape is France           shape → name
//   place:FRA:locate     France is this shape           name → shape
//   place:FRA:capital    France's capital is Paris      shape → capital
//   capital:FRA:country  Paris is France's capital      capital → shape
//   card:<uuid>:fwd      a flashcard, front to back
//   card:<uuid>:rev      a flashcard, back to front

export type Direction = 'name' | 'locate' | 'capital' | 'country' | 'fwd' | 'rev';

export type ParsedRef =
  | { kind: 'place'; key: string; dir: 'name' | 'locate' | 'capital' | 'country' }
  | { kind: 'card'; id: string; dir: 'fwd' | 'rev' };

export function placeRef(key: string, dir: 'name' | 'locate' | 'capital' | 'country'): string {
  return dir === 'country' ? `capital:${key}:country` : `place:${key}:${dir}`;
}

export const cardRef = (id: string, dir: 'fwd' | 'rev') => `card:${id}:${dir}`;

/** The same pattern cp_record_answer() checks. Kept identical on purpose. */
export const REF_PATTERN =
  /^(place:[A-Z0-9-]+:(name|locate|capital)|capital:[A-Z0-9-]+:country|card:[0-9a-f-]{36}:(fwd|rev))$/;

export function parseRef(ref: string): ParsedRef | null {
  if (!REF_PATTERN.test(ref)) return null;
  const [head, id, dir] = ref.split(':');
  if (head === 'card') return { kind: 'card', id, dir: dir as 'fwd' | 'rev' };
  if (head === 'capital') return { kind: 'place', key: id, dir: 'country' };
  return { kind: 'place', key: id, dir: dir as 'name' | 'locate' | 'capital' };
}

/**
 * The deck a place fact is reviewed in: the smallest map that shows it. France
 * is reviewed on the Europe map, Texas on the US map, a capital fact in the
 * matching capitals deck.
 */
export function homeDeck(ref: string): string | null {
  const parsed = parseRef(ref);
  if (!parsed || parsed.kind !== 'place') return null;
  const capitals = parsed.dir === 'capital' || parsed.dir === 'country';
  if (parsed.key.startsWith('US-')) return capitals ? 'us-capitals' : 'us-states';
  const p = PLACES[parsed.key];
  if (!p) return null;
  const continent = p.continents[0];
  return capitals ? `${continent}-capitals` : continent;
}

/** The refs a map deck's facts are stored under, both directions. */
export function deckRefs(deck: MapDeck, keys: string[]): string[] {
  const dirs = deck.topic === 'places' ? (['name', 'locate'] as const) : (['capital', 'country'] as const);
  return keys.flatMap(k => dirs.map(d => placeRef(k, d)));
}

/** The answers that count for a fact: the answer shown first, then the rest. */
export function acceptedFor(key: string, dir: 'name' | 'locate' | 'capital' | 'country'): string[] {
  const p = PLACES[key];
  if (!p) return [];
  if (dir === 'capital') return p.capital ? [p.capital.name, ...p.capital.accepts, ...p.capital.also] : [];
  return [p.name, ...p.accepts];
}
