#!/usr/bin/env node
/**
 * Builds Gazetteer's maps and place list from the atlases.
 *
 *   node scripts/build-gazetteer.mjs
 *
 * Run by hand when countries.mjs, us-states.mjs or this file changes, and the
 * output committed. Never at deploy time: the output is content, and content is
 * reviewed as a diff (see docs/commonplace-spec.md, "Built-in content is
 * files, not rows").
 *
 * Sources, both public domain and both pinned by package-lock.json:
 *   world-atlas 2.0.2  Natural Earth 1:50m admin 0 countries
 *   us-atlas 3.0.1     US Census cartographic boundaries, pre-projected Albers
 *
 * What comes out, under src/data/gazetteer/:
 *   places.json        every place's names, region, tags, capital, neighbours
 *   maps/<id>.json     SVG path per place, pre-projected, plus the grey context
 *   report.json        counts, sizes, and every judgement call made on the way
 *
 * The browser draws plain <path> elements from these. It never loads a mapping
 * library, which is the whole reason the projection happens here.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import * as d3 from 'd3-geo';
import * as topojson from 'topojson-client';
import { presimplify, simplify, quantile } from 'topojson-simplify';
import { COUNTRIES, POINTS, MERGE, KEEP_ONLY, CUT_OUT } from './gazetteer/countries.mjs';
import { STATES } from './gazetteer/us-states.mjs';
import { normalise, distance } from '../src/lib/commonplace/normalise.ts';

const require = createRequire(import.meta.url);
const world = require('world-atlas/countries-50m.json');
const us = require('us-atlas/states-albers-10m.json');

const OUT = new URL('../src/data/gazetteer/', import.meta.url);
mkdirSync(new URL('maps/', OUT), { recursive: true });

const report = { generated_from: {}, maps: {}, judgements: [], near_collisions: [] };
for (const pkg of ['world-atlas', 'us-atlas']) {
  report.generated_from[pkg] = JSON.parse(
    readFileSync(require.resolve(`${pkg}/package.json`), 'utf8')
  ).version;
}

// ── Geometry helpers ──────────────────────────────────────────────────
const polygonsOf = g =>
  !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
const multi = polys => ({ type: 'MultiPolygon', coordinates: polys });
const ringCentre = ring => {
  let x = 0, y = 0;
  for (const [a, b] of ring) { x += a; y += b; }
  return [x / ring.length, y / ring.length];
};
const inBox = ([x, y], box) => x >= box.lon[0] && x <= box.lon[1] && y >= box.lat[0] && y <= box.lat[1];

// ── The world: resolve every row to a geometry ────────────────────────
// Simplified once here for the neighbour pass (which wants full detail, so it
// runs on the original) and again per map below.
const geoms = world.objects.countries.geometries;
const byId = new Map();
const byName = new Map();
geoms.forEach((g, i) => {
  // 036 is both Australia and the Ashmore and Cartier Islands. The islands
  // lose: nobody is going to be asked to find them.
  if (g.properties.name === 'Ashmore and Cartier Is.') return;
  if (g.id) byId.set(g.id, i);
  byName.set(g.properties.name, i);
});

/** Atlas geometry index → place key, for everything a row claims. */
const claimedBy = new Map();
for (const row of COUNTRIES) {
  if (!row.atlas) continue;
  if (row.atlas in CUT_OUT) continue;
  const i = byId.get(row.atlas) ?? byName.get(row.atlas);
  if (i === undefined) throw new Error(`${row.key}: no atlas feature ${row.atlas}`);
  claimedBy.set(i, row.key);
}
for (const [key, names] of Object.entries(MERGE)) {
  for (const n of names) {
    const i = byName.get(n);
    if (i === undefined) throw new Error(`merge: no atlas feature ${n}`);
    claimedBy.set(i, key);
    report.judgements.push(`${n} is drawn as part of ${key}`);
  }
}
const antarctica = byName.get('Antarctica');

