import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBreak,
  buildRoute,
  clampBreak,
  climb,
  evenBreaks,
  fitBreaks,
  GpxError,
  haversine,
  hmm,
  parseGpx,
  parsePace,
  pointAt,
  presetFits,
  stageGpx,
  stages,
} from './engine.ts';

/** A straight line north from (52, -3), `n` points `stepM` apart, elevations from `ele`. */
function line(n: number, stepM: number, ele: (i: number) => number | null, lat0 = 52): string {
  const dLat = stepM / 111195;
  const pts = Array.from({ length: n }, (_, i) => {
    const e = ele(i);
    return `<trkpt lat="${(lat0 + i * dLat).toFixed(7)}" lon="-3">${e === null ? '' : `<ele>${e}</ele>`}</trkpt>`;
  });
  return pts.join('\n');
}

const gpx = (body: string) =>
  `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;

test('haversine measures a degree of latitude as about 111 km', () => {
  const d = haversine({ lat: 52, lon: -3 }, { lat: 53, lon: -3 });
  assert.ok(Math.abs(d - 111195) < 50, String(d));
});

test('not a GPX file is refused in plain words', () => {
  assert.throws(() => parseGpx('<kml></kml>'), GpxError);
  assert.throws(() => parseGpx(gpx('<trk><trkseg><trkpt lat="52" lon="-3"/></trkseg></trk>')), /fewer than two/);
  assert.throws(() => parseGpx(gpx('<wpt lat="52" lon="-3"/>')), /No usable/);
});

test('track points win over route points, and the track name is read', () => {
  const p = parseGpx(
    gpx(
      `<rte><rtept lat="1" lon="1"/><rtept lat="1.1" lon="1"/></rte>` +
        `<trk><name>Offa&apos;s Dyke &amp; more</name><trkseg>${line(3, 100, () => 10)}</trkseg></trk>`
    )
  );
  assert.equal(p.name, "Offa's Dyke & more");
  assert.equal(p.segments.length, 1);
  assert.equal(p.segments[0][0].lat, 52);
});

test('route points are used when there is no track', () => {
  const p = parseGpx(gpx(`<rte><rtept lat="52" lon="-3"/><rtept lat="52.01" lon="-3"/></rte>`));
  assert.equal(p.segments[0].length, 2);
  assert.equal(p.segments[0][0].ele, null);
});

test('a 10 km line resamples to 25 m steps and keeps its length', () => {
  const r = buildRoute(parseGpx(gpx(`<trk><trkseg>${line(101, 100, () => 100)}</trkseg></trk>`)));
  assert.ok(Math.abs(r.summary.distanceM - 10000) < 5, String(r.summary.distanceM));
  assert.equal(r.profile.d[1], 25);
  assert.equal(r.profile.d.length, 401);
  assert.equal(r.summary.ascentM, 0);
  assert.equal(r.hasElevation, true);
});

test('segments are joined in order, and a gap over 500 m is reported and counted', () => {
  const a = line(11, 100, () => 0);
  const b = line(11, 100, () => 0, 52 + 2000 / 111195);
  const r = buildRoute(parseGpx(gpx(`<trk><trkseg>${a}</trkseg><trkseg>${b}</trkseg></trk>`)));
  assert.equal(r.gaps.length, 1);
  assert.ok(Math.abs(r.gaps[0].sizeM - 1000) < 5);
  assert.ok(Math.abs(r.summary.distanceM - 3000) < 5);
});

test('no elevation still builds a route, with blanks where climb would be', () => {
  const r = buildRoute(parseGpx(gpx(`<trk><trkseg>${line(51, 100, () => null)}</trkseg></trk>`)));
  assert.equal(r.hasElevation, false);
  assert.equal(r.summary.ascentM, null);
  assert.equal(r.summary.maxElevationM, null);
  const s = stages(r.profile, [], false, { paceSPerKm: 420, climbAllowance: true });
  assert.equal(s[0].ascentM, null);
  assert.equal(s[0].climbS, 0);
});

test('the odd missing elevation is filled in rather than dropping the profile', () => {
  const r = buildRoute(parseGpx(gpx(`<trk><trkseg>${line(41, 100, i => (i === 20 ? null : i * 2))}</trkseg></trk>`)));
  assert.equal(r.hasElevation, true);
  assert.ok(Math.abs(r.summary.ascentM! - 80) <= 4, String(r.summary.ascentM));
});

test('hysteresis ignores wobble under 3 m and counts real climbs', () => {
  assert.deepEqual(climb([100, 102, 100, 102, 100, 102]), { up: 0, down: 0 });
  assert.deepEqual(climb([100, 110, 120, 110, 100]), { up: 20, down: 20 });
});

test('a steady 500 m climb over 10 km counts about 500 m of ascent', () => {
  const r = buildRoute(parseGpx(gpx(`<trk><trkseg>${line(101, 100, i => 100 + i * 5)}</trkseg></trk>`)));
  assert.ok(Math.abs(r.summary.ascentM! - 500) <= 10, String(r.summary.ascentM));
  assert.equal(r.summary.descentM, 0);
  assert.ok(Math.abs(r.summary.maxElevationM! - 600) <= 10);
});

test('stage times are flat pace plus one minute per 10 m of ascent', () => {
  const r = buildRoute(parseGpx(gpx(`<trk><trkseg>${line(101, 100, i => 100 + i * 5)}</trkseg></trk>`)));
  const [a, b] = stages(r.profile, [5000], true, { paceSPerKm: 420, climbAllowance: true });
  assert.equal(a.day, 1);
  assert.equal(b.day, 2);
  assert.ok(Math.abs(a.distanceM - 5000) < 1);
  assert.equal(a.flatS, 5 * 420);
  assert.ok(Math.abs(a.ascentM! - 250) <= 10, String(a.ascentM));
  assert.equal(a.climbS, a.ascentM! * 6);
  const off = stages(r.profile, [5000], true, { paceSPerKm: 420, climbAllowance: false });
  assert.equal(off[0].climbS, 0);
  assert.equal(off[0].totalS, 2100);
});

test('day-end coordinates are interpolated along the track', () => {
  const r = buildRoute(parseGpx(gpx(`<trk><trkseg>${line(101, 100, () => 0)}</trkseg></trk>`)));
  const p = pointAt(r.profile, 5000);
  assert.ok(Math.abs(p.lat - (52 + 5000 / 111195)) < 0.0001);
});

test('presets split evenly and snap to 0.1 km', () => {
  assert.deepEqual(evenBreaks(285000, 5), [57000, 114000, 171000, 228000]);
  assert.deepEqual(evenBreaks(10050, 3), [3400, 6700]);
  assert.equal(presetFits(5000, 9), false);
  assert.equal(presetFits(285000, 9), true);
});

test('adding a break respects the 1 km gap and the 20-stage cap', () => {
  assert.deepEqual(addBreak([5000], 2040, 10000), [2000, 5000]);
  assert.equal(addBreak([5000], 5500, 10000), null);
  assert.equal(addBreak([], 500, 10000), null);
  assert.equal(addBreak([], 9500, 10000), null);
  const nineteen = Array.from({ length: 19 }, (_, i) => (i + 1) * 2000);
  assert.equal(addBreak(nineteen, 41000, 50000), null);
});

test('a dragged break stays 1 km from its neighbours', () => {
  const b = [10000, 20000, 30000];
  assert.equal(clampBreak(b, 1, 10200, 40000), 11000);
  assert.equal(clampBreak(b, 1, 25432, 40000), 25400);
  assert.equal(clampBreak(b, 2, 99999, 40000), 39000);
});

test('a shorter route keeps only breaks that leave a 1 km last day', () => {
  assert.deepEqual(fitBreaks([10000, 20000, 29500], 30000), { kept: [10000, 20000], dropped: 1 });
});

test('times and paces read as h:mm and m:ss', () => {
  assert.equal(hmm(3 * 3600 + 29 * 60 + 40), '3:30');
  assert.equal(parsePace('7:30'), 450);
  assert.equal(parsePace('7:3'), null);
  assert.equal(parsePace('0:30'), null);
});

test('a stage exports as a GPX the parser can read back', () => {
  const r = buildRoute(parseGpx(gpx(`<trk><trkseg>${line(101, 100, i => i)}</trkseg></trk>`)));
  const [s] = stages(r.profile, [4000], true, { paceSPerKm: 420, climbAllowance: true });
  const back = buildRoute(parseGpx(stageGpx(r.profile, s, 'Test <route>', true)));
  assert.ok(Math.abs(back.summary.distanceM - 4000) < 5, String(back.summary.distanceM));
  assert.match(back.name, /Test <route>: day 1/);
});

test('a long route with 50,000 points builds quickly', () => {
  const t0 = performance.now();
  const r = buildRoute(parseGpx(gpx(`<trk><trkseg>${line(50000, 5.7, i => 200 + 150 * Math.sin(i / 900))}</trkseg></trk>`)));
  const ms = performance.now() - t0;
  assert.ok(Math.abs(r.summary.distanceM - 284994) < 200);
  assert.ok(ms < 2000, `${ms} ms`);
});
