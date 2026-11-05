// The board of the Squad panel (ADR 0016), as two cells of the panel's
// lattice: its head (legend and zoom) and its port, where blocks are placed in
// a world that is moved by dragging the ground and zoomed with the wheel, the
// links between
// them drawn from the blocks' measured boxes, a + at every crossing of the
// grid behind. The view is written straight to the DOM (a CSSOM transform),
// so moving it does not render the blocks again. Geometry in boardGeometry.ts.

import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { type Box, bounds, fit, route, type View, zoomAt } from './boardGeometry.js';

export interface BoardBlock {
  id: string;
  /** Where it sits in the world, and how wide it is; its height is its content's. */
  x: number;
  y: number;
  width: number;
  children: ComponentChildren;
}

export interface BoardLink {
  id: string;
  from: string;
  to: string;
  label: string;
  /** Off the centre line, so two links between the same blocks run side by side. */
  lane: number;
  /** Something is moving along it: the line marches. */
  live?: boolean;
  /** It waits for you: the label is inverted. */
  waiting?: boolean;
}

const GRID = 40;
const PAD = 28;

const sameBoxes = (a: ReadonlyMap<string, Box>, b: ReadonlyMap<string, Box>) =>
  a.size === b.size &&
  [...a].every(([id, box]) => {
    const other = b.get(id);
    return other?.x === box.x && other.y === box.y && other.w === box.w && other.h === box.h;
  });