/** Features for one simplified topology: place key → geometry, plus the rest. */
function worldFeatures(topo) {
  const fc = topojson.feature(topo, topo.objects.countries).features;
  const places = new Map();
  const context = [];
  fc.forEach((f, i) => {
    if (i === antarctica) return;
    const key = claimedBy.get(i);
    if (!key) {
      context.push(f.geometry);
      return;
    }
    let polys = polygonsOf(f.geometry);
    if (KEEP_ONLY[key]) {
      const keep = [];
      for (const p of polys) {
        const centre = ringCentre(p[0]);
        const cut = Object.entries(CUT_OUT).find(
          ([, c]) => c.from === f.id && inBox(centre, c)
        );
        if (cut) places.set(cut[0], multi([...(polygonsOf(places.get(cut[0])) ?? []), p]));
        else if (inBox(centre, KEEP_ONLY[key])) keep.push(p);
        else context.push({ type: 'Polygon', coordinates: p });
      }
      polys = keep;
    }
    places.set(key, multi([...polygonsOf(places.get(key)), ...polys]));
  });
  // Rows that name a cut-out rather than an atlas feature pick their geometry
  // up under the cut-out's name.
  for (const row of COUNTRIES) {
    if (row.atlas in CUT_OUT) {
      places.set(row.key, places.get(row.atlas));
      places.delete(row.atlas);
    }
  }
  return { places, context };
}

// ── Neighbours ────────────────────────────────────────────────────────
// Shared arcs in the unsimplified topology, which is the only honest source:
// simplification can pull two borders apart or push two coasts together.
const neighbours = new Map();
const addNeighbour = (a, b) => {
  if (!a || !b || a === b) return;
  if (!neighbours.has(a)) neighbours.set(a, new Set());
  neighbours.get(a).add(b);
};
topojson.neighbors(geoms).forEach((list, i) => {
  for (const j of list) addNeighbour(claimedBy.get(i), claimedBy.get(j));
});
// France's atlas feature carries French Guiana, so the topology says France
// borders Brazil and Suriname. On the map that is Guiana's border, not France's.
for (const k of ['BRA', 'SUR']) {
  neighbours.get('FRA')?.delete(k);
  neighbours.get(k)?.delete('FRA');
  addNeighbour('GUF', k);
  addNeighbour(k, 'GUF');
}
report.judgements.push('France borders Brazil and Suriname only through French Guiana, so those borders belong to GUF');

const usGeoms = us.objects.states.geometries;
const stateByFips = new Map(STATES.map(s => [s.atlas, s.key]));
topojson.neighbors(usGeoms).forEach((list, i) => {
  for (const j of list) addNeighbour(stateByFips.get(usGeoms[i].id), stateByFips.get(usGeoms[j].id));
});

// ── Maps ──────────────────────────────────────────────────────────────
const WIDTH = 1000;
/**
 * A lon/lat rectangle to fit a projection to, sampled every few degrees along
 * its edges. Four corners are not enough: on a curved projection the widest
 * point of the frame is often the middle of an edge, not a corner.
 */
const box = (lon0, lon1, lat0, lat1) => {
  const coordinates = [];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const lon = lon0 + (lon1 - lon0) * t;
    const lat = lat0 + (lat1 - lat0) * t;
    coordinates.push([lon, lat0], [lon, lat1], [lon0, lat], [lon1, lat]);
  }
  return { type: 'MultiPoint', coordinates };
};

const MAPS = [
  {
    id: 'world', title: 'The world', continents: null, keep: 0.94,
    projection: () => d3.geoEqualEarth(),
    fit: box(-179.9, 179.9, -57, 84),
  },
  {
    id: 'europe', title: 'Europe', continents: ['europe'], keep: 0.8,
    projection: () => d3.geoConicEqualArea().parallels([40, 65]).rotate([-15, 0]),
    fit: box(-25, 45, 34, 71),
  },
  {
    id: 'africa', title: 'Africa', continents: ['africa'], keep: 0.8,
    projection: () => d3.geoAzimuthalEqualArea().rotate([-18, -2]),
    fit: box(-26, 60, -36, 38),
  },
  {
    id: 'asia', title: 'Asia', continents: ['asia'], keep: 0.85,
    projection: () => d3.geoAzimuthalEqualArea().rotate([-88, -30]),
    fit: box(26, 146, -11, 56),
  },
  {
    id: 'north-america', title: 'North and Central America', continents: ['north-america'], keep: 0.8,
    projection: () => d3.geoConicEqualArea().parallels([15, 55]).rotate([95, 0]),
    fit: box(-168, -52, 7, 72),
  },
  {
    id: 'south-america', title: 'South America', continents: ['south-america'], keep: 0.75,
    projection: () => d3.geoAzimuthalEqualArea().rotate([60, 22]),
    fit: box(-82, -34, -56, 13),
  },
  {
    id: 'oceania', title: 'Oceania', continents: ['oceania'], keep: 0.75,
    projection: () => d3.geoAzimuthalEqualArea().rotate([-165, 12]),
    fit: box(112, 188, -48, 16),
  },
];

