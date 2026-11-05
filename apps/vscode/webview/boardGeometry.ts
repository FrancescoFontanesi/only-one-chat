// The geometry of the Squad board (ADR 0016): the view over the world (pan
// and zoom), fitting the blocks in, and the orthogonal route of a link between
// two blocks. Pure, so it is tested without a DOM.

/** A point of the world is drawn at `world · k + (x, y)` in the viewport. */
export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Point = readonly [number, number];

export const ZOOM = { min: 0.4, max: 2 } as const;

const clampZoom = (k: number) => Math.max(ZOOM.min, Math.min(ZOOM.max, k));

/** The box around every box; null when there are none. */
export function bounds(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The view that centres `content` in a viewport, `pad` around it, never above `max`. */
export function fit(content: Box, width: number, height: number, pad: number, max = 1): View {
  const room = (size: number) => Math.max(1, size - 2 * pad);
  const k = Math.min(clampZoom(Math.min(room(width) / content.w, room(height) / content.h)), max);
  return {
    k,
    x: (width - content.w * k) / 2 - content.x * k,
    y: (height - content.h * k) / 2 - content.y * k,
  };
}

/** Zooms by `factor`, keeping the world point under (px, py) where it is. */
export function zoomAt(view: View, px: number, py: number, factor: number): View {
  const k = clampZoom(view.k * factor);
  const ratio = k / view.k;
  return { k, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio };
}

export interface Route {
  points: readonly Point[];
  /** Where the label sits: the middle of the route's middle segment. */
  label: Point;
  /** The arrowhead at the end, as a triangle. */
  head: readonly Point[];
}

const HEAD = 7;

function arrowhead(from: Point, to: Point): Point[] {
  const dx = Math.sign(to[0] - from[0]);
  const dy = Math.sign(to[1] - from[1]);
  const [x, y] = to;
  // Back along the last segment, then half a head to either side.
  return [
    [x, y],
    [x - dx * HEAD - dy * (HEAD / 2), y - dy * HEAD + dx * (HEAD / 2)],
    [x - dx * HEAD + dy * (HEAD / 2), y - dy * HEAD - dx * (HEAD / 2)],
  ];
}

/**
 * An orthogonal route from one box to another: out of the side that faces it,
 * across with one elbow if the boxes are not level, into the facing side.
 * `lane` shifts it off the centre, so two links between the same boxes run
 * side by side.
 */
export function route(from: Box, to: Box, lane: number): Route {
  const cx = (b: Box) => b.x + b.w / 2;
  const cy = (b: Box) => b.y + b.h / 2;
  const apart = to.x >= from.x + from.w || to.x + to.w <= from.x;
  let points: Point[];
  if (apart) {
    const right = to.x >= from.x + from.w;
    const sx = right ? from.x + from.w : from.x;
    const ex = right ? to.x : to.x + to.w;
    // Level boxes share a straight line through the middle of their overlap.
    const top = Math.max(from.y, to.y);
    const bottom = Math.min(from.y + from.h, to.y + to.h);
    if (bottom - top > 2 * Math.abs(lane)) {
      const y = (top + bottom) / 2 + lane;
      points = [
        [sx, y],
        [ex, y],
      ];
    } else {
      const mx = (sx + ex) / 2;
      points = [
        [sx, cy(from) + lane],
        [mx, cy(from) + lane],
        [mx, cy(to) + lane],
        [ex, cy(to) + lane],
      ];
    }
  } else {
    const down = cy(to) >= cy(from);
    const sy = down ? from.y + from.h : from.y;
    const ey = down ? to.y : to.y + to.h;
    const my = (sy + ey) / 2;
    points = [
      [cx(from) + lane, sy],
      [cx(from) + lane, my],
      [cx(to) + lane, my],
      [cx(to) + lane, ey],
    ];
  }
  const middle = Math.floor((points.length - 1) / 2);
  const a = points[middle] ?? points[0] ?? [0, 0];
  const b = points[middle + 1] ?? a;
  const last = points[points.length - 1] ?? b;
  const before = points[points.length - 2] ?? a;
  return {
    points,
    label: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
    head: arrowhead(before, last),
  };
}
