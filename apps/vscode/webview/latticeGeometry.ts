// The Lattice's lines (Cyber Nihilism, ADR 0016): one grid of cells whose
// structure lines come from the cells' real geometry. Every cell edge becomes a
// segment and segments on the same line that touch become one line. Solid
// lines get a node where a line meets the outer boundary; broken lines (the
// design system's default, as on a drafting sheet) leave the perimeter open
// and stop short of each junction around a small +. Pure functions.

export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** A horizontal line at y = `at` from x = `from` to `to`, or a vertical one at x = `at`. */
export interface Line {
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

export interface Lines {
  readonly horizontal: readonly Line[];
  readonly vertical: readonly Line[];
  readonly nodes: readonly { readonly x: number; readonly y: number }[];
}

/** Segments closer than this many pixels are one line. */
const TOLERANCE = 1;

function merge(segments: Line[]): Line[] {
  // Edges a pixel apart (rounding) are the same line.
  const ats = [...new Set(segments.map((s) => s.at))].sort((a, b) => a - b);
  const snap = new Map<number, number>();
  for (const at of ats) {
    const previous = ats[ats.indexOf(at) - 1];
    const base = previous === undefined ? at : (snap.get(previous) ?? previous);
    snap.set(at, previous !== undefined && at - previous <= TOLERANCE ? base : at);
  }
  const byAt = new Map<number, Line[]>();
  for (const segment of segments) {
    const at = snap.get(segment.at) ?? segment.at;
    const list = byAt.get(at) ?? [];
    list.push({ ...segment, at });
    byAt.set(at, list);
  }
  const merged: Line[] = [];
  for (const [at, list] of [...byAt].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.from - b.from);
    let from = list[0]?.from ?? 0;
    let to = list[0]?.to ?? 0;
    for (const segment of list.slice(1)) {
      if (segment.from <= to + TOLERANCE) {
        to = Math.max(to, segment.to);
      } else {
        merged.push({ at, from, to });
        from = segment.from;
        to = segment.to;
      }
    }
    merged.push({ at, from, to });
  }
  return merged;
}

/** The lines and perimeter nodes of cells inside a lattice `width` × `height` px. */
export function latticeLines(rects: readonly Rect[], width: number, height: number): Lines {
  const h: Line[] = [];
  const v: Line[] = [];
  for (const r of rects) {
    if (r.x1 - r.x0 < 1 || r.y1 - r.y0 < 1) continue;
    h.push({ at: r.y0, from: r.x0, to: r.x1 }, { at: r.y1, from: r.x0, to: r.x1 });
    v.push({ at: r.x0, from: r.y0, to: r.y1 }, { at: r.x1, from: r.y0, to: r.y1 });
  }
  const horizontal = merge(h);
  const vertical = merge(v);
  const nodes = new Map<string, { x: number; y: number }>();
  const node = (x: number, y: number) => nodes.set(`${String(x)},${String(y)}`, { x, y });
  for (const line of vertical) {
    if (line.from <= TOLERANCE) node(line.at, 0);
    if (line.to >= height - TOLERANCE) node(line.at, height);
  }
  for (const line of horizontal) {
    if (line.from <= TOLERANCE) node(0, line.at);
    if (line.to >= width - TOLERANCE) node(width, line.at);
  }
  return { horizontal, vertical, nodes: [...nodes.values()] };
}

/**
 * A line to draw, in whole pixels: on the pixel row (or column) `at`, over
 * the pixels from `from` up to `to`, `to` excluded.
 */