/** Under this many square pixels a shape gets a dot to tap as well. */
const SMALL_AREA = 150;
/** …and so does one whose longest side is under this many pixels. */
const SMALL_SIDE = 14;

const round = n => Math.round(n * 10) / 10;
const pt = p => p && [round(p[0]), round(p[1])];

function largestPolygon(path, geom) {
  let best = null, area = -1;
  for (const p of polygonsOf(geom)) {
    const g = { type: 'Polygon', coordinates: p };
    const a = path.area(g);
    if (a > area) { area = a; best = g; }
  }
  return best;
}

function drawPlace(path, projection, geom, key, capital, smallArea = SMALL_AREA) {
  const d = geom ? path(geom) ?? '' : '';
  const out = { d };
  if (!d && POINTS[key]) {
    const p = projection(POINTS[key]);
    out.c = pt(p);
    out.b = [round(p[0] - 2), round(p[1] - 2), round(p[0] + 2), round(p[1] + 2)];
    out.small = true;
  } else {
    const main = largestPolygon(path, geom);
    const [[x0, y0], [x1, y1]] = path.bounds(main);
    out.c = pt(path.centroid(main));
    out.b = [round(x0), round(y0), round(x1), round(y1)];
    const area = path.area(geom);
    out.small = area < smallArea || Math.max(x1 - x0, y1 - y0) < SMALL_SIDE;
  }
  if (capital) {
    const p = projection([capital[1], capital[2]]);
    if (p) out.cap = pt(p);
  }
  return out;
}

const worldPre = presimplify(JSON.parse(JSON.stringify(world)));
// Unsimplified, for the islands simplification erases: a place that comes out
// of the simplifier with no area is drawn from this instead.
const worldFull = worldFeatures(world);
const rows = new Map([...COUNTRIES, ...STATES].map(r => [r.key, r]));

function inView(b, w, h) {
  return b[2] >= 0 && b[0] <= w && b[3] >= 0 && b[1] <= h;
}

function writeMap(map) {
  const json = JSON.stringify(map);
  writeFileSync(new URL(`maps/${map.id}.json`, OUT), json + '\n');
  const gz = gzipSync(json).length;
  report.maps[map.id] = {
    places: Object.keys(map.places).length,
    small: Object.values(map.places).filter(p => p.small).length,
    bytes: json.length,
    gzipped: gz,
  };
  return gz;
}

const BUDGET = { world: 250_000, 'us-states': 80_000 };
const DEFAULT_BUDGET = 120_000;

for (const spec of MAPS) {
  const topo = simplify(worldPre, quantile(worldPre, spec.keep === 1 ? 0 : 1 - spec.keep));
  const { places, context } = worldFeatures(topo);

  const projection = spec.projection().fitWidth(WIDTH, spec.fit);
  const [[, fy0], [, fy1]] = d3.geoPath(projection).bounds(spec.fit);
  const height = Math.round(fy1 - fy0);
  projection.fitSize([WIDTH, height], spec.fit);
  // Anything outside the frame is cut at the frame. Russia on the Europe map
  // stops at the edge rather than dragging the view to the Pacific.
  projection.clipExtent([[-2, -2], [WIDTH + 2, height + 2]]);
  const path = d3.geoPath(projection).digits(1);

  const out = { id: spec.id, title: spec.title, viewBox: [0, 0, WIDTH, height], places: {}, context: '' };
  const ctx = [...context];

  for (const [key, geom] of places) {
    const row = rows.get(key);
    const onMap = !spec.continents || row.continents.some(c => spec.continents.includes(c));
    if (!onMap) {
      ctx.push(geom);
      continue;
    }
    const kept = path.area(geom) > 0.01 ? geom : worldFull.places.get(key);
    out.places[key] = drawPlace(path, projection, kept, key, row.capital);
  }
  for (const key of Object.keys(POINTS)) {
    const row = rows.get(key);
    if (spec.continents && !row.continents.some(c => spec.continents.includes(c))) continue;
    out.places[key] = drawPlace(path, projection, null, key, row.capital);
  }
  for (const [key, p] of Object.entries(out.places)) {
    if (!inView(p.b, WIDTH, height)) throw new Error(`${spec.id}: ${key} is outside the frame`);
  }
  out.context = ctx.map(g => path(g) ?? '').join('');

  const gz = writeMap(out);
  const budget = BUDGET[spec.id] ?? DEFAULT_BUDGET;
  if (gz > budget) throw new Error(`${spec.id} is ${gz} bytes gzipped, over its ${budget} budget`);
}

