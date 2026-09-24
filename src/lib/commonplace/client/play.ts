/**
 * The play screen, for every mode, on maps and on flashcards.
 *
 * The server has already drawn the map and decided what this run asks
 * (lib/commonplace/play.ts). This script plays it: it keeps the queue, marks
 * answers with the same `mark()` the tests cover, climbs the hint ladder,
 * schedules each fact with FSRS when the mode is one that should, and hands
 * every result to the Recorder, which saves in the background.
 *
 * Modes differ in three things only: how the next question is chosen (the
 * player clicks, or the queue decides), how it is answered (typed, clicked,
 * chosen, flipped), and whether the answer moves the schedule. Everything else
 * — attempts, hints, reveal, the timer, the results screen — is shared.
 */
import { mark, recall, type MarkOptions } from '../mark.ts';
import { typedHint, hintSteps } from '../hints.ts';
import { resultOf, gradeOf, counts, RESULTS, type Attempt, type CardResult, type Grade } from '../result.ts';
import { review, type StoredState } from '../schedule.ts';
import { countdownSeconds } from '../modes.ts';
import type { PlayData, PlayItem, PoolEntry } from '../play.ts';
import type { CpFinish } from '../../database.types.ts';
import { MapView } from './map-view.ts';
import { REGION_LABEL } from '../regions.ts';
import { Recorder } from './recorder.ts';

