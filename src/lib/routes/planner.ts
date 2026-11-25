/**
 * The planner in the browser: load a GPX, draw the map and the profile, edit
 * the day breaks, and save the plan through /api/routes/:workspace/plans.
 *
 * Every figure comes from the engine, which is the tested half; this file is
 * wiring and drawing.
 */
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre builds its worker's address from a template string, which the
// bundler cannot follow, so the file is imported as an asset and named here.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Map as MlMap, GeoJSONSource, Marker } from 'maplibre-gl';
import {
  addBreak,
  buildRoute,
  clampBreak,
  evenBreaks,
  fitBreaks,
  GpxError,
  hmm,
  km,
  MAX_FILE_BYTES,
  MAX_STAGES,
  PACES_S,
  paceLabel,
  parseGpx,
  parsePace,
  pointAt,
  PRESETS,
  presetFits,
  SNAP_M,
  stageGpx,
  stages,
  summarise,
  type BuiltRoute,
  type Profile,
  type Stage,
} from './engine';

interface SavedPlan {
  id: string;
  name: string;
  stages: number;
  distanceM: number;
  updatedAt: string;
}

interface Boot {
  workspace: string;
  canWrite: boolean;
  plans: SavedPlan[];
  sample: string;
}

interface LoadedRoute {
  name: string;
  filename: string;
  profile: Profile;
  hasElevation: boolean;
  summary: BuiltRoute['summary'];
}

/** Stage colours: distinct in hue and lightness, readable on paper. */
const COLOURS = ['#2f6f9f', '#c0612b', '#3f8a4f', '#8a4f9e', '#b08a1e', '#a63d5a'];
const colour = (i: number) => COLOURS[i % COLOURS.length];
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtInt = (n: number) => Math.round(n).toLocaleString('en-GB');

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    s.getItem('x');
    return s;
  } catch {
    return null;
  }
}

