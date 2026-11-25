/**
 * The route engine: GPX in, one resampled series out, and every figure the
 * planner shows computed from that series, so the map, the profile and the
 * stage list can never disagree.
 *
 * Pure functions, no DOM: the parser reads GPX text with regular expressions
 * so it runs the same in the browser and under `node --test`.
 */

export const STEP_M = 25;
export const SMOOTH_POINTS = 5;
export const HYSTERESIS_M = 3;
export const GAP_NOTICE_M = 500;
export const MIN_GAP_M = 1000;
export const MAX_STAGES = 20;
export const SNAP_M = 100;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Naismith-style allowance: one minute for every 10 m of ascent. */
export const CLIMB_S_PER_M = 6;
export const PRESETS = [3, 5, 7, 9] as const;
export const PACES_S = [480, 420, 360] as const;

export interface RawPoint {
  lat: number;
  lon: number;
  ele: number | null;
}

export interface ParsedGpx {
  name: string;
  segments: RawPoint[][];
}

export class GpxError extends Error {}

/** The resampled series. Parallel arrays keep 11,000 points small in JSON. */
export interface Profile {
  step: number;
  d: number[];
  e: number[];
  lat: number[];
  lon: number[];
}

export interface Gap {
  atM: number;
  sizeM: number;
}

export interface RouteSummary {
  distanceM: number;
  ascentM: number | null;
  descentM: number | null;
  maxElevationM: number | null;
  hasElevation: boolean;
}

export interface BuiltRoute {
  name: string;
  profile: Profile;
  hasElevation: boolean;
  gaps: Gap[];
  rawPoints: number;
  summary: RouteSummary;
}

// ── Parsing ─────────────────────────────────────────────────────────

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();

function attr(attrs: string, name: string): number {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`));
  return m ? Number(m[1]) : NaN;
}

function points(block: string, tag: 'trkpt' | 'rtept'): RawPoint[] {
  const out: RawPoint[] = [];
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>)`, 'g');
  for (const m of block.matchAll(re)) {
    const lat = attr(m[1], 'lat');
    const lon = attr(m[1], 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const em = m[2]?.match(/<(?:\w+:)?ele>\s*([-+0-9.eE]+)\s*<\/(?:\w+:)?ele>/);
    const ele = em ? Number(em[1]) : NaN;
    out.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null });
  }
  return out;
}

function blocks(text: string, tag: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'g');
  return [...text.matchAll(re)].map(m => m[1]);
}

/**
 * Track points first, joined in file order across tracks and segments; route
 * points only when the file has no track. Waypoints and timestamps are ignored.
 */
export function parseGpx(text: string): ParsedGpx {
  if (!/<(?:\w+:)?gpx\b/.test(text)) throw new GpxError('This is not a GPX file.');

  const segments: RawPoint[][] = [];
  for (const seg of blocks(text, 'trkseg')) {
    const pts = points(seg, 'trkpt');
    if (pts.length) segments.push(pts);
  }
  if (!segments.length) {
    for (const rte of blocks(text, 'rte')) {
      const pts = points(rte, 'rtept');
      if (pts.length) segments.push(pts);
    }
  }

  const total = segments.reduce((n, s) => n + s.length, 0);
  if (total === 0) throw new GpxError('No usable track or route points in this file.');
  if (total < 2) throw new GpxError('This file has fewer than two points, so there is no route to plan.');

  const nameBlock = text.match(/<(?:\w+:)?(?:trk|rte|metadata)\b[^>]*>[\s\S]*?<(?:\w+:)?name>([\s\S]*?)<\/(?:\w+:)?name>/);
  return { name: nameBlock ? decode(nameBlock[1]).slice(0, 200) : '', segments };
}

// ── Geometry ────────────────────────────────────────────────────────

const R = 6371008.8;
const rad = (x: number) => (x * Math.PI) / 180;

export function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Fill missing elevations by interpolating between the nearest known ones, so
 * a file with the odd blank <ele> still has a profile. A file where fewer than
 * nine points in ten carry elevation is treated as having none.
 */
function fillElevation(pts: RawPoint[], cum: number[]): number[] | null {
  const known = pts.filter(p => p.ele !== null).length;
  if (known < Math.max(2, pts.length * 0.9)) return null;
  const out = new Array<number>(pts.length);
  let prev = -1;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].ele === null) continue;
    out[i] = pts[i].ele!;
    if (prev === -1) for (let k = 0; k < i; k++) out[k] = out[i];
    else if (i - prev > 1) {
      const span = cum[i] - cum[prev] || 1;
      for (let k = prev + 1; k < i; k++) out[k] = out[prev] + ((out[i] - out[prev]) * (cum[k] - cum[prev])) / span;
    }
    prev = i;
  }
  for (let k = prev + 1; k < pts.length; k++) out[k] = out[prev];
  return out;
}