const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T | null;
const need = <T extends Element = HTMLElement>(id: string) => {
  const el = $<T>(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};
const SVG = 'http://www.w3.org/2000/svg';

function shuffle<T>(a: T[]): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

type Current = {
  item: PlayItem;
  t0: number;
  wrong: number;
  hints: number;
  close: boolean;
  /** Learn mode: shown with its answer, not yet asked. */
  intro?: boolean;
  /** Learn mode: a second go after a miss. Not recorded again. */
  retry?: boolean;
};

/** Learn mode's script: introduce, ask, and ask again after a miss. */
type Step = { item: PlayItem; intro: boolean; retry: boolean; final?: boolean };

export function startPlay() {
  const data: PlayData = JSON.parse(need('cpData').textContent!);
  const { settings, mode } = data;
  const root = need('cpPlay');

  if (data.empty) return;

  // ── Elements ────────────────────────────────────────────────────────
  const svg = $<SVGSVGElement>('cpMap');
  const outline = $<SVGSVGElement>('cpOutline');
  const promptEl = need('cpPrompt');
  const form = need<HTMLFormElement>('cpForm');
  const input = need<HTMLInputElement>('cpInput');
  const hintEl = need('cpHint');
  const feedback = need('cpFeedback');
  const notice = need('cpNotice');
  const progressEl = need('cpProgress');
  const timerEl = need('cpTimer');
  const hintBtn = need<HTMLButtonElement>('cpHintBtn');
  const revealBtn = need<HTMLButtonElement>('cpRevealBtn');
  const nextBtn = need<HTMLButtonElement>('cpNextBtn');
  const doneBtn = need<HTMLButtonElement>('cpDoneBtn');
  const choices = need('cpChoices');
  const flip = need('cpFlip');
  const showBtn = need<HTMLButtonElement>('cpShowBtn');
  const cardPrompt = $('cpCardPrompt');
  const cardAnswer = $('cpCardAnswer');
  const tray = $('cpTray');
  const liveEl = need('cpLive');
  const finishBtn = need<HTMLButtonElement>('cpFinishBtn');

  const isMap = data.kind === 'map';
  const freeSelect = isMap && (mode === 'name' || mode === 'capital');
  const recorder = new Recorder(data.api, msg => {
    notice.textContent = msg;
    notice.hidden = false;
  });

  // ── Map ─────────────────────────────────────────────────────────────
  const shapes = new Map<string, SVGElement[]>();
  const meta = new Map<string, { c: [number, number]; b: [number, number, number, number]; small: boolean; cap?: [number, number] }>();
  let view: MapView | null = null;
  const labels = svg?.querySelector<SVGGElement>('.cp-map__labels') ?? null;
  const caps = svg?.querySelector<SVGGElement>('.cp-map__caps') ?? null;
  const inPlay = new Set(data.inPlay);

  if (svg) {
    for (const el of svg.querySelectorAll<SVGElement>('[data-key]')) {
      const key = el.dataset.key!;
      if (!shapes.has(key)) shapes.set(key, []);
      shapes.get(key)!.push(el);
      if (el.dataset.b) {
        meta.set(key, {
          c: el.dataset.c!.split(',').map(Number) as [number, number],
          b: el.dataset.b.split(',').map(Number) as [number, number, number, number],
          small: el.dataset.small === '1',
          cap: el.dataset.cap ? (el.dataset.cap.split(',').map(Number) as [number, number]) : undefined,
        });
      }
      if (!inPlay.has(key)) el.setAttribute('data-off', '');
    }
    view = new MapView(svg, {
      onPick: key => pick(key),
      onView: k => {
        svg.style.setProperty('--k', String(k));
        for (const dot of svg.querySelectorAll<SVGCircleElement>('circle.dot')) {
          dot.setAttribute('r', String((matchMedia('(pointer: coarse)').matches ? 11 : 6) * k));
        }
        for (const c of caps?.children ?? []) c.setAttribute('r', String(4 * k));
      },
    });
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-zoom]')) {
      b.addEventListener('click', () => {
        const z = b.dataset.zoom;
        if (z === 'in') view!.zoomBy(0.7);
        else if (z === 'out') view!.zoomBy(1 / 0.7);
        else view!.reset();
      });
    }
  }

  const setAttr = (key: string, name: string, value: string | null) => {
    for (const el of shapes.get(key) ?? []) {
      if (value === null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    }
  };
  const clearAll = (name: string) => {
    svg?.querySelectorAll(`[${name}]`).forEach(el => el.removeAttribute(name));
  };

  function addLabel(key: string, text: string, kind: CardResult | 'target' | 'wrong' = 'clean') {
    if (!labels || !settings.labels && kind !== 'target') return;
    const m = meta.get(key);
    if (!m) return;
    labels.querySelector(`[data-for="${key}"]`)?.remove();
    const t = document.createElementNS(SVG, 'text');
    t.setAttribute('x', String(m.small ? m.c[0] : m.c[0]));
    t.setAttribute('y', String(m.c[1]));
    t.setAttribute('data-for', key);
    t.setAttribute('data-kind', kind);
    if (m.small) t.setAttribute('data-small', '');
    t.textContent = text;
    labels.appendChild(t);
  }

  function showCapital(key: string) {
    const m = meta.get(key);
    if (!caps || !m?.cap) return;
    caps.replaceChildren();
    const c = document.createElementNS(SVG, 'circle');
    c.setAttribute('cx', String(m.cap[0]));
    c.setAttribute('cy', String(m.cap[1]));
    c.setAttribute('r', String(4 * (view?.scale ?? 1)));
    caps.appendChild(c);
  }

  function focusOn(key: string) {
    const m = meta.get(key);
    if (!m || !view) return;
    if (m.small) view.zoomTo(m.b, 0.18);
    else view.ensureVisible(m.c);
  }

  // ── Queue ───────────────────────────────────────────────────────────
  let items = [...data.items];
  const area = (i: PlayItem) => {
    const b = i.key ? meta.get(i.key)?.b : undefined;
    return b ? (b[2] - b[0]) * (b[3] - b[1]) : 0;
  };
  if (!data.daily && mode !== 'review') {
    switch (settings.order) {
      case 'west': items.sort((a, b) => (meta.get(a.key!)?.c[0] ?? 0) - (meta.get(b.key!)?.c[0] ?? 0)); break;
      case 'largest': items.sort((a, b) => area(b) - area(a)); break;
      case 'smallest': items.sort((a, b) => area(a) - area(b)); break;
      case 'deck': break;
      default: items = shuffle(items);
    }
  }
  if (settings.length && !data.daily && mode !== 'learn') items = items.slice(0, settings.length);
  const total = items.length;
  const byKey = new Map(items.filter(i => i.key).map(i => [i.key!, i]));
  if (isMap && mode !== 'neighbours') {
    // Anything cut by the round length is out of this run: grey, not clickable.
    for (const k of inPlay) {
      if (!byKey.has(k) && mode !== 'learn') setAttr(k, 'data-off', '');
    }
  }

  const done = new Map<string, CardResult>();
  const answered: { item: PlayItem; result: CardResult }[] = [];
  const states: Record<string, StoredState> = { ...data.states };
  let current: Current | null = null;
  let ended = false;
  let lastPoint: [number, number] | null = null;

  // Learn mode's script.
  const steps: Step[] = [];
  let stepIndex = -1;
  if (mode === 'learn') {
    for (let g = 0; g < items.length; g += 3) {
      const group = items.slice(g, g + 3);
      for (const item of group) steps.push({ item, intro: true, retry: false });
      for (const item of shuffle(group)) steps.push({ item, intro: false, retry: false });
    }
    if (items.length > 3) for (const item of shuffle(items)) steps.push({ item, intro: false, retry: true, final: true });
  }

  const rivalsFor = (item: PlayItem): string[] => {
    const pool: PoolEntry[] = data.pools[item.pool] ?? [];
    const out: string[] = [];
    for (const p of pool) if (p.key !== (item.key ?? item.ref)) out.push(...p.answers);
    return out;
  };

  const marking: MarkOptions = data.marking;

  // ── Recording ───────────────────────────────────────────────────────
  recorder.start({
    deckRef: data.deckRef, mode, settings, scope: settings.scope, pbKey: data.pbKey, total, daily: data.daily,
  });

  function record(item: PlayItem, a: Attempt, ms: number, grade?: Grade) {
    const result = resultOf(a);
    let state: StoredState | null = null;
    if (data.schedules) {
      state = review(states[item.ref] ?? null, grade ?? gradeOf(a, ms, isMap ? 'map' : 'card'), new Date(), data.retention);
      states[item.ref] = state;
    }
    recorder.answer({ ref: item.ref, result, attempts: a.wrong + 1, hints: a.hints, ms: Math.round(ms), state });
  }

  // ── Timer ───────────────────────────────────────────────────────────
  const t0 = Date.now();
  const limit = countdownSeconds(settings.timer);
  const tick = () => {
    const elapsed = Date.now() - t0;
    if (settings.timer === 'off') timerEl.textContent = '';
    else if (limit) {
      const left = limit * 1000 - elapsed;
      timerEl.textContent = clock(left);
      if (left <= 0) end('time');
    } else timerEl.textContent = clock(elapsed);
  };
  const timer = setInterval(tick, 250);
  tick();

  function updateProgress() {
    progressEl.textContent = mode === 'learn' ? `${done.size} of ${total} new` : `${done.size} / ${total}`;
  }
  updateProgress();

  const say = (msg: string, tone: 'good' | 'close' | 'bad' | 'info' = 'info') => {
    feedback.textContent = msg;
    feedback.dataset.tone = tone;
  };
  const announce = (msg: string) => { liveEl.textContent = msg; };

  // ── Presenting a question ───────────────────────────────────────────
  const show = (el: HTMLElement, on: boolean) => { el.hidden = !on; };

  function present(item: PlayItem, opts: { intro?: boolean; retry?: boolean } = {}) {
    current = { item, t0: Date.now(), wrong: 0, hints: 0, close: false, intro: opts.intro, retry: opts.retry };
    hintEl.textContent = '';
    input.value = '';
    clearAll('data-selected');
    clearAll('data-target');
    clearAll('data-dim');
    clearAll('data-pulse');
    caps?.replaceChildren();
    labels?.querySelector('[data-kind="target"]')?.remove();

    const typed = item.ask === 'type' && mode !== 'choice' && mode !== 'flip';
    const clicking = item.ask === 'click';
    show(form, (typed || mode === 'free' || mode === 'neighbours') && !opts.intro);
    show(hintBtn, settings.hints && !opts.intro && mode !== 'free' && mode !== 'neighbours' && mode !== 'choice' && mode !== 'flip');
    show(revealBtn, !opts.intro && mode !== 'free' && mode !== 'neighbours' && mode !== 'flip');
    show(nextBtn, !!opts.intro);
    show(doneBtn, mode === 'neighbours');
    show(choices, mode === 'choice');
    show(flip, mode === 'flip');

    // Prompt text.
    if (!isMap && cardPrompt) cardPrompt.textContent = item.prompt;
    if (opts.intro) {
      promptEl.textContent = isMap ? `This is ${item.answers[0]}` : 'A new card. Read it, then press Next.';
      if (cardAnswer) { cardAnswer.textContent = item.answers[0]; cardAnswer.hidden = false; }
    } else if (!isMap) {
      promptEl.textContent = mode === 'flip' ? '' : mode === 'choice' ? 'Choose the answer' : 'Type the answer';
      if (cardAnswer) { cardAnswer.textContent = ''; cardAnswer.hidden = true; }
    } else if (clicking) {
      promptEl.textContent = item.ref.startsWith('capital:')
        ? `Which country has the capital ${item.prompt}?`
        : `Find ${item.prompt}`;
    } else if (item.pool === 'capitals') {
      promptEl.textContent = `The capital of ${item.prompt}?`;
    } else if (mode === 'neighbours') {
      promptEl.textContent = `Everything that borders ${item.answers[0]}`;
    } else {
      promptEl.textContent = mode === 'outline' ? 'Which place is this?' : 'Name this place';
    }

    if (isMap && item.key) {
      if (mode === 'outline') drawOutline(item.key);
      else if (!clicking) {
        setAttr(item.key, 'data-target', '');
        if (!freeSelect || mode === 'capital') focusOn(item.key);
        if (opts.intro || mode === 'neighbours') addLabel(item.key, item.answers[0], 'target');
        if (item.pool === 'capitals' && opts.intro) showCapital(item.key);
      }
      if (freeSelect) setAttr(item.key, 'data-selected', '');
      const region = data.pools.names.find(p => p.key === item.key)?.region;
      announce(`${clicking ? promptEl.textContent : 'A place is highlighted'}${region ? `, in ${REGION_LABEL[region] ?? region}` : ''}.`);
    } else {
      announce(promptEl.textContent ?? '');
    }

    if (mode === 'choice') drawChoices(item);
    if (mode === 'flip') { showBtn.hidden = false; flip.querySelector<HTMLElement>('.cp-grades')!.hidden = true; }
    if (mode === 'neighbours') startNeighbours(item);

    promptEl.closest('.cp-panel')?.scrollTo({ top: 0 });
    if (!form.hidden && !matchMedia('(pointer: coarse)').matches) input.focus({ preventScroll: true });
    else if (!form.hidden && document.activeElement !== input && typed) input.focus({ preventScroll: true });
  }

  function drawOutline(key: string) {
    if (!outline) return;
    const src = shapes.get(key)?.find(el => el.tagName === 'path');
    const m = meta.get(key);
    if (!src || !m) return;
    const [x0, y0, x1, y1] = m.b;
    const pad = Math.max(x1 - x0, y1 - y0) * 0.15 + 1;
    outline.setAttribute('viewBox', `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`);
    outline.replaceChildren();
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', src.getAttribute('d') ?? '');
    outline.appendChild(p);
  }

  // ── Choosing the next question ──────────────────────────────────────
  function remaining(): PlayItem[] {
    return items.filter(i => !done.has(i.ref));
  }

  function next() {
    if (ended) return;
    if (mode === 'learn') {
      stepIndex++;
      if (stepIndex >= steps.length) return end('done');
      const s = steps[stepIndex];
      return present(s.item, { intro: s.intro, retry: s.retry });
    }
    const left = remaining();
    if (!left.length) return end('done');
    if (mode === 'free') return presentFree();
    if (freeSelect) {
      if (settings.advance === 'stay' && current) { current = null; clearAll('data-selected'); promptEl.textContent = 'Click a place to name it'; show(form, false); return; }
      if (settings.advance === 'nearest' && lastPoint) {
        const [lx, ly] = lastPoint;
        left.sort((a, b) => {
          const ca = meta.get(a.key!)?.c ?? [0, 0];
          const cb = meta.get(b.key!)?.c ?? [0, 0];
          return Math.hypot(ca[0] - lx, ca[1] - ly) - Math.hypot(cb[0] - lx, cb[1] - ly);
        });
      }
    }
    present(left[0]);
  }

  // ── Answering ───────────────────────────────────────────────────────
  function complete(result: 'right' | 'revealed', opts: { close?: boolean; grade?: Grade } = {}) {
    if (!current || ended) return;
    const c = current;
    const { item } = c;
    const attempt: Attempt = { wrong: c.wrong, hints: c.hints, close: !!opts.close || c.close, revealed: result === 'revealed' };
    const r = resultOf(attempt);
    const ms = Date.now() - c.t0;

    if (mode === 'learn') {
      if (!c.retry && !done.has(item.ref)) {
        record(item, attempt, ms, opts.grade);
        done.set(item.ref, r);
        answered.push({ item, result: r });
      }
      if (!counts(r)) {
        // Asked again before the next group is introduced, or before the
        // final mixed round, whichever comes first.
        let at = stepIndex + 1;
        while (at < steps.length && !steps[at].intro && !steps[at].final) at++;
        const final = !!steps[stepIndex]?.final;
        steps.splice(final ? steps.length : at, 0, { item, intro: false, retry: true, final });
      }
    } else {
      record(item, attempt, ms, opts.grade);
      done.set(item.ref, r);
      answered.push({ item, result: r });
    }

    if (item.key) {
      setAttr(item.key, 'data-result', r);
      setAttr(item.key, 'data-target', null);
      addLabel(item.key, item.answers[0], r);
      lastPoint = meta.get(item.key)?.c ?? lastPoint;
      updateTray();
    }
    const also = item.also.length ? ` (also ${item.also.join(', ')})` : '';
    const noteText = item.notes ? ` ${item.notes}` : '';
    if (r === 'clean') say(`Right: ${item.answers[0]}${also}.${noteText}`, 'good');
    else if (r === 'close') say(`Right, spelt ${item.answers[0]}${also}.${noteText}`, 'close');
    else if (r === 'hinted') say(`Right, with a hint: ${item.answers[0]}${also}.${noteText}`, 'close');
    else say(`It was ${item.answers[0]}${also}.${noteText}`, 'bad');
    updateProgress();

    if (!isMap && cardAnswer) { cardAnswer.textContent = item.answers[0]; cardAnswer.hidden = false; }

    current = null;
    // A beat to read the answer on a flashcard or a reveal; none on a map hit.
    const wait = !isMap ? (r === 'clean' ? 700 : 1600) : r === 'revealed' ? 1100 : 0;
    if (wait) setTimeout(next, wait);
    else next();
  }

  function wrongAttempt(message: string) {
    if (!current) return;
    current.wrong++;
    say(message, 'bad');
    form.dataset.shake = '';
    setTimeout(() => delete form.dataset.shake, 400);
    if (settings.sudden && mode !== 'learn') {
      complete('revealed');
      return end('sudden');
    }
    if (settings.attempts && current.wrong >= settings.attempts && mode !== 'learn') complete('revealed');
  }

  function submitTyped(text: string) {
    if (ended) return;
    if (mode === 'free') return;
    if (mode === 'neighbours') return neighbourGuess(text);
    if (!current) {
      say('Click a place first.', 'info');
      return;
    }
    if (current.item.ask !== 'type') return;
    if (!text.trim()) return;
    const verdict = mark(text, current.item.answers, rivalsFor(current.item), marking);
    if (verdict === 'exact') complete('right');
    else if (verdict === 'close') complete('right', { close: true });
    else wrongAttempt(`Not ${text.trim()}.`);
    input.value = '';
  }

  function pick(key: string) {
    if (ended) return;
    if (current?.intro) return;
    if (freeSelect) {
      const item = byKey.get(key);
      if (!item) return;
      if (done.has(item.ref)) {
        say(`That was ${item.answers[0]}.`, 'info');
        return;
      }
      if (current && current.item.key === key) return;
      present(item);
      return;
    }
    if (!current || current.item.ask !== 'click') return;
    if (key === current.item.key) {
      complete('right');
    } else {
      const other = data.pools.names.find(p => p.key === key);
      setAttr(key, 'data-flash', 'wrong');
      setTimeout(() => setAttr(key, 'data-flash', null), 700);
      wrongAttempt(other ? `That is ${other.answers[0]}.` : 'Not that one.');
    }
  }

  // ── Hints ───────────────────────────────────────────────────────────
  function hint() {
    if (!current || current.intro || !settings.hints) return;
    const { item } = current;
    if (item.ask === 'click' && item.key) {
      const step = current.hints;
      current.hints++;
      const region = item.region;
      const regional = [...inPlay].filter(k => data.pools.names.find(p => p.key === k)?.region === region);
      if (step === 0) {
        for (const k of inPlay) if (!regional.includes(k)) setAttr(k, 'data-dim', '');
        hintEl.textContent = `Somewhere in ${REGION_LABEL[region] ?? region}.`;
      } else if (step === 1) {
        const pts = regional.map(k => meta.get(k)?.c).filter(Boolean) as [number, number][];
        const midX = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const midY = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        const t = meta.get(item.key)!.c;
        for (const k of inPlay) {
          const c = meta.get(k)?.c;
          if (!c) continue;
          const same = (c[0] < midX) === (t[0] < midX) && (c[1] < midY) === (t[1] < midY);
          if (!same) setAttr(k, 'data-dim', '');
        }
        hintEl.textContent = 'In the part of the map still lit.';
      } else if (step === 2) {
        const around = data.neighbours[item.key] ?? [];
        for (const n of around) setAttr(n, 'data-pulse', '');
        hintEl.textContent = around.length ? 'It borders the places pulsing.' : 'An island: nothing borders it.';
      } else {
        return reveal();
      }
      return;
    }

    // Typed. A flashcard's own hint first, a capital's dot first, then the ladder.
    const extra = item.hint ? 1 : item.pool === 'capitals' && item.key && meta.get(item.key)?.cap ? 1 : 0;
    const step = current.hints;
    const ladder = step - extra + 1;
    if (step >= extra + hintSteps(item.answers[0])) return reveal();
    current.hints++;
    if (step < extra) {
      if (item.hint) hintEl.textContent = item.hint;
      else if (item.key) { showCapital(item.key); hintEl.textContent = 'The dot is the city.'; }
    } else {
      hintEl.textContent = typedHint(item.answers[0], ladder);
    }
    input.focus({ preventScroll: true });
  }

  function reveal() {
    if (!current || current.intro) return;
    if (current.item.key) {
      setAttr(current.item.key, 'data-flash', 'answer');
      const k = current.item.key;
      setTimeout(() => setAttr(k, 'data-flash', null), 1200);
      focusOn(current.item.key);
    }
    complete('revealed');
  }

  // ── Multiple choice ─────────────────────────────────────────────────
  function drawChoices(item: PlayItem) {
    const pool = (data.pools[item.pool] ?? []).filter(p => p.key !== (item.key ?? item.ref));
    const near = item.key ? new Set(data.neighbours[item.key] ?? []) : new Set<string>();
    const ranked = [
      ...shuffle(pool.filter(p => near.has(p.key))),
      ...shuffle(pool.filter(p => !near.has(p.key) && p.region === item.region)),
      ...shuffle(pool.filter(p => !near.has(p.key) && p.region !== item.region)),
    ];
    const options = shuffle([item.answers[0], ...ranked.slice(0, 3).map(p => p.answers[0])]);
    choices.replaceChildren(...options.map(text => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cp-choice';
      b.textContent = text;
      b.addEventListener('click', () => {
        if (!current || b.disabled) return;
        if (text === item.answers[0]) {
          b.dataset.right = '';
          complete('right');
        } else {
          b.disabled = true;
          b.dataset.wrong = '';
          wrongAttempt(`Not ${text}.`);
        }
      });
      return b;
    }));
  }

  // ── Flashcards: flip and rate ───────────────────────────────────────
  showBtn.addEventListener('click', () => {
    if (!current || !cardAnswer) return;
    cardAnswer.textContent = current.item.answers[0] + (current.item.notes ? ` · ${current.item.notes}` : '');
    cardAnswer.hidden = false;
    showBtn.hidden = true;
    flip.querySelector<HTMLElement>('.cp-grades')!.hidden = false;
  });
  for (const b of flip.querySelectorAll<HTMLButtonElement>('[data-grade]')) {
    b.addEventListener('click', () => {
      if (!current) return;
      const grade = Number(b.dataset.grade) as Grade;
      // The rating is the player's own, so it goes to the scheduler as given.
      // The result recorded for the run follows it: Again is not known.
      if (grade === 1) complete('revealed', { grade });
      else complete('right', { close: grade === 2, grade });
    });
  }

  // ── Free recall ─────────────────────────────────────────────────────
  function presentFree() {
    current = null;
    promptEl.textContent = isMap
      ? data.items[0]?.pool === 'capitals' ? 'Type capitals, in any order' : 'Type places, in any order'
      : 'Type answers, in any order';
    show(form, true);
    show(hintBtn, false);
    show(revealBtn, false);
    show(doneBtn, true);
    doneBtn.textContent = 'Give up';
    input.focus({ preventScroll: true });
  }
  input.addEventListener('input', () => {
    if (mode !== 'free' || ended) return;
    const left = remaining();
    const hit = recall(input.value, left.map(i => [i, i.answers] as [PlayItem, readonly string[]]));
    if (!hit) return;
    current = { item: hit, t0, wrong: 0, hints: 0, close: false };
    input.value = '';
    complete('right');
  });

  // ── Neighbours ──────────────────────────────────────────────────────
  let found = new Set<string>();
  let neighbourWrong = 0;
  function startNeighbours(item: PlayItem) {
    found = new Set();
    neighbourWrong = 0;
    labels?.querySelectorAll('[data-kind="neighbour"]').forEach(n => n.remove());
    clearAll('data-found');
    const around = data.neighbours[item.key!] ?? [];
    hintEl.textContent = `${around.length} to find.`;
    doneBtn.textContent = 'Done';
    if (view) {
      // Frame the place and everything round it.
      const boxes = [item.key!, ...around].map(k => meta.get(k)?.b).filter(Boolean) as [number, number, number, number][];
      const b: [number, number, number, number] = [
        Math.min(...boxes.map(x => x[0])), Math.min(...boxes.map(x => x[1])),
        Math.max(...boxes.map(x => x[2])), Math.max(...boxes.map(x => x[3])),
      ];
      view.zoomTo(b, 0.15);
    }
  }
  function neighbourGuess(text: string) {
    if (!current) return;
    const key = current.item.key!;
    const around = data.neighbours[key] ?? [];
    const hit = recall(text, around.filter(n => !found.has(n)).map(n => [n, data.names[n] ?? []] as [string, readonly string[]]));
    input.value = '';
    if (hit) {
      found.add(hit);
      setAttr(hit, 'data-found', '');
      addNeighbourLabel(hit);
      const left = around.length - found.size;
      hintEl.textContent = left ? `${left} more.` : 'All found.';
      say(`Yes: ${(data.names[hit] ?? [hit])[0]}.`, 'good');
      if (!left) finishNeighbours();
      return;
    }
    const other = Object.entries(data.names).find(([, names]) => mark(text, names, [], { typos: false }) === 'exact');
    neighbourWrong++;
    say(other ? `${other[1][0]} does not border it.` : `Not a place on this map: ${text}.`, 'bad');
  }
  function addNeighbourLabel(key: string, missed = false) {
    if (!labels) return;
    const m = meta.get(key);
    if (!m) return;
    const t = document.createElementNS(SVG, 'text');
    t.setAttribute('x', String(m.c[0]));
    t.setAttribute('y', String(m.c[1]));
    t.setAttribute('data-kind', 'neighbour');
    if (missed) t.setAttribute('data-missed', '');
    t.textContent = (data.names[key] ?? [key])[0];
    labels.appendChild(t);
  }
  function finishNeighbours() {
    if (!current) return;
    const key = current.item.key!;
    const around = data.neighbours[key] ?? [];
    const missed = around.filter(n => !found.has(n));
    for (const n of missed) { addNeighbourLabel(n, true); setAttr(n, 'data-found', 'missed'); }
    current.wrong = neighbourWrong;
    if (missed.length) {
      say(`Missed: ${missed.map(n => (data.names[n] ?? [n])[0]).join(', ')}.`, 'bad');
      const c = current;
      current = null;
      done.set(c.item.ref, 'revealed');
      answered.push({ item: c.item, result: 'revealed' });
      record(c.item, { wrong: c.wrong, hints: 0, close: false, revealed: true }, Date.now() - c.t0);
      setAttr(key, 'data-result', 'revealed');
      updateProgress();
      setTimeout(next, 2200);
    } else {
      complete('right', { close: neighbourWrong > 0 });
    }
  }

  // ── Tray of small places ────────────────────────────────────────────
  const trayKeys = freeSelect
    ? items.filter(i => i.key && meta.get(i.key)?.small).map(i => i.key!)
        .sort((a, b) => (meta.get(a)!.c[0]) - (meta.get(b)!.c[0]))
    : [];
  function updateTray() {
    if (!tray) return;
    tray.hidden = !trayKeys.length;
    tray.querySelector('.cp-tray__chips')?.replaceChildren(...trayKeys.map((k, i) => {
      const item = byKey.get(k)!;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cp-chip';
      const r = done.get(item.ref);
      if (r) b.dataset.result = r;
      // Numbered until answered: a name here would be the answer.
      b.textContent = r ? item.answers[0] : String(i + 1);
      b.title = r ? item.answers[0] : `Small place ${i + 1}`;
      b.addEventListener('click', () => {
        view?.zoomToKey(k, 0.15);
        pick(k);
      });
      b.addEventListener('pointerenter', () => setAttr(k, 'data-hover', ''));
      b.addEventListener('pointerleave', () => setAttr(k, 'data-hover', null));
      return b;
    }));
  }
  updateTray();

  // ── Ending ──────────────────────────────────────────────────────────
  async function end(reason: 'done' | 'time' | 'sudden' | 'quit') {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    const elapsed = Date.now() - t0;
    current = null;
    clearAll('data-target');
    clearAll('data-selected');
    clearAll('data-dim');

    // What was not reached is shown, not recorded: it was never asked.
    const unanswered = mode === 'learn' ? [] : remaining();
    for (const item of unanswered) {
      if (item.key) {
        setAttr(item.key, 'data-result', 'missed');
        if (mode === 'free' || reason !== 'done') addLabel(item.key, item.answers[0], 'revealed');
      }
    }
    view?.reset();

    form.hidden = true;
    for (const b of [hintBtn, revealBtn, nextBtn, doneBtn, finishBtn]) b.hidden = true;
    choices.hidden = true;
    flip.hidden = true;

    const tally: Record<CardResult, number> = { clean: 0, close: 0, hinted: 0, revealed: 0 };
    for (const a of answered) tally[a.result]++;
    const known = tally.clean + tally.close;
    const lead = { done: 'Finished', time: 'Time’s up', sudden: 'Sudden death', quit: 'Stopped' }[reason];

    need('cpResHead').textContent = mode === 'learn' ? `Learnt ${answered.length}` : `${lead}: ${known} of ${total}`;
    need('cpResTime').textContent = settings.timer === 'off' ? '' : clock(elapsed);
    for (const r of RESULTS) need(`cpRes-${r}`).textContent = String(tally[r]);
    need('cpRes-missed').textContent = String(unanswered.length);

    const missed = answered.filter(a => !counts(a.result)).map(a => a.item).concat(unanswered);
    const list = need('cpResList');
    list.replaceChildren(...missed.slice(0, 60).map(i => {
      const li = document.createElement('li');
      li.textContent = i.prompt && !isMap ? `${i.prompt} → ${i.answers[0]}` : i.prompt ? `${i.prompt}: ${i.answers[0]}` : i.answers[0];
      return li;
    }));
    const missedLink = need<HTMLAnchorElement>('cpMissed');
    if (missed.length && data.missedHref) {
      const u = new URL(data.missedHref, location.href);
      u.searchParams.set('only', missed.map(i => i.key ?? i.ref.split(':')[1]).join(','));
      missedLink.href = u.pathname + u.search;
      missedLink.hidden = false;
    }

    need('cpResults').hidden = false;
    root.dataset.ended = '';
    need('cpResults').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const saved: CpFinish | null = await recorder.finish();
    const bestEl = need('cpResBest');
    if (saved?.previous_best) {
      const pb = saved.previous_best;
      const better = known > pb.known || (known === pb.known && saved.duration_ms < pb.duration_ms);
      bestEl.textContent = better
        ? `A new personal best. The last was ${pb.known} of ${pb.total} in ${clock(pb.duration_ms)}.`
        : `Your best here is ${pb.known} of ${pb.total} in ${clock(pb.duration_ms)}.`;
    } else if (saved) {
      bestEl.textContent = 'Your first run with these settings. Next time you will have something to beat.';
    }
    if (saved && settings.timer !== 'off') need('cpResTime').textContent = clock(saved.duration_ms);
  }

  finishBtn.addEventListener('click', () => end(remaining().length ? 'quit' : 'done'));

  // ── Wiring ──────────────────────────────────────────────────────────
  form.addEventListener('submit', e => {
    e.preventDefault();
    submitTyped(input.value);
  });
  hintBtn.addEventListener('click', hint);
  revealBtn.addEventListener('click', () => {
    if (mode === 'choice' && current) {
      for (const b of choices.querySelectorAll<HTMLButtonElement>('button')) if (b.textContent === current.item.answers[0]) b.dataset.right = '';
    }
    reveal();
  });
  nextBtn.addEventListener('click', () => next());
  doneBtn.addEventListener('click', () => {
    if (mode === 'neighbours') finishNeighbours();
    else if (mode === 'free') end('quit');
  });

  document.addEventListener('keydown', e => {
    if (ended) return;
    const inInput = e.target === input;
    if ((e.key === 'h' && e.ctrlKey) || (e.key === '?' && (inInput ? !input.value : true))) {
      e.preventDefault();
      hint();
    } else if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      reveal();
    } else if (e.key === 'Enter' && current?.intro) {
      e.preventDefault();
      next();
    } else if (e.key === 'Escape' && freeSelect && current) {
      current = null;
      clearAll('data-selected');
      promptEl.textContent = 'Click a place to name it';
    } else if (e.key === 'Tab' && freeSelect && !e.altKey) {
      const left = remaining();
      if (!left.length) return;
      e.preventDefault();
      const at = current ? left.findIndex(i => i.ref === current!.item.ref) : -1;
      const to = left[(at + (e.shiftKey ? -1 : 1) + left.length) % left.length];
      present(to);
      if (to.key) focusOn(to.key);
    } else if (!inInput && view && (e.key === '+' || e.key === '=')) view.zoomBy(0.7);
    else if (!inInput && view && e.key === '-') view.zoomBy(1 / 0.7);
    else if (!inInput && view && e.key === '0') view.reset();
  });

  // Keep the input above an on-screen keyboard: the visual viewport shrinks,
  // the layout viewport (on iOS) does not, so the page is sized from the former.
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => root.style.setProperty('--vvh', `${vv.height}px`);
    vv.addEventListener('resize', fit);
    fit();
  }

  next();
}
