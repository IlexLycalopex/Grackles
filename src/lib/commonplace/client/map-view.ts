/**
 * Zoom and pan for a pre-projected SVG map.
 *
 * Works by moving the viewBox, never by transforming the paths: borders drawn
 * with vector-effect: non-scaling-stroke stay one pixel wide at any zoom, and
 * the paths stay real elements a click can land on.
 *
 * Mouse wheel and trackpad zoom around the pointer, a drag pans, two fingers
 * pinch. A press that moves less than a few pixels is a click and is handed to
 * `onPick` with the key of whatever was under it, so a drag that ends over a
 * country does not also answer it.
 */

type Box = { x: number; y: number; w: number; h: number };

export interface MapViewOptions {
  onPick?: (key: string) => void;
  /** Called after every change of view, e.g. to resize dots and labels. */
  onView?: (unitsPerPixel: number) => void;
}

const CLICK_SLOP = 6;

export class MapView {
  readonly svg: SVGSVGElement;
  readonly full: Box;
  private box: Box;
  private pointers = new Map<number, { x: number; y: number }>();
  private press: { x: number; y: number; key: string | null; moved: boolean } | null = null;
  private pinch: { d: number; box: Box; mid: { x: number; y: number } } | null = null;

  constructor(svg: SVGSVGElement, private opts: MapViewOptions = {}) {
    this.svg = svg;
    const [x, y, w, h] = svg.getAttribute('viewBox')!.split(/\s+/).map(Number);
    this.full = { x, y, w, h };
    this.box = { ...this.full };

    svg.addEventListener('wheel', e => this.wheel(e), { passive: false });
    svg.addEventListener('pointerdown', e => this.down(e));
    svg.addEventListener('pointermove', e => this.move(e));
    svg.addEventListener('pointerup', e => this.up(e));
    svg.addEventListener('pointercancel', e => this.cancel(e));
    svg.addEventListener('dblclick', e => {
      const key = keyAt(e.target);
      if (key) this.zoomToKey(key, 0.35);
    });
    new ResizeObserver(() => this.apply()).observe(svg);
    this.apply();
  }

  /** SVG units per screen pixel, at the current zoom. */
  get scale(): number {
    const r = this.svg.getBoundingClientRect();
    if (!r.width || !r.height) return this.box.w / 1000;
    // preserveAspectRatio meet: the larger ratio is the one that binds.
    return Math.max(this.box.w / r.width, this.box.h / r.height);
  }

  get zoomed(): boolean {
    return this.box.w < this.full.w * 0.98;
  }

  private apply() {
    const { x, y, w, h } = this.box;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.opts.onView?.(this.scale);
  }

  private clamp(b: Box): Box {
    const w = Math.min(this.full.w, Math.max(this.full.w / 40, b.w));
    const h = (w / b.w) * b.h;
    // Allow a little overscroll so an edge country can be centred, no more.
    const pad = w * 0.25;
    const x = Math.min(this.full.x + this.full.w - w + pad, Math.max(this.full.x - pad, b.x));
    const y = Math.min(this.full.y + this.full.h - h + pad, Math.max(this.full.y - pad, b.y));
    return { x, y, w, h };
  }

  /** A screen point to map units. */
  private toMap(cx: number, cy: number) {
    const r = this.svg.getBoundingClientRect();
    const s = this.scale;
    // Centre the letterbox the same way preserveAspectRatio="xMidYMid meet" does.
    const offX = (r.width * s - this.box.w) / 2;
    const offY = (r.height * s - this.box.h) / 2;
    return { x: this.box.x - offX + (cx - r.left) * s, y: this.box.y - offY + (cy - r.top) * s };
  }

  zoomBy(factor: number, at?: { x: number; y: number }) {
    const c = at ?? { x: this.box.x + this.box.w / 2, y: this.box.y + this.box.h / 2 };
    const w = this.box.w * factor;
    const h = this.box.h * factor;
    this.box = this.clamp({
      x: c.x - (c.x - this.box.x) * (w / this.box.w),
      y: c.y - (c.y - this.box.y) * (h / this.box.h),
      w, h,
    });
    this.apply();
  }

  reset() {
    this.box = { ...this.full };
    this.apply();
  }

  /**
   * Frame a bounding box, no tighter than `minFraction` of the whole map, so a
   * microstate is shown with enough around it to be recognisable.
   */
  zoomTo([x0, y0, x1, y1]: [number, number, number, number], minFraction = 0.2) {
    const aspect = this.full.h / this.full.w;
    let w = Math.max((x1 - x0) * 1.6, ((y1 - y0) * 1.6) / aspect, this.full.w * minFraction);
    w = Math.min(w, this.full.w);
    const h = w * aspect;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    this.box = this.clamp({ x: cx - w / 2, y: cy - h / 2, w, h });
    this.apply();
  }

  zoomToKey(key: string, minFraction = 0.2) {
    const el = this.svg.querySelector<SVGElement>(`[data-key="${key}"][data-b]`);
    if (!el) return;
    const b = el.dataset.b!.split(',').map(Number) as [number, number, number, number];
    this.zoomTo(b, minFraction);
  }

  /** Pan, without zooming, if a point has gone out of view. */
  ensureVisible([x, y]: [number, number]) {
    const m = this.box.w * 0.08;
    if (x > this.box.x + m && x < this.box.x + this.box.w - m && y > this.box.y + m && y < this.box.y + this.box.h - m) return;
    this.box = this.clamp({ ...this.box, x: x - this.box.w / 2, y: y - this.box.h / 2 });
    this.apply();
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    // Trackpads send many small deltas, mice a few large ones. Exponential in
    // the delta treats both the same.
    const factor = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0022));
    this.zoomBy(factor, this.toMap(e.clientX, e.clientY));
  }

  private down(e: PointerEvent) {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.press = { x: e.clientX, y: e.clientY, key: keyAt(e.target), moved: false };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = {
        d: Math.hypot(a.x - b.x, a.y - b.y),
        box: { ...this.box },
        mid: this.toMap((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
      if (this.press) this.press.moved = true;
    }
  }

  private move(e: PointerEvent) {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const factor = this.pinch.d / d;
      const w = this.pinch.box.w * factor;
      const h = this.pinch.box.h * factor;
      const m = this.pinch.mid;
      this.box = this.clamp({
        x: m.x - (m.x - this.pinch.box.x) * (w / this.pinch.box.w),
        y: m.y - (m.y - this.pinch.box.y) * (h / this.pinch.box.h),
        w, h,
      });
      this.apply();
      return;
    }

    if (!this.press) return;
    if (!this.press.moved && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) < CLICK_SLOP) return;
    if (!this.press.moved) {
      this.press.moved = true;
      this.svg.setPointerCapture(e.pointerId);
      this.svg.dataset.dragging = '';
    }
    const s = this.scale;
    this.box = this.clamp({
      ...this.box,
      x: this.box.x - (e.clientX - prev.x) * s,
      y: this.box.y - (e.clientY - prev.y) * s,
    });
    this.apply();
  }

  private up(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      const press = this.press;
      this.press = null;
      delete this.svg.dataset.dragging;
      if (press && !press.moved && press.key) this.opts.onPick?.(press.key);
    }
  }

  private cancel(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    this.pinch = null;
    this.press = null;
    delete this.svg.dataset.dragging;
  }
}

function keyAt(target: EventTarget | null): string | null {
  const el = (target as Element | null)?.closest?.('[data-key]');
  if (!el || el.hasAttribute('data-off')) return null;
  return el.getAttribute('data-key');
}