export function start(root: HTMLElement) {
  const boot = JSON.parse(root.dataset.boot!) as Boot;
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const api = `/api/routes/${boot.workspace}/plans`;
  const draftKey = `rt-draft:${boot.workspace}`;

  // ── State ──────────────────────────────────────────────────────────
  let route: LoadedRoute | null = null;
  let routeDirty = false;
  let planId: string | null = null;
  let breaks: number[] = [];
  let pace = 420;
  let climbOn = true;
  let savedSnapshot = '';
  let plans = boot.plans.slice();
  let current: Stage[] = [];

  const snapshot = () =>
    JSON.stringify({ planId, name: $<HTMLInputElement>('[data-name]').value.trim(), breaks, pace, climbOn, routeDirty });
  const dirty = () => route !== null && snapshot() !== savedSnapshot;

  // ── Views ──────────────────────────────────────────────────────────
  function show(view: 'empty' | 'planner') {
    $('[data-view="empty"]').hidden = view !== 'empty';
    $('[data-view="planner"]').hidden = view !== 'planner';
    if (view === 'planner') requestAnimationFrame(() => { map?.resize(); drawProfile(); });
  }

  // ── Toast with one level of undo ───────────────────────────────────
  let toastTimer = 0;
  let toastUndo: (() => void) | null = null;
  function toast(text: string, undo?: () => void) {
    $('[data-toast-text]').textContent = text;
    $('[data-toast-undo]').hidden = !undo;
    toastUndo = undo ?? null;
    $('[data-toast]').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => ($('[data-toast]').hidden = true), 6000);
  }
  $('[data-toast-undo]').addEventListener('click', () => {
    toastUndo?.();
    toastUndo = null;
    $('[data-toast]').hidden = true;
  });

  function notice(text: string) {
    const n = $('[data-notice]');
    n.textContent = text;
    n.hidden = !text;
  }

  // ── Saved plans list ───────────────────────────────────────────────
  function renderSaved() {
    const ul = $('[data-saved]');
    ul.innerHTML = plans
      .map(
        p => `<li class="rt-saved__item" data-id="${p.id}">
          <button type="button" class="rt-saved__open" data-open>${esc(p.name)}</button>
          <span class="rt-saved__meta">${km(p.distanceM, 0)} km · ${p.stages} days · ${new Date(p.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          ${boot.canWrite ? '<button type="button" class="rt-btn rt-btn--quiet" data-rename>Rename</button><button type="button" class="rt-btn rt-btn--quiet" data-delete>Delete</button>' : ''}
        </li>`
      )
      .join('');
    $('[data-saved-empty]').hidden = plans.length > 0;
  }

  $('[data-saved]').addEventListener('click', async e => {
    const t = e.target as HTMLElement;
    const li = t.closest<HTMLElement>('[data-id]');
    if (!li) return;
    const id = li.dataset.id!;
    const p = plans.find(x => x.id === id)!;
    if (t.closest('[data-open]')) return openPlan(id);
    if (t.closest('[data-rename]')) {
      const name = window.prompt('Rename plan', p.name)?.trim();
      if (!name || name === p.name) return;
      const r = await post({ action: 'rename', id, name });
      if (r.ok) { p.name = name; renderSaved(); }
      else toast(r.error);
    }
    if (t.closest('[data-delete]')) {
      const r = await post({ action: 'delete', id });
      if (!r.ok) return toast(r.error);
      const at = plans.indexOf(p);
      plans = plans.filter(x => x !== p);
      renderSaved();
      toast(`Deleted "${p.name}".`, async () => {
        const back = await post({ action: 'restore', id });
        if (back.ok) { plans.splice(at, 0, p); renderSaved(); }
      });
    }
  });

  async function post(body: unknown): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
    try {
      const res = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      return res.ok ? { ok: true, data } : { ok: false, error: data.error ?? `Not saved (${res.status}).` };
    } catch {
      return { ok: false, error: 'Not saved: the connection failed.' };
    }
  }

  // ── Loading a GPX ──────────────────────────────────────────────────
  function dropError(text: string) {
    const el = $('[data-drop-error]');
    el.textContent = text;
    el.hidden = !text;
  }

  async function readFile(file: File, mode: 'new' | 'replace') {
    const fail = (msg: string) => (mode === 'new' ? dropError(msg) : notice(msg));
    if (!/\.gpx$/i.test(file.name)) return fail('That is not a GPX file. Choose a file ending in .gpx.');
    if (file.size > MAX_FILE_BYTES) return fail('That file is over 20 MB.');
    const text = await file.text();
    loadText(text, file.name, mode);
  }

  function loadText(text: string, filename: string, mode: 'new' | 'replace') {
    const fail = (msg: string) => (mode === 'new' ? dropError(msg) : notice(msg));
    $('[data-progress]').hidden = false;
    // Let the progress bar paint before the parse blocks the thread.
    setTimeout(() => {
      let built: BuiltRoute;
      try {
        built = buildRoute(parseGpx(text), filename.replace(/\.gpx$/i, ''));
      } catch (err) {
        $('[data-progress]').hidden = true;
        return fail(err instanceof GpxError ? err.message : 'This file could not be read as GPX.');
      }
      $('[data-progress]').hidden = true;
      dropError('');
      const next: LoadedRoute = {
        name: built.name,
        filename,
        profile: built.profile,
        hasElevation: built.hasElevation,
        summary: built.summary,
      };
      const notes: string[] = [];
      for (const g of built.gaps) {
        notes.push(`A ${km(g.sizeM, 2)} km gap between track segments at km ${km(g.atM)} is bridged with a straight line.`);
      }
      if (mode === 'new') {
        planId = null;
        route = next;
        routeDirty = true;
        breaks = presetFits(built.summary.distanceM, 5) ? evenBreaks(built.summary.distanceM, 5) : [];
        $<HTMLInputElement>('[data-name]').value = built.name;
        savedSnapshot = '';
      } else {
        const { kept, dropped } = fitBreaks(breaks, built.summary.distanceM);
        route = next;
        routeDirty = true;
        breaks = kept;
        if (dropped) notes.push(`${dropped} day ${dropped === 1 ? 'break was' : 'breaks were'} past the new finish and removed.`);
      }
      notice(notes.join(' '));
      show('planner');
      renderAll(true);
    }, 30);
  }

  const drop = $('[data-drop]');
  ['dragenter', 'dragover'].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('is-over'); })
  );
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('is-over')));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) readFile(f, 'new');
  });
  $<HTMLInputElement>('[data-file]').addEventListener('change', e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) readFile(f, 'new');
    (e.target as HTMLInputElement).value = '';
  });
  $<HTMLInputElement>('[data-replace]').addEventListener('change', e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) readFile(f, 'replace');
    (e.target as HTMLInputElement).value = '';
  });
  $('[data-sample]').addEventListener('click', async () => {
    try {
      const res = await fetch(boot.sample);
      if (!res.ok) throw new Error();
      loadText(await res.text(), 'offas-dyke-path.gpx', 'new');
    } catch {
      dropError('The sample route is not available right now.');
    }
  });
  $('[data-back]').addEventListener('click', () => {
    if (dirty() && !window.confirm('Leave this plan? Unsaved changes are kept as a draft in this browser.')) return;
    history.replaceState(null, '', location.pathname);
    show('empty');
  });

  // ── Opening a saved plan ───────────────────────────────────────────
  async function openPlan(id: string) {
    dropError('');
    $('[data-progress]').hidden = false;
    try {
      const res = await fetch(`${api}?id=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error();
      const { plan, route: r } = await res.json();
      const profile = r.profile as Profile;
      route = {
        name: r.name,
        filename: r.source_filename,
        profile,
        hasElevation: r.has_elevation,
        summary: summarise(profile, r.has_elevation),
      };
      routeDirty = false;
      planId = plan.id;
      breaks = plan.breaks_m;
      pace = plan.pace_s_per_km;
      climbOn = plan.climb_allowance;
      $<HTMLInputElement>('[data-name]').value = plan.name;
      savedSnapshot = snapshot();
      notice('');
      history.replaceState(null, '', `${location.pathname}?plan=${plan.id}`);
      show('planner');
      renderAll(true);
    } catch {
      dropError('That plan could not be opened.');
    } finally {
      $('[data-progress]').hidden = true;
    }
  }

  // ── Map ────────────────────────────────────────────────────────────
  let map: MlMap | null = null;
  let mapReady = false;
  let markers: Marker[] = [];
  let maplib: typeof import('maplibre-gl') | null = null;

  async function ensureMap() {
    if (map) return;
    try {
      maplib = await import('maplibre-gl');
      maplib.setWorkerUrl(workerUrl);
      map = new maplib.Map({
        container: $('[data-map]'),
        style: MAP_STYLE,
        attributionControl: { compact: false },
        cooperativeGestures: true,
      });
      map.addControl(new maplib.NavigationControl({ showCompass: false }), 'top-right');
      map.on('error', e => {
        if (!mapReady) $('[data-map-fail]').hidden = false;
        console.warn('map', e.error?.message);
      });
      map.on('load', () => {
        mapReady = true;
        $('[data-map-fail]').hidden = true;
        map!.addSource('stages', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map!.addSource('hover', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map!.addLayer({
          id: 'stages-casing', type: 'line', source: 'stages',
          paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 },
          layout: { 'line-join': 'round', 'line-cap': 'round' },
        });
        map!.addLayer({
          id: 'stages', type: 'line', source: 'stages',
          paint: { 'line-color': ['get', 'colour'], 'line-width': 4 },
          layout: { 'line-join': 'round', 'line-cap': 'round' },
        });
        map!.addLayer({
          id: 'hover', type: 'circle', source: 'hover',
          paint: { 'circle-radius': 6, 'circle-color': '#1e1d2e', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
        });
        renderMap(true);
      });
    } catch (err) {
      console.warn('map failed', err);
      $('[data-map-fail]').hidden = false;
    }
  }

  function renderMap(fit: boolean) {
    if (!map || !mapReady || !route || !maplib) return;
    const p = route.profile;
    const features = current.map((s, k) => {
      const i0 = Math.max(0, Math.floor(s.startM / p.step));
      const i1 = Math.min(p.d.length - 1, Math.ceil(s.endM / p.step));
      const coords: [number, number][] = [];
      for (let i = i0; i <= i1; i++) coords.push([p.lon[i], p.lat[i]]);
      return { type: 'Feature' as const, properties: { colour: colour(k) }, geometry: { type: 'LineString' as const, coordinates: coords } };
    });
    (map.getSource('stages') as GeoJSONSource).setData({ type: 'FeatureCollection', features });

    markers.forEach(m => m.remove());
    const mk = (cls: string, label: string, lon: number, lat: number, title: string) => {
      const el = document.createElement('div');
      el.className = `rt-marker ${cls}`;
      el.textContent = label;
      el.title = title;
      return new maplib!.Marker({ element: el }).setLngLat([lon, lat]).addTo(map!);
    };
    const last = p.d.length - 1;
    markers = [mk('rt-marker--start', 'S', p.lon[0], p.lat[0], 'Start')];
    current.slice(0, -1).forEach(s => markers.push(mk('', String(s.day), s.end.lon, s.end.lat, `Day ${s.day} ends`)));
    markers.push(mk('rt-marker--finish', 'F', p.lon[last], p.lat[last], 'Finish'));

    if (fit) {
      let w = 180, e = -180, s = 90, n = -90;
      for (let i = 0; i < p.lat.length; i += 4) {
        w = Math.min(w, p.lon[i]); e = Math.max(e, p.lon[i]);
        s = Math.min(s, p.lat[i]); n = Math.max(n, p.lat[i]);
      }
      map.fitBounds([[w, s], [e, n]], { padding: 30, duration: 0 });
    }
  }

  function hoverMap(m: number | null) {
    if (!map || !mapReady || !route) return;
    const src = map.getSource('hover') as GeoJSONSource | undefined;
    if (!src) return;
    if (m === null) return src.setData({ type: 'FeatureCollection', features: [] });
    const pt = pointAt(route.profile, m);
    src.setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [pt.lon, pt.lat] } });
  }

  // ── Profile ────────────────────────────────────────────────────────
  const prof = $('[data-profile]');
  const canvas = $<HTMLCanvasElement>('[data-canvas]');
  const PAD = { l: 44, r: 12, t: 12, b: 26 };
  let yRange = { lo: 0, hi: 1 };

  const total = () => route!.summary.distanceM;
  const plotW = () => prof.clientWidth - PAD.l - PAD.r;
  const xOf = (m: number) => PAD.l + (m / total()) * plotW();
  const mOf = (x: number) => Math.max(0, Math.min(total(), ((x - PAD.l) / plotW()) * total()));

  function niceStep(span: number, target: number) {
    const raw = span / target;
    const mag = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map(f => f * mag).find(s => s >= raw) ?? 10 * mag;
  }

  function drawProfile() {
    if (!route || prof.offsetParent === null) return;
    const dpr = window.devicePixelRatio || 1;
    const W = prof.clientWidth;
    const H = prof.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const p = route.profile;
    const has = route.hasElevation;
    let lo = 0, hi = 100;
    if (has) {
      lo = Math.min(...p.e);
      hi = Math.max(...p.e);
      const pad = Math.max(20, (hi - lo) * 0.08);
      lo = Math.max(0, Math.floor((lo - pad) / 10) * 10);
      hi = Math.ceil((hi + pad) / 10) * 10;
    }
    yRange = { lo, hi };
    const plotH = H - PAD.t - PAD.b;
    const yOf = (e: number) => PAD.t + plotH - ((e - lo) / (hi - lo || 1)) * plotH;
    const ink = getComputedStyle(root).getPropertyValue('--rt-ink').trim() || '#1e1d2e';
    const muted = getComputedStyle(root).getPropertyValue('--rt-muted').trim() || '#77736a';
    const rule = getComputedStyle(root).getPropertyValue('--rt-rule').trim() || '#d6d1c4';

    // Grid and axes.
    ctx.font = '11px "Source Sans 3", system-ui, sans-serif';
    ctx.fillStyle = muted;
    ctx.strokeStyle = rule;
    ctx.lineWidth = 1;
    if (has) {
      const ys = niceStep(hi - lo, 4);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let v = Math.ceil(lo / ys) * ys; v <= hi; v += ys) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
        ctx.fillText(`${v} m`, PAD.l - 6, y);
      }
    }
    const xs = niceStep(total() / 1000, Math.max(3, Math.floor(plotW() / 70)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let v = 0; v <= total() / 1000 + 1e-9; v += xs) {
      ctx.fillText(`${v}`, xOf(v * 1000), H - PAD.b + 6);
    }
    ctx.textAlign = 'right';
    ctx.fillText('km', W - PAD.r, H - PAD.b + 6);

    if (!has) {
      ctx.strokeStyle = ink;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(PAD.l, PAD.t + plotH / 2); ctx.lineTo(W - PAD.r, PAD.t + plotH / 2); ctx.stroke();
      ctx.setLineDash([]);
    } else {
      // Area and line per stage, decimated to about one sample per pixel.
      const stride = Math.max(1, Math.floor(p.d.length / (plotW() * 1.5)));
      current.forEach((s, k) => {
        const i0 = Math.floor(s.startM / p.step);
        const i1 = Math.min(p.d.length - 1, Math.ceil(s.endM / p.step));
        ctx.beginPath();
        ctx.moveTo(xOf(p.d[i0]), yOf(lo));
        for (let i = i0; i <= i1; i += stride) ctx.lineTo(xOf(p.d[i]), yOf(p.e[i]));
        ctx.lineTo(xOf(p.d[i1]), yOf(p.e[i1]));
        ctx.lineTo(xOf(p.d[i1]), yOf(lo));
        ctx.closePath();
        ctx.fillStyle = colour(k) + '33';
        ctx.fill();
        ctx.beginPath();
        for (let i = i0; i <= i1; i += stride) {
          if (i === i0) ctx.moveTo(xOf(p.d[i]), yOf(p.e[i]));
          else ctx.lineTo(xOf(p.d[i]), yOf(p.e[i]));
        }
        ctx.lineTo(xOf(p.d[i1]), yOf(p.e[i1]));
        ctx.strokeStyle = colour(k);
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    }
    placeHandles();
  }

  function placeHandles() {
    const box = $('[data-handles]');
    if (box.children.length !== breaks.length) {
      box.innerHTML = breaks
        .map(
          (_, i) => `<div class="rt-handle" role="slider" tabindex="0" data-i="${i}" aria-orientation="horizontal">
            <span class="rt-handle__line"></span><span class="rt-handle__tag"></span></div>`
        )
        .join('');
    }
    breaks.forEach((b, i) => {
      const h = box.children[i] as HTMLElement;
      h.style.left = `${xOf(b)}px`;
      h.setAttribute('aria-valuemin', '0');
      h.setAttribute('aria-valuemax', km(total()));
      h.setAttribute('aria-valuenow', km(b));
      h.setAttribute('aria-valuetext', `Day ${i + 1} ends at km ${km(b)}`);
      h.setAttribute('aria-label', `Day ${i + 1} end`);
      (h.querySelector('.rt-handle__tag') as HTMLElement).textContent = String(i + 1);
    });
  }

  function readout(m: number) {
    const pt = pointAt(route!.profile, m);
    const day = 1 + breaks.filter(b => b < m).length;
    const x = xOf(m);
    const cross = $('[data-cross]');
    cross.hidden = false;
    cross.style.left = `${x}px`;
    const r = $('[data-readout]');
    r.hidden = false;
    r.textContent = route!.hasElevation
      ? `km ${km(m)} · ${fmtInt(pt.ele)} m · day ${day}`
      : `km ${km(m)} · day ${day}`;
    const w = r.offsetWidth;
    r.style.left = `${Math.min(prof.clientWidth - w - 4, Math.max(4, x - w / 2))}px`;
    hoverMap(m);
  }
  function clearReadout() {
    $('[data-cross]').hidden = true;
    $('[data-readout]').hidden = true;
    hoverMap(null);
  }

  // Pointer handling: hover reads out, a click on empty profile adds a break,
  // a handle drags.
  let drag: { i: number; id: number } | null = null;
  let down: { x: number; y: number; id: number } | null = null;
  const localX = (e: PointerEvent) => e.clientX - prof.getBoundingClientRect().left;

  prof.addEventListener('pointerdown', e => {
    if (!route) return;
    const h = (e.target as HTMLElement).closest<HTMLElement>('.rt-handle');
    if (h && boot.canWrite) {
      drag = { i: Number(h.dataset.i), id: e.pointerId };
      h.setPointerCapture(e.pointerId);
      h.classList.add('is-drag');
      e.preventDefault();
      return;
    }
    down = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  prof.addEventListener('pointermove', e => {
    if (!route) return;
    const x = localX(e);
    if (drag && e.pointerId === drag.id) {
      const next = clampBreak(breaks, drag.i, mOf(x), total());
      if (next !== breaks[drag.i]) {
        breaks = breaks.map((b, i) => (i === drag!.i ? next : b));
        renderAll(false);
      }
      readout(breaks[drag.i]);
      return;
    }
    if (e.pointerType !== 'touch' || down) readout(mOf(x));
  });
  prof.addEventListener('pointerup', e => {
    if (!route) return;
    if (drag && e.pointerId === drag.id) {
      root.querySelector('.rt-handle.is-drag')?.classList.remove('is-drag');
      drag = null;
      return;
    }
    if (down && e.pointerId === down.id && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 && boot.canWrite) {
      const next = addBreak(breaks, mOf(localX(e)), total());
      if (next) { breaks = next; renderAll(false); }
      else toast(breaks.length >= MAX_STAGES - 1 ? 'Twenty days is the most a plan can have.' : 'A day must be at least 1 km long.');
    }
    down = null;
    if (e.pointerType === 'touch') clearReadout();
  });
  prof.addEventListener('pointercancel', () => { drag = null; down = null; clearReadout(); });
  prof.addEventListener('pointerleave', () => { if (!drag) clearReadout(); });

  $('[data-handles]').addEventListener('keydown', e => {
    const h = (e.target as HTMLElement).closest<HTMLElement>('.rt-handle');
    if (!h || !route || !boot.canWrite) return;
    const i = Number(h.dataset.i);
    const step = e.shiftKey ? 1000 : SNAP_M;
    let to: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') to = breaks[i] - step;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') to = breaks[i] + step;
    if (to === null) return;
    e.preventDefault();
    breaks = breaks.map((b, k) => (k === i ? clampBreak(breaks, i, to!, total()) : b));
    renderAll(false);
    (($('[data-handles]').children[i]) as HTMLElement).focus();
    readout(breaks[i]);
  });
  $('[data-handles]').addEventListener('focusout', () => clearReadout());

  // ── Stats, controls and stages ─────────────────────────────────────
  function renderStats() {
    const s = route!.summary;
    const dash = '–';
    const tiles: [string, string][] = [
      ['Distance', `${km(s.distanceM)} km`],
      ['Total ascent', s.ascentM === null ? dash : `${fmtInt(s.ascentM)} m`],
      ['Total descent', s.descentM === null ? dash : `${fmtInt(s.descentM)} m`],
      ['Highest point', s.maxElevationM === null ? dash : `${fmtInt(s.maxElevationM)} m`],
      ['Days', String(breaks.length + 1)],
    ];
    $('[data-stats]').innerHTML = tiles
      .map(([k, v]) => `<div class="rt-stat"><span class="rt-stat__k">${k}</span><span class="rt-stat__v">${v}</span></div>`)
      .join('');
  }

  function renderControls() {
    const t = total();
    $('[data-presets]').innerHTML = PRESETS.map(n => {
      const fits = presetFits(t, n);
      return `<button type="button" class="rt-seg__btn" data-preset="${n}" ${fits && boot.canWrite ? '' : 'disabled'} ${fits ? '' : `title="Too short for ${n} days of at least 1 km"`}>${n} days</button>`;
    }).join('');
    $('[data-paces]').innerHTML = PACES_S.map(
      s => `<button type="button" class="rt-seg__btn" data-pace="${s}" aria-pressed="${s === pace}">${paceLabel(s)}</button>`
    ).join('');
    const custom = $<HTMLInputElement>('[data-pace-custom]');
    if (document.activeElement !== custom) custom.value = (PACES_S as readonly number[]).includes(pace) ? '' : paceLabel(pace);
    $<HTMLInputElement>('[data-climb]').checked = climbOn;
  }

  $('[data-presets]').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-preset]');
    if (!b || !route) return;
    const before = breaks;
    const n = Number(b.dataset.preset);
    breaks = evenBreaks(total(), n);
    renderAll(false);
    toast(`Split into ${n} even days.`, () => { breaks = before; renderAll(false); });
  });
  $('[data-paces]').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-pace]');
    if (!b) return;
    pace = Number(b.dataset.pace);
    renderAll(false);
  });
  $<HTMLInputElement>('[data-pace-custom]').addEventListener('change', e => {
    const input = e.target as HTMLInputElement;
    if (!input.value.trim()) return;
    const s = parsePace(input.value);
    input.setAttribute('aria-invalid', String(s === null));
    if (s !== null) { pace = s; renderAll(false); }
  });
  $<HTMLInputElement>('[data-climb]').addEventListener('change', e => {
    climbOn = (e.target as HTMLInputElement).checked;
    renderAll(false);
  });

  function renderStages() {
    const ro = !boot.canWrite;
    const last = current.length - 1;
    $('[data-stages]').innerHTML = current
      .map((s, k) => {
        const coords = `${s.end.lat.toFixed(5)}, ${s.end.lon.toFixed(5)}`;
        const climbPart = route!.hasElevation && climbOn ? `<span class="rt-sub">${hmm(s.flatS)} + ${hmm(s.climbS)} climb</span>` : '';
        return `<tr data-day="${k}">
          <th scope="row"><span class="rt-swatch" style="background:${colour(k)}"></span>${s.day}</th>
          <td class="rt-nowrap">${km(s.startM)}–${km(s.endM)}</td>
          <td class="num">${km(s.distanceM)} km</td>
          <td class="num">${s.ascentM === null ? '–' : `${fmtInt(s.ascentM)} / ${fmtInt(s.descentM!)} m`}</td>
          <td class="num"><strong>${hmm(s.totalS)}</strong>${climbPart}</td>
          <td>${k === last ? '<span class="rt-muted">Finish</span>' : `<span class="rt-coords">${coords}</span> <button type="button" class="rt-link" data-copy="${coords}" aria-label="Copy day ${s.day} end coordinates">Copy</button>`}</td>
          <td class="rt-actions">
            ${k < last && !ro ? `<button type="button" class="rt-nudge" data-nudge="-1" aria-label="Move day ${s.day} end back 0.1 km">−</button><button type="button" class="rt-nudge" data-nudge="1" aria-label="Move day ${s.day} end on 0.1 km">+</button><button type="button" class="rt-link" data-merge aria-label="Merge day ${s.day} with day ${s.day + 1}">Merge</button>` : ''}
            <button type="button" class="rt-link" data-export aria-label="Export day ${s.day} as GPX">GPX</button>
          </td>
        </tr>`;
      })
      .join('');
  }

  const stagesBody = $('[data-stages]');
  stagesBody.addEventListener('click', async e => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>('[data-day]');
    if (!row || !route) return;
    const k = Number(row.dataset.day);
    if (t.closest('[data-merge]')) {
      breaks = breaks.filter((_, i) => i !== k);
      renderAll(false);
    }
    const copy = t.closest<HTMLElement>('[data-copy]');
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy!);
        toast(`Copied ${copy.dataset.copy}`);
      } catch {
        toast('Copy failed. Select the coordinates instead.');
      }
    }
    if (t.closest('[data-export]')) {
      const s = current[k];
      const name = $<HTMLInputElement>('[data-name]').value.trim() || route.name;
      const blob = new Blob([stageGpx(route.profile, s, name, route.hasElevation)], { type: 'application/gpx+xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'route'}-day-${s.day}.gpx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  });

  // Nudge, with hold to repeat.
  let repeat = 0;
  const stopRepeat = () => { clearTimeout(repeat); clearInterval(repeat); repeat = 0; };
  stagesBody.addEventListener('pointerdown', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-nudge]');
    if (!b || !route) return;
    const k = Number(b.closest<HTMLElement>('[data-day]')!.dataset.day);
    const dir = Number(b.dataset.nudge);
    const step = () => {
      breaks = breaks.map((x, i) => (i === k ? clampBreak(breaks, k, x + dir * SNAP_M, total()) : x));
      renderAll(false, false);
      updateStageRowsInPlace();
    };
    step();
    repeat = window.setTimeout(() => (repeat = window.setInterval(step, 80)), 400);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => stagesBody.addEventListener(ev, stopRepeat));
  stagesBody.addEventListener('keydown', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-nudge]');
    if (!b || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    const k = Number(b.closest<HTMLElement>('[data-day]')!.dataset.day);
    breaks = breaks.map((x, i) => (i === k ? clampBreak(breaks, k, x + Number(b.dataset.nudge) * SNAP_M, total()) : x));
    renderAll(false);
    stagesBody.querySelector<HTMLElement>(`[data-day="${k}"] [data-nudge="${b.dataset.nudge}"]`)?.focus();
  });

  /** While a nudge button is held, rebuilding the rows would drop the pointer. */
  function updateStageRowsInPlace() {
    current.forEach((s, k) => {
      const row = stagesBody.querySelector<HTMLElement>(`[data-day="${k}"]`);
      if (!row) return;
      const cells = row.children;
      cells[1].textContent = `${km(s.startM)}–${km(s.endM)}`;
      cells[2].textContent = `${km(s.distanceM)} km`;
      cells[3].textContent = s.ascentM === null ? '–' : `${fmtInt(s.ascentM)} / ${fmtInt(s.descentM!)} m`;
      const climbPart = route!.hasElevation && climbOn ? `<span class="rt-sub">${hmm(s.flatS)} + ${hmm(s.climbS)} climb</span>` : '';
      cells[4].innerHTML = `<strong>${hmm(s.totalS)}</strong>${climbPart}`;
      const c = cells[5].querySelector<HTMLElement>('.rt-coords');
      if (c) c.textContent = `${s.end.lat.toFixed(5)}, ${s.end.lon.toFixed(5)}`;
      const cp = cells[5].querySelector<HTMLElement>('[data-copy]');
      if (cp) cp.dataset.copy = `${s.end.lat.toFixed(5)}, ${s.end.lon.toFixed(5)}`;
    });
  }

  // ── Save ───────────────────────────────────────────────────────────
  function status() {
    const el = $('[data-status]');
    if (!boot.canWrite) el.textContent = 'View only';
    else el.textContent = dirty() ? 'Unsaved changes' : planId ? 'Saved' : '';
    el.classList.toggle('is-dirty', dirty());
  }

  function saveDraft() {
    const s = storage();
    if (!s || !route) return;
    try {
      if (!dirty()) return s.removeItem(draftKey);
      s.setItem(draftKey, JSON.stringify({ planId, name: $<HTMLInputElement>('[data-name]').value, breaks, pace, climbOn, routeDirty, route }));
    } catch {
      // Over quota or blocked: the draft is a convenience, not the record.
    }
  }

  $('[data-save]').addEventListener('click', async () => {
    if (!route || !boot.canWrite) return;
    const name = $<HTMLInputElement>('[data-name]').value.trim();
    if (!name) {
      $('[data-status]').textContent = 'Give the plan a name first.';
      $<HTMLInputElement>('[data-name]').focus();
      return;
    }
    const btn = $<HTMLButtonElement>('[data-save]');
    btn.disabled = true;
    $('[data-status]').textContent = 'Saving…';
    const plan = { name, pace_s_per_km: pace, climb_allowance: climbOn, breaks_m: breaks };
    const routeBody = routeDirty
      ? {
          name: route.name,
          source_filename: route.filename,
          total_distance_m: route.summary.distanceM,
          total_ascent_m: route.summary.ascentM,
          total_descent_m: route.summary.descentM,
          max_elevation_m: route.summary.maxElevationM,
          has_elevation: route.hasElevation,
          profile: route.profile,
        }
      : undefined;
    const r = await post(planId ? { action: 'update', id: planId, plan, route: routeBody } : { action: 'create', plan, route: routeBody });
    btn.disabled = false;
    if (!r.ok) {
      $('[data-status]').textContent = r.error;
      return;
    }
    planId = r.data.id;
    routeDirty = false;
    savedSnapshot = snapshot();
    const entry: SavedPlan = { id: planId!, name, stages: breaks.length + 1, distanceM: route.summary.distanceM, updatedAt: r.data.updated_at };
    plans = [entry, ...plans.filter(p => p.id !== planId)];
    renderSaved();
    history.replaceState(null, '', `${location.pathname}?plan=${planId}`);
    storage()?.removeItem(draftKey);
    status();
  });
  $('[data-name]').addEventListener('input', () => { status(); saveDraft(); });

  window.addEventListener('beforeunload', e => {
    if (dirty() && boot.canWrite) {
      saveDraft();
      e.preventDefault();
    }
  });

  // ── Render ─────────────────────────────────────────────────────────
  function renderAll(fitMap: boolean, rebuildStages = true) {
    if (!route) return;
    current = stages(route.profile, breaks, route.hasElevation, { paceSPerKm: pace, climbAllowance: climbOn });
    $('[data-file-name]').textContent = route.filename || route.name;
    $('[data-file-meta]').textContent = `${km(route.summary.distanceM)} km`;
    $('[data-noele]').hidden = route.hasElevation;
    $('[data-replace-wrap]').hidden = !boot.canWrite;
    $('[data-save]').hidden = !boot.canWrite;
    $<HTMLInputElement>('[data-name]').readOnly = !boot.canWrite;
    renderStats();
    renderControls();
    if (rebuildStages) renderStages();
    drawProfile();
    status();
    saveDraft();
    ensureMap().then(() => renderMap(fitMap));
  }

  let resizeFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(drawProfile);
  }).observe(prof);

  // ── Start ──────────────────────────────────────────────────────────
  renderSaved();
  $('[data-sample]').hidden = !boot.sample;
  if (!boot.canWrite) {
    $('[data-drop]').hidden = true;
  }

  // A draft left by a closed tab or a reloaded phone browser.
  const draftRaw = storage()?.getItem(draftKey);
  if (draftRaw && boot.canWrite) {
    try {
      const d = JSON.parse(draftRaw);
      const li = document.createElement('li');
      li.className = 'rt-saved__item rt-saved__item--draft';
      li.innerHTML = `<button type="button" class="rt-saved__open">${esc(d.name || d.route?.name || 'Untitled')}</button><span class="rt-saved__meta">Unsaved draft in this browser</span><button type="button" class="rt-btn rt-btn--quiet" data-discard>Discard</button>`;
      $('[data-saved]').prepend(li);
      $('[data-saved-empty]').hidden = true;
      li.querySelector('.rt-saved__open')!.addEventListener('click', () => {
        route = d.route;
        planId = d.planId;
        breaks = d.breaks;
        pace = d.pace;
        climbOn = d.climbOn;
        routeDirty = d.routeDirty;
        $<HTMLInputElement>('[data-name]').value = d.name;
        savedSnapshot = '';
        li.remove();
        show('planner');
        renderAll(true);
      });
      li.querySelector('[data-discard]')!.addEventListener('click', () => {
        storage()?.removeItem(draftKey);
        li.remove();
        renderSaved();
      });
    } catch {
      storage()?.removeItem(draftKey);
    }
  }

  const wanted = new URLSearchParams(location.search).get('plan');
  if (wanted) openPlan(wanted);
  else show('empty');
}