export function Board({
  label,
  blocks,
  links,
  legend,
}: {
  label: string;
  blocks: readonly BoardBlock[];
  links: readonly BoardLink[];
  /** Shown in the board's head, before the zoom. */
  legend?: ComponentChildren;
}) {
  const port = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const grid = useRef<SVGPatternElement>(null);
  const zoom = useRef<HTMLSpanElement>(null);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  /** The user has moved the view: a resize no longer fits it again. */
  const moved = useRef(false);
  const [boxes, setBoxes] = useState<ReadonlyMap<string, Box>>(new Map());

  const apply = () => {
    const { x, y, k } = view.current;
    if (world.current)
      world.current.style.transform = `translate(${String(x)}px, ${String(y)}px) scale(${String(k)})`;
    grid.current?.setAttribute(
      'patternTransform',
      `translate(${String(x)} ${String(y)}) scale(${String(k)})`,
    );
    if (zoom.current) zoom.current.textContent = `${String(Math.round(k * 100))}%`;
  };
  const set = (next: View) => {
    view.current = next;
    apply();
  };
  const fitAll = (current: ReadonlyMap<string, Box> = boxes) => {
    const content = bounds([...current.values()]);
    const element = port.current;
    if (!content || !element) return;
    set(fit(content, element.clientWidth, element.clientHeight, PAD));
  };

  // The blocks' boxes in world units: their place, and the size the layout gave them.
  const measure = () => {
    const next = new Map<string, Box>();
    for (const block of blocks) {
      const element = world.current?.querySelector<HTMLElement>(`[data-block="${block.id}"]`);
      if (element)
        next.set(block.id, {
          x: block.x,
          y: block.y,
          w: element.offsetWidth,
          h: element.offsetHeight,
        });
    }
    setBoxes((current) => (sameBoxes(current, next) ? current : next));
    return next;
  };
  // Measured when the blocks change place; their sizes are watched below. Not
  // at every render: that forced a layout each time the panel's data moved.
  const placement = blocks
    .map((b) => `${b.id}:${String(b.x)},${String(b.y)},${String(b.width)}`)
    .join(';');
  useLayoutEffect(() => {
    measure();
  }, [placement]);

  useEffect(() => {
    const element = port.current;
    const inner = world.current;
    if (!element || !inner) return;
    fitAll(measure());
    const observer = new ResizeObserver(() => {
      const next = measure();
      if (!moved.current) fitAll(next);
    });
    observer.observe(element);
    for (const child of inner.querySelectorAll('[data-block]')) observer.observe(child);
    // Wheel listeners must not be passive to keep the page from scrolling.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      moved.current = true;
      set(
        zoomAt(
          view.current,
          event.clientX - rect.left,
          event.clientY - rect.top,
          Math.exp(-event.deltaY * 0.0015),
        ),
      );
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', onWheel);
    };
  }, [blocks.length]);

  const onPointerDown = (event: PointerEvent) => {
    const element = port.current;
    if (!element || event.button !== 0) return;
    // Blocks keep their own clicks; only the ground drags.
    if ((event.target as Element).closest('.bd__block')) return;
    const start = { x: event.clientX, y: event.clientY, view: view.current };
    element.setPointerCapture(event.pointerId);
    element.classList.add('bd__port--grab');
    const onMove = (move: PointerEvent) => {
      moved.current = true;
      set({
        ...start.view,
        x: start.view.x + move.clientX - start.x,
        y: start.view.y + move.clientY - start.y,
      });
    };
    const onUp = () => {
      element.classList.remove('bd__port--grab');
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
    };
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
  };

  const zoomBy = (factor: number) => {
    const element = port.current;
    if (!element) return;
    moved.current = true;
    set(zoomAt(view.current, element.clientWidth / 2, element.clientHeight / 2, factor));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== port.current) return;
    const pan: Record<string, readonly [number, number]> = {
      ArrowLeft: [GRID, 0],
      ArrowRight: [-GRID, 0],
      ArrowUp: [0, GRID],
      ArrowDown: [0, -GRID],
    };
    const step = pan[event.key];
    if (step) {
      moved.current = true;
      set({ ...view.current, x: view.current.x + step[0], y: view.current.y + step[1] });
    } else if (event.key === '+' || event.key === '=') zoomBy(1.2);
    else if (event.key === '-') zoomBy(1 / 1.2);
    else if (event.key === '0') {
      moved.current = false;
      fitAll();
    } else return;
    event.preventDefault();
  };

  return (
    <>
      <header class="cn-cell cn-cell--row bd__head" aria-label={label}>
        <div class="bd__legend">{legend}</div>
        <div class="bd__ctl">
          <button
            class="cn-btn cn-btn--text"
            type="button"
            aria-label="Riduci"
            onClick={() => {
              zoomBy(1 / 1.2);
            }}
          >
            <span class="cn-btn__label">−</span>
          </button>
          <span ref={zoom} class="t-data bd__zoom">
            100%
          </span>
          <button
            class="cn-btn cn-btn--text"
            type="button"
            aria-label="Ingrandisci"
            onClick={() => {
              zoomBy(1.2);
            }}
          >
            <span class="cn-btn__label">+</span>
          </button>
          <button
            class="cn-btn cn-btn--text"
            type="button"
            onClick={() => {
              moved.current = false;
              fitAll();
            }}
          >
            <span class="cn-btn__label">Adatta</span>
          </button>
        </div>
      </header>
      <div
        ref={port}
        class="cn-cell cn-cell--flush bd__port"
        role="group"
        aria-label={`${label}: trascina il fondo per spostarti, rotella o + e − per lo zoom, 0 adatta`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <svg class="bd__grid" aria-hidden="true">
          <defs>
            <pattern
              ref={grid}
              id="bd-grid"
              width={GRID}
              height={GRID}
              patternUnits="userSpaceOnUse"
            >
              <path
                d={`M${String(GRID / 2 - 4)} ${String(GRID / 2)}h8M${String(GRID / 2)} ${String(GRID / 2 - 4)}v8`}
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#bd-grid)" />
        </svg>
        <div ref={world} class="bd__world">
          <svg class="bd__links" aria-hidden="true">
            {links.map((link) => {
              const from = boxes.get(link.from);
              const to = boxes.get(link.to);
              if (!from || !to) return null;
              const r = route(from, to, link.lane);
              return (
                <g key={link.id} class={link.live ? 'bd__link bd__link--live' : 'bd__link'}>
                  <polyline points={r.points.map((p) => p.join(',')).join(' ')} />
                  <polygon points={r.head.map((p) => p.join(',')).join(' ')} />
                </g>
              );
            })}
          </svg>
          {links.map((link) => {
            const from = boxes.get(link.from);
            const to = boxes.get(link.to);
            if (!from || !to) return null;
            const [x, y] = route(from, to, link.lane).label;
            return (
              <span
                key={link.id}
                class={link.waiting ? 'bd__label cn-tag cn-accent' : 'bd__label cn-tag'}
                style={{ left: `${String(x)}px`, top: `${String(y)}px` }}
              >
                {link.label}
              </span>
            );
          })}
          {blocks.map((block) => (
            <div
              key={block.id}
              class="bd__block"
              data-block={block.id}
              style={{
                left: `${String(block.x)}px`,
                top: `${String(block.y)}px`,
                width: `${String(block.width)}px`,
              }}
            >
              {block.children}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
