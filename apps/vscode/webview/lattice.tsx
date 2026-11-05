// The design system's Lattice (Cyber Nihilism, ADR 0016) in Preact: a view as
// one grid of cells, its lines drawn on an SVG overlay from where the cells
// really are. bundle.js draws them in the design system; it writes inline
// styles, which the webview's CSP refuses, so they are drawn here. Every
// `.cn-cell` inside the lattice counts, nested ones too, except those of a
// lattice nested in it. Broken lines by default (open perimeter, a + at each
// junction), solid lines with perimeter nodes on request.

import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { brokenLines, latticeLines, type Rect } from './latticeGeometry.js';

const SVG = 'http://www.w3.org/2000/svg';
/** The side of a node, in px. */
const NODE = 5;
/**
 * The arm of a + on each side of its centre pixel, in px. The lines leave 6
 * pixels free on each side of that pixel, so 3 stay clear between the + and
 * every line.
 */
const PLUS = 3;

export type Edges = { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean };

interface Look {
  solid: boolean;
  nodes: boolean;
  edges: Edges;
  dense: number;
}

/** What each overlay last drew: its geometry, to skip a redraw that would change nothing. */
const drawn = new WeakMap<SVGSVGElement, string>();

function draw(root: HTMLElement, svg: SVGSVGElement, look: Look): void {
  const box = root.getBoundingClientRect();
  const width = Math.round(root.clientWidth);
  const height = Math.round(root.clientHeight);
  const kx = box.width / (root.offsetWidth || 1) || 1;
  const ky = box.height / (root.offsetHeight || 1) || 1;
  const rects: Rect[] = [];
  const whole: Rect[] = [];
  for (const cell of root.querySelectorAll<HTMLElement>('.cn-cell')) {
    if (cell.closest('.cn-lattice') !== root) continue;
    const r = cell.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    // In the lattice's own units, also when an ancestor scales it (the Squad board's zoom).
    const rect = {
      x0: Math.round((r.left - box.left) / kx),
      y0: Math.round((r.top - box.top) / ky),
      x1: Math.round((r.right - box.left) / kx),
      y1: Math.round((r.bottom - box.top) / ky),
    };
    rects.push(rect);
    if (cell.classList.contains('cn-accent')) whole.push(rect);
  }
  // The same cells in the same places draw the same lines: nothing to do.
  const key = JSON.stringify([width, height, rects, whole, look]);
  if (drawn.get(svg) === key) return;
  // A line on the boundary is drawn inside it, on whole pixels.
  const px = (value: number, max: number) => Math.min(Math.max(value, 0), max - 1) + 0.5;
  const make = (tag: string, attributes: Record<string, number | string>) => {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, String(value));
    }
    return element;
  };
  const group = make('g', { class: 'cn-lattice__l' });
  const children: Element[] = [group];
  if (look.solid) {
    const lines = latticeLines(rects, width, height);
    for (const l of lines.horizontal) {
      const y = px(l.at, height);
      group.append(make('line', { x1: l.from, x2: l.to, y1: y, y2: y }));
    }
    for (const l of lines.vertical) {
      const x = px(l.at, width);
      group.append(make('line', { x1: x, x2: x, y1: l.from, y2: l.to }));
    }
    if (look.nodes) {
      for (const n of lines.nodes) {
        const x = Math.round(px(n.x, width) - NODE / 2);
        const y = Math.round(px(n.y, height) - NODE / 2);
        children.push(make('rect', { class: 'cn-lattice__n', x, y, width: NODE, height: NODE }));
      }
    }
  } else {
    const broken = brokenLines(rects, width, height, {
      edges: look.edges,
      whole,
      dense: look.dense,
    });
    // On whole pixels: a line runs through the middle of its row or column.
    for (const s of broken.segments) {
      const at = s.at + 0.5;
      group.append(
        make(
          'line',
          s.horizontal
            ? { x1: s.from, x2: s.to, y1: at, y2: at }
            : { x1: at, x2: at, y1: s.from, y2: s.to },
        ),
      );
    }
    // A + of 2·PLUS + 1 pixels centred on its pixel: as far from the lines on every side.
    const pluses = make('g', { class: 'cn-lattice__p' });
    for (const p of broken.pluses) {
      pluses.append(
        make('line', { x1: p.x - PLUS, x2: p.x + PLUS + 1, y1: p.y + 0.5, y2: p.y + 0.5 }),
        make('line', { x1: p.x + 0.5, x2: p.x + 0.5, y1: p.y - PLUS, y2: p.y + PLUS + 1 }),
      );
    }
    children.push(pluses);
  }
  drawn.set(svg, key);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${String(width)} ${String(height)}`);
  svg.replaceChildren(...children);
}

export function Lattice({
  class: className,
  lines = 'broken',
  nodes = true,
  edges = {},
  dense = 64,
  rows,
  children,
}: {
  class?: string;
  /** Broken (the design system's default) or solid. */
  lines?: 'broken' | 'solid';
  /** With solid lines: square nodes where lines meet the outer boundary. */
  nodes?: boolean;
  /** With broken lines: the sides of the perimeter that are drawn. */
  edges?: Edges;
  /** With broken lines: junctions closer than this on one line stay plain (0: every junction is cut). */
  dense?: number;
  /** The rows of this lattice, when they depend on its content. */
  rows?: string;
  children: ComponentChildren;
}) {
  const look = useRef<Look>({ solid: lines === 'solid', nodes, edges, dense });
  look.current = { solid: lines === 'solid', nodes, edges, dense };
  const root = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const frame = useRef(0);

  const schedule = () => {
    if (frame.current !== 0) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (root.current && svg.current) draw(root.current, svg.current, look.current);
    });
  };

  // Drawn once laid out; then only when the geometry can have changed: the
  // root or one of its cells changes size, or cells come and go. Not at each
  // render nor at each change of text inside a cell: that forced a layout many
  // times a second while the chat streamed or a progress ticked.
  useLayoutEffect(() => {
    if (root.current && svg.current) draw(root.current, svg.current, look.current);
  }, [lines, nodes, dense, rows, edges.top, edges.bottom, edges.left, edges.right]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const resize = new ResizeObserver(schedule);
    const watchCells = () => {
      resize.disconnect();
      resize.observe(element);
      for (const cell of element.querySelectorAll('.cn-cell'))
        if (cell.closest('.cn-lattice') === element) resize.observe(cell);
    };
    watchCells();
    // Cells added or removed among its own children (a cell that shows only sometimes).
    const mutation = new MutationObserver(() => {
      watchCells();
      schedule();
    });
    mutation.observe(element, { childList: true });
    void document.fonts.ready.then(schedule);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, []);

  return (
    <div
      ref={root}
      class={className ? `cn-lattice ${className}` : 'cn-lattice'}
      data-lines={lines}
      {...(rows ? { style: { gridTemplateRows: rows } } : {})}
    >
      {children}
      <svg ref={svg} class="cn-lattice__lines" aria-hidden="true" />
    </div>
  );
}

/**
 * A panel framed by its vertices: one lattice cell closed on its four sides,
 * every line broken around a + at each corner, so no box is drawn whole.
 */
export function Crossed({
  class: className,
  children,
}: {
  class?: string;
  children: ComponentChildren;
}) {
  return (
    <Lattice
      class={className ? `xf ${className}` : 'xf'}
      edges={{ top: true, bottom: true, left: true, right: true }}
      dense={0}
    >
      <div class="cn-cell cn-cell--flush xf__c">{children}</div>
    </Lattice>
  );
}