const round = (x: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

/**
 * Join the segments, measure, resample every 25 m and smooth the elevation.
 * A gap over 500 m between one segment's end and the next start is bridged by
 * a straight line, counted in the distance, and reported.
 */
export function buildRoute(parsed: ParsedGpx, fallbackName = 'Route'): BuiltRoute {
  const pts: RawPoint[] = [];
  const gaps: Gap[] = [];
  const cum: number[] = [];
  let dist = 0;

  for (const seg of parsed.segments) {
    for (let i = 0; i < seg.length; i++) {
      const p = seg[i];
      if (pts.length) {
        const step = haversine(pts[pts.length - 1], p);
        if (i === 0 && step > GAP_NOTICE_M) gaps.push({ atM: dist, sizeM: step });
        dist += step;
      }
      pts.push(p);
      cum.push(dist);
    }
  }

  if (dist < STEP_M) throw new GpxError('This route is too short to plan.');

  const ele = fillElevation(pts, cum);
  const hasElevation = ele !== null;

  // Resample: one point every STEP_M, plus the exact finish.
  const d: number[] = [];
  const e: number[] = [];
  const lat: number[] = [];
  const lon: number[] = [];
  let j = 0;
  const push = (at: number) => {
    while (j < cum.length - 2 && cum[j + 1] < at) j++;
    const span = cum[j + 1] - cum[j];
    const t = span > 0 ? Math.min(1, Math.max(0, (at - cum[j]) / span)) : 0;
    d.push(Math.round(at));
    lat.push(round(pts[j].lat + (pts[j + 1].lat - pts[j].lat) * t, 6));
    lon.push(round(pts[j].lon + (pts[j + 1].lon - pts[j].lon) * t, 6));
    e.push(ele ? ele[j] + (ele[j + 1] - ele[j]) * t : 0);
  };
  // The exact finish is always the last sample; a step within a metre of it
  // would only add a duplicate.
  for (let at = 0; at < dist - 1; at += STEP_M) push(at);
  push(dist);

  const smoothed = hasElevation ? smooth(e, SMOOTH_POINTS).map(x => round(x, 1)) : e.map(() => 0);
  const profile: Profile = { step: STEP_M, d, e: smoothed, lat, lon };

  return {
    name: parsed.name || fallbackName,
    profile,
    hasElevation,
    gaps,
    rawPoints: pts.length,
    summary: summarise(profile, hasElevation),
  };
}

/** Centred moving average; the window shrinks at the ends rather than padding. */
export function smooth(xs: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  const prefix = [0];
  for (const x of xs) prefix.push(prefix[prefix.length - 1] + x);
  return xs.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(xs.length - 1, i + half);
    return (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  });
}

/**
 * Ascent and descent with hysteresis: a rise or fall counts only once it
 * exceeds the threshold from the last reference level, which then moves to
 * where the change was counted. GPS wobble under the threshold adds nothing.
 */
export function climb(e: number[], from = 0, to = e.length - 1, threshold = HYSTERESIS_M) {
  let up = 0;
  let down = 0;
  if (to <= from) return { up, down };
  let ref = e[from];
  for (let i = from + 1; i <= to; i++) {
    const x = e[i];
    if (x - ref > threshold) {
      up += x - ref;
      ref = x;
    } else if (ref - x > threshold) {
      down += ref - x;
      ref = x;
    }
  }
  return { up, down };
}

export function summarise(p: Profile, hasElevation: boolean): RouteSummary {
  const distanceM = p.d[p.d.length - 1];
  if (!hasElevation) return { distanceM, ascentM: null, descentM: null, maxElevationM: null, hasElevation };
  const { up, down } = climb(p.e);
  return {
    distanceM,
    ascentM: Math.round(up),
    descentM: Math.round(down),
    maxElevationM: Math.round(Math.max(...p.e)),
    hasElevation,
  };
}

// ── Looking things up along the route ───────────────────────────────

/** Index of the last sample at or before `m`. Samples are evenly spaced. */
export function indexAt(p: Profile, m: number): number {
  const i = Math.floor(m / p.step);
  return Math.max(0, Math.min(p.d.length - 2, i));
}

export function pointAt(p: Profile, m: number) {
  const at = Math.max(0, Math.min(p.d[p.d.length - 1], m));
  const i = indexAt(p, at);
  const span = p.d[i + 1] - p.d[i] || 1;
  const t = Math.max(0, Math.min(1, (at - p.d[i]) / span));
  const lerp = (xs: number[]) => xs[i] + (xs[i + 1] - xs[i]) * t;
  return { m: at, lat: lerp(p.lat), lon: lerp(p.lon), ele: lerp(p.e) };
}

// ── Stages ──────────────────────────────────────────────────────────

export interface Stage {
  day: number;
  startM: number;
  endM: number;
  distanceM: number;
  ascentM: number | null;
  descentM: number | null;
  flatS: number;
  climbS: number;
  totalS: number;
  end: { lat: number; lon: number };
}