// ── US states ─────────────────────────────────────────────────────────
{
  const pre = presimplify(JSON.parse(JSON.stringify(us)));
  const topo = simplify(pre, quantile(pre, 0.45));
  const fc = topojson.feature(topo, topo.objects.states).features;
  const [w, h] = [975, 610];
  // The atlas is already projected; this only turns its coordinates into
  // path strings. Capitals need the projection it was made with.
  const path = d3.geoPath(null).digits(1);
  const albers = d3.geoAlbersUsa().scale(1300).translate([487.5, 305]);
  const out = { id: 'us-states', title: 'United States', viewBox: [0, 0, w, h], places: {}, context: '' };
  for (const f of fc) {
    const key = stateByFips.get(f.id);
    if (!key) throw new Error(`no state row for FIPS ${f.id}`);
    const row = rows.get(key);
    // Delaware and Rhode Island are real targets on a desktop and slivers on
    // a phone; the higher bar gives both a dot.
    out.places[key] = drawPlace(path, albers, f.geometry, key, row.capital, 400);
  }
  out.context = '';
  const gz = writeMap(out);
  if (gz > BUDGET['us-states']) throw new Error(`us-states is ${gz} bytes gzipped, over budget`);
}

// ── Places ────────────────────────────────────────────────────────────
const places = {};
for (const r of [...COUNTRIES, ...STATES]) {
  places[r.key] = {
    name: r.name,
    accepts: r.accepts,
    continents: r.continents,
    region: r.region,
    tags: r.tags,
    capital: r.capital && {
      name: r.capital[0],
      accepts: r.capital[3] ?? [],
      also: r.capital[4] ?? [],
    },
    neighbours: [...(neighbours.get(r.key) ?? [])].filter(k => rows.has(k)).sort(),
  };
}
writeFileSync(new URL('places.json', OUT), JSON.stringify(places, null, 1) + '\n');

// ── Checks that fail the build ────────────────────────────────────────
// Two places whose names are the same after normalising cannot share a deck:
// the marker would have no way to tell which one was meant.
const groups = [
  ['countries', COUNTRIES.map(r => [r.key, [r.name, ...r.accepts]])],
  ['states', STATES.map(r => [r.key, [r.name, ...r.accepts]])],
  ['capitals', COUNTRIES.filter(r => r.capital).map(r => [r.key, [r.capital[0], ...(r.capital[3] ?? []), ...(r.capital[4] ?? [])]])],
  ['state capitals', STATES.filter(r => r.capital).map(r => [r.key, [r.capital[0]]])],
];
for (const [label, entries] of groups) {
  const seen = new Map();
  for (const [key, names] of entries) {
    for (const n of names) {
      const k = normalise(n);
      if (seen.has(k) && seen.get(k) !== key) {
        throw new Error(`${label}: "${n}" is an answer for both ${seen.get(k)} and ${key}`);
      }
      seen.set(k, key);
    }
  }
  // Near collisions are allowed, and recorded: they are the pairs the marker
  // must refuse to accept as typos of each other. mark.test.ts reads this.
  const all = [...seen.entries()];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [a, ka] = all[i];
      const [b, kb] = all[j];
      if (ka === kb) continue;
      if (distance(a, b) <= 2) report.near_collisions.push({ deck: label, a: [ka, a], b: [kb, b] });
    }
  }
}

report.judgements.push(
  'Tuvalu is not drawn by the 1:50m atlas and is played as a dot',
  'Territories (Greenland, Puerto Rico, French Guiana, the Falklands, New Caledonia, DC) are off by default',
  'Disputed places (Kosovo, Taiwan, Palestine, Western Sahara) are on by default and labelled by common English name',
  'Western Sahara has no capital card',
  'Antarctica is not drawn',
);
report.counts = {
  countries: COUNTRIES.filter(r => !r.tags.includes('territory')).length,
  territories: COUNTRIES.filter(r => r.tags.includes('territory')).length,
  states: STATES.filter(r => !r.tags.includes('territory')).length,
  capitals: COUNTRIES.filter(r => r.capital && !r.tags.includes('territory')).length,
};
writeFileSync(new URL('report.json', OUT), JSON.stringify(report, null, 2) + '\n');

console.log(JSON.stringify({ counts: report.counts, maps: report.maps }, null, 2));
console.log(`${report.near_collisions.length} near collisions recorded`);
