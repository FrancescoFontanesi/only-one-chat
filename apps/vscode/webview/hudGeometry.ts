// The geometry of the two dials beside the composer (ADR 0016, the "Pannelli
// laterali" canvas, v5): each view is 216 × 192 and holds part of a large
// circle whose centre lies outside it, toward the composer on the left side
// and away from it on the right, so the arcs face the composer. A dial of
// ticks (one major tick per role or provider) turns to the selected one; an
// outer bezel frames it; arcs fill for a level. Pure functions that
// return SVG path data.

export type Side = 'left' | 'right';

export const HUD = { width: 216, height: 192, cy: 96 } as const;

/** Degrees between two items on the dial. */
export const SPACING = 14;
/** The radii: dial, its labels, bezel, and the two level arcs (outer and inner). */
export const R = { dial: 150, label: 162, bezel: 196, outer: 138, inner: 130 } as const;
/** Half the angle the level arcs span. */
export const GAUGE = 30;

const CENTRE: Record<Side, { cx: number; dir: number }> = {
  left: { cx: 336, dir: -1 },
  right: { cx: -120, dir: 1 },
};

const rad = (deg: number) => (deg * Math.PI) / 180;
const f = (v: number) => v.toFixed(1);

export function point(side: Side, r: number, deg: number): readonly [number, number] {
  const { cx, dir } = CENTRE[side];
  return [cx + dir * r * Math.cos(rad(deg)), HUD.cy + r * Math.sin(rad(deg))];
}

/** A radial tick from radius `r1` to `r2` at `deg`. */
export function tick(side: Side, r1: number, r2: number, deg: number): string {
  const [x1, y1] = point(side, r1, deg);
  const [x2, y2] = point(side, r2, deg);
  return `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`;
}

/** An arc at radius `r` from `a0` to `a1` degrees (a0 < a1), as a polyline. */
export function arc(side: Side, r: number, a0: number, a1: number): string {
  if (a1 <= a0) return '';
  const step = Math.max(0.5, (a1 - a0) / 40);
  let d = '';
  for (let a = a0; a <= a1 + 1e-6; a += step) {
    const [x, y] = point(side, r, a);
    d += `${d ? 'L' : 'M'}${f(x)} ${f(y)}`;
  }
  const [x, y] = point(side, r, a1);
  return `${d}L${f(x)} ${f(y)}`;
}

/** The half angle of a circle of radius `r` that stays inside the view's height. */
export function limit(r: number): number {
  return (Math.asin(Math.min(1, (HUD.cy - 10) / r)) * 180) / Math.PI;
}

/** The dial turned to `rot` (an item index, fractional while it turns): its arc and ticks. */
export function dial(side: Side, rot: number, count: number) {
  const span = limit(R.dial) - 1;
  let minor = '';
  let major = '';
  const j0 = Math.floor((-span + rot * SPACING) / 2);
  const j1 = Math.ceil((span + rot * SPACING) / 2);
  for (let j = j0; j <= j1; j++) {
    const a = j * 2 - rot * SPACING;
    if (Math.abs(a) > span) continue;
    const item = j / 7;
    if (j % 7 === 0 && item >= 0 && item < count) major += tick(side, R.dial, R.dial + 9, a);
    else minor += tick(side, R.dial, R.dial + (j % 7 === 0 ? 6 : 3), a);
  }
  return { base: arc(side, R.dial, -span, span), minor, major, span };
}

/** The outer bezel, turned by `turn` degrees, toward the composer's side. */
export function bezel(side: Side, turn: number) {
  const span = limit(R.bezel);
  const shift = (side === 'left' ? -1 : 1) * (turn % 20);
  let minor = '';
  let major = '';
  for (let k = -60; k <= 60; k++) {
    const a = k * 4 + shift;
    if (Math.abs(a) > span) continue;
    if (((k % 5) + 5) % 5 === 0) major += tick(side, R.bezel, R.bezel + 7, a);
    else minor += tick(side, R.bezel, R.bezel + 3, a);
  }
  return { minor, major };
}

/** A level from 0 to 1 as an arc filled from the bottom of the gauge upward. */
export function gauge(side: Side, r: number, level: number): string {
  const v = Math.max(0, Math.min(1, level));
  return v > 0 ? arc(side, r, GAUGE - 2 * GAUGE * v, GAUGE) : '';
}

/**
 * Steps on an arc, one segment per step from the bottom up; `filled` (may be
 * fractional, while it moves) of them solid.
 */
export function steps(side: Side, r: number, count: number, filled: number) {
  const span = (2 * GAUGE) / Math.max(1, count);
  const gap = 2.5;
  let on = '';
  let off = '';
  for (let i = 0; i < count; i++) {
    const hi = GAUGE - i * span - gap / 2;
    const lo = GAUGE - (i + 1) * span + gap / 2;
    off += arc(side, r, lo, hi);
    const k = Math.max(0, Math.min(1, filled - i));
    if (k > 0) on += arc(side, r, hi - (hi - lo) * k, hi);
  }
  return { on, off };
}

/** The two short marks closing the gauge at its ends. */
export function ends(side: Side): string {
  return tick(side, R.inner - 4, R.outer + 4, GAUGE) + tick(side, R.inner - 4, R.outer + 4, -GAUGE);
}

/** Where the label of item `index` sits, and whether it is on the visible part of the dial. */
export function label(side: Side, index: number, rot: number) {
  const a = (index - rot) * SPACING;
  const [x, y] = point(side, R.label, a);
  return { x, y, visible: Math.abs(a) <= limit(R.dial) - 4 };
}

/** The fixed marks: the connector to the composer, its chevron, the focus bracket and line. */
export function marks(side: Side) {
  const [x0, x1] = side === 'left' ? [142, 178] : [38, 74];
  const y0 = HUD.cy - 8;
  const y1 = HUD.cy + 8;
  const c = 4;
  const bracket =
    `M${String(x0 + c)} ${String(y0)}H${String(x0)}V${String(y0 + c)}` +
    `M${String(x1 - c)} ${String(y0)}H${String(x1)}V${String(y0 + c)}` +
    `M${String(x0)} ${String(y1 - c)}V${String(y1)}H${String(x0 + c)}` +
    `M${String(x1)} ${String(y1 - c)}V${String(y1)}H${String(x1 - c)}`;
  return side === 'left'
    ? {
        connector: `M218 ${String(HUD.cy)}H238`,
        chevron: `M210 ${String(HUD.cy - 5)}L215 ${String(HUD.cy)}L210 ${String(HUD.cy + 5)}`,
        bracket,
        focus: `M8 ${String(HUD.cy - 4)}V${String(HUD.cy + 4)}M8 ${String(HUD.cy)}H${String(x0)}`,
      }
    : {
        connector: `M-22 ${String(HUD.cy)}H-2`,
        chevron: `M6 ${String(HUD.cy - 5)}L1 ${String(HUD.cy)}L6 ${String(HUD.cy + 5)}`,
        bracket,
        focus: `M${String(x1)} ${String(HUD.cy)}H208M208 ${String(HUD.cy - 4)}V${String(HUD.cy + 4)}`,
      };
}