export interface PaceOptions {
  paceSPerKm: number;
  climbAllowance: boolean;
}

/** Stage figures between break distances, interpolating the series at each break. */
export function stages(p: Profile, breaks: number[], hasElevation: boolean, pace: PaceOptions): Stage[] {
  const total = p.d[p.d.length - 1];
  const edges = [0, ...breaks, total];
  const out: Stage[] = [];
  for (let k = 0; k < edges.length - 1; k++) {
    const a = edges[k];
    const b = edges[k + 1];
    let ascentM: number | null = null;
    let descentM: number | null = null;
    if (hasElevation) {
      // The slice of the series inside the stage, with the interpolated ends.
      const i0 = indexAt(p, a) + 1;
      const i1 = indexAt(p, b);
      const series = [pointAt(p, a).ele, ...p.e.slice(i0, Math.max(i0, i1 + 1)), pointAt(p, b).ele];
      const c = climb(series);
      ascentM = Math.round(c.up);
      descentM = Math.round(c.down);
    }
    const distanceM = b - a;
    const flatS = (distanceM / 1000) * pace.paceSPerKm;
    const climbS = pace.climbAllowance && ascentM ? ascentM * CLIMB_S_PER_M : 0;
    const end = pointAt(p, b);
    out.push({
      day: k + 1,
      startM: a,
      endM: b,
      distanceM,
      ascentM,
      descentM,
      flatS,
      climbS,
      totalS: flatS + climbS,
      end: { lat: end.lat, lon: end.lon },
    });
  }
  return out;
}

// ── Breaks ──────────────────────────────────────────────────────────

export const snap = (m: number) => Math.round(m / SNAP_M) * SNAP_M;

/** Even split by distance, snapped to 0.1 km. */
export function evenBreaks(totalM: number, n: number): number[] {
  const out: number[] = [];
  for (let k = 1; k < n; k++) out.push(snap((totalM * k) / n));
  return out;
}

/** Whether a preset can honour the minimum gap on a route this long. */
export const presetFits = (totalM: number, n: number) => totalM / n >= MIN_GAP_M + SNAP_M;

/** Where a break may sit: at least 1 km from its neighbours, the start and the finish. */
export function clampBreak(breaks: number[], index: number, m: number, totalM: number): number {
  const lo = (index > 0 ? breaks[index - 1] : 0) + MIN_GAP_M;
  const hi = (index < breaks.length - 1 ? breaks[index + 1] : totalM) - MIN_GAP_M;
  return Math.max(lo, Math.min(hi, snap(m)));
}

/** A new break at `m`, or null when it would break a rule. */
export function addBreak(breaks: number[], m: number, totalM: number): number[] | null {
  if (breaks.length >= MAX_STAGES - 1) return null;
  const at = snap(m);
  if (at < MIN_GAP_M || at > totalM - MIN_GAP_M) return null;
  if (breaks.some(b => Math.abs(b - at) < MIN_GAP_M)) return null;
  return [...breaks, at].sort((x, y) => x - y);
}

/** Breaks kept when the route under a plan changes length. */
export function fitBreaks(breaks: number[], totalM: number): { kept: number[]; dropped: number } {
  const kept = breaks.filter(b => b <= totalM - MIN_GAP_M);
  return { kept, dropped: breaks.length - kept.length };
}

// ── Formatting ──────────────────────────────────────────────────────

export const km = (m: number, dp = 1) => (m / 1000).toFixed(dp);

export function hmm(s: number): string {
  const mins = Math.round(s / 60);
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}

export function paceLabel(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

/** "7:30" → 450. Null for anything that is not a sensible running pace. */
export function parsePace(text: string): number | null {
  const m = text.trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m) return null;
  const s = Number(m[1]) * 60 + Number(m[2]);
  return s >= 120 && s <= 1800 ? s : null;
}

/** Slice of the series for a stage, as a GPX document. */
export function stageGpx(p: Profile, s: Stage, routeName: string, hasElevation: boolean): string {
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const start = pointAt(p, s.startM);
  const end = pointAt(p, s.endM);
  const mid: string[] = [];
  for (let i = indexAt(p, s.startM) + 1; i <= indexAt(p, s.endM); i++) {
    if (p.d[i] <= s.startM || p.d[i] >= s.endM) continue;
    mid.push(pt(p.lat[i], p.lon[i], p.e[i]));
  }
  function pt(la: number, lo: number, el: number) {
    const ele = hasElevation ? `<ele>${el.toFixed(1)}</ele>` : '';
    return `<trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}">${ele}</trkpt>`;
  }
  const name = esc(`${routeName}: day ${s.day}`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Grackles Routes" xmlns="http://www.topografix.com/GPX/1/1">',
    `<trk><name>${name}</name><trkseg>`,
    pt(start.lat, start.lon, start.ele),
    ...mid,
    pt(end.lat, end.lon, end.ele),
    '</trkseg></trk></gpx>',
  ].join('\n');
}