export interface Segment {
  readonly horizontal: boolean;
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

export interface Broken {
  readonly segments: readonly Segment[];
  /** The pixels a + is centred on: the junctions that are cut. */
  readonly pluses: readonly { readonly x: number; readonly y: number }[];
}

export interface BrokenOptions {
  /** Sides of the perimeter that are drawn: a lattice stacked under another keeps the line they share. */
  readonly edges?: {
    readonly top?: boolean;
    readonly bottom?: boolean;
    readonly left?: boolean;
    readonly right?: boolean;
  };
  /** Inverted cells: their edges stay whole and their corners get no +. */
  readonly whole?: readonly Rect[];
  /** How far a line stops from a junction's pixel, on each side, in px. */
  readonly gap?: number;
  /** Junctions closer than this to another on the same line stay plain lines. */
  readonly dense?: number;
}

const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;
const within = (value: number, from: number, to: number) =>
  value >= from - TOLERANCE && value <= to + TOLERANCE;

/** The pixel a boundary is drawn on: the one after it, the last one at the far edge. */
const pixel = (at: number, size: number) => Math.min(Math.max(Math.round(at), 0), size - 1);

/**
 * Cuts the pixels `[from, to)` around each pixel of `cuts`, leaving `gap`
 * pixels free on either side of it: the same distance before and after.
 */
function cut(from: number, to: number, cuts: readonly number[], gap: number): [number, number][] {
  const parts: [number, number][] = [];
  let start = from;
  for (const at of [...cuts].sort((a, b) => a - b)) {
    const end = at - gap;
    if (end > start) parts.push([start, end]);
    start = Math.max(start, at + gap + 1);
  }
  if (to > start) parts.push([start, to]);
  return parts;
}

/**
 * The broken lines of a lattice: the perimeter left open (but the `edges`
 * kept), every line stopping `gap` pixels short of a junction on both sides,
 * where a + sits, except where junctions crowd (`dense`) or on an inverted
 * cell's edges. In whole pixels, so a corner is cut the same on both axes.
 */
export function brokenLines(
  rects: readonly Rect[],
  width: number,
  height: number,
  options: BrokenOptions = {},
): Broken {
  const { edges = {}, whole = [], gap = 6, dense = 64 } = options;
  const lines = latticeLines(rects, width, height);
  const keepH = (l: Line) =>
    (!near(l.at, 0) || edges.top === true) && (!near(l.at, height) || edges.bottom === true);
  const keepV = (l: Line) =>
    (!near(l.at, 0) || edges.left === true) && (!near(l.at, width) || edges.right === true);
  const horizontal = lines.horizontal.filter(keepH);
  const vertical = lines.vertical.filter(keepV);

  const junctions: { x: number; y: number; h: Line; v: Line }[] = [];
  for (const h of horizontal)
    for (const v of vertical)
      if (within(v.at, h.from, h.to) && within(h.at, v.from, v.to))
        junctions.push({ x: v.at, y: h.at, h, v });

  const crowded = (j: (typeof junctions)[number]) =>
    junctions.some(
      (o) =>
        o !== j &&
        ((o.h === j.h && Math.abs(o.x - j.x) < dense) ||
          (o.v === j.v && Math.abs(o.y - j.y) < dense)),
    );
  const onWhole = (j: (typeof junctions)[number]) =>
    whole.some(
      (r) =>
        ((near(j.x, r.x0) || near(j.x, r.x1)) && within(j.y, r.y0, r.y1)) ||
        ((near(j.y, r.y0) || near(j.y, r.y1)) && within(j.x, r.x0, r.x1)),
    );
  const marked = junctions.filter((j) => !crowded(j) && !onWhole(j));

  const segments: Segment[] = [];
  for (const h of horizontal) {
    const cuts = marked.filter((j) => j.h === h).map((j) => pixel(j.x, width));
    for (const [from, to] of cut(h.from, h.to, cuts, gap))
      segments.push({ horizontal: true, at: pixel(h.at, height), from, to });
  }
  for (const v of vertical) {
    const cuts = marked.filter((j) => j.v === v).map((j) => pixel(j.y, height));
    for (const [from, to] of cut(v.from, v.to, cuts, gap))
      segments.push({ horizontal: false, at: pixel(v.at, width), from, to });
  }
  return {
    segments,
    pluses: marked.map(({ x, y }) => ({ x: pixel(x, width), y: pixel(y, height) })),
  };
}
