// The design system's motion (Cyber Nihilism, bundle.js): stepped, linear,
// once and then still; only what shows liveness loops. Rebuilt here because
// the bundle writes inline styles the webview's CSP refuses: these write text
// nodes, class names, CSSOM properties and canvas pixels only. Everything
// stays still under prefers-reduced-motion.

import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export const TEMPO = { frame: 83, tick: 55, char: 28, step: 60, blink: 1000, hold: 1600 } as const;

export function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** fn(0) now, then fn(i/n) every `ms` for i = 1..n, then done; under reduced motion fn(1) at once. */
export function steps(n: number, ms: number, fn: (p: number) => void, done?: () => void) {
  if (reducedMotion()) {
    fn(1);
    done?.();
    return () => undefined;
  }
  fn(0);
  let i = 0;
  const timer = window.setInterval(() => {
    i++;
    fn(Math.min(1, i / n));
    if (i >= n) {
      window.clearInterval(timer);
      done?.();
    }
  }, ms);
  return () => {
    window.clearInterval(timer);
  };
}

const GLYPHS = '#%&$@/\\|<>=+-_01';
const glyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? '#';

/** One step of Decode: the first len·p characters final, spaces kept, the rest random glyphs. */
export function decodeFrame(text: string, p: number): string {
  if (p >= 1) return text;
  const settled = Math.floor(text.length * p);
  let out = text.slice(0, settled);
  for (const char of text.slice(settled)) out += char === ' ' ? ' ' : glyph();
  return out;
}

/** Runs Decode on a text node in place, so Preact keeps owning it. */
function decodeNode(node: Text, text: string, count: number) {
  return steps(count, TEMPO.tick, (p) => {
    node.data = decodeFrame(text, p);
  });
}

/**
 * Text that settles left to right whenever it changes: a status, a label. Not
 * when it first shows, unless `initial` asks for it (a value just chosen).
 */
export function Decode({
  text,
  class: cls,
  initial = false,
}: {
  text: string;
  class?: string;
  initial?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const first = useRef(!initial);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const node = ref.current?.firstChild;
    if (!(node instanceof Text)) return;
    return decodeNode(node, text, 12);
  }, [text]);
  return (
    <span ref={ref} class={cls} aria-label={text}>
      {text}
    </span>
  );
}

/**
 * Scramble on hover, for every button's label under `root`: 8 steps, then a
 * 600 ms rest per button. One listener for the whole view.
 */
export function useHoverScramble(root: { current: HTMLElement | null }) {
  useEffect(() => {
    const element = root.current;
    if (!element || reducedMotion()) return;
    const resting = new WeakSet<Element>();
    const onOver = (event: PointerEvent) => {
      const button = (event.target as Element | null)?.closest('.cn-btn');
      if (!button || resting.has(button) || button.matches(':disabled')) return;
      // Entering the button, not moving between its parts.
      const from = event.relatedTarget as Node | null;
      if (from && button.contains(from)) return;
      const node = button.querySelector('.cn-btn__label')?.firstChild;
      if (!(node instanceof Text) || node.data.trim() === '') return;
      resting.add(button);
      decodeNode(node, node.data, 8);
      window.setTimeout(
        () => {
          resting.delete(button);
        },
        8 * TEMPO.tick + 600,
      );
    };
    element.addEventListener('pointerover', onOver);
    return () => {
      element.removeEventListener('pointerover', onOver);
    };
  }, []);
}

/** Flash: the only alert motion; the element's polarity swaps three times. */
export function flash(element: HTMLElement) {
  const base = element.dataset.theme === 'light' ? 'light' : 'dark';
  const opposite = base === 'dark' ? 'light' : 'dark';
  if (reducedMotion()) return;
  element.classList.add('cn-flashing');
  steps(
    6,
    120,
    (p) => {
      element.dataset.theme = Math.round(p * 6) % 2 ? opposite : base;
    },
    () => {
      element.dataset.theme = base;
      element.classList.remove('cn-flashing');
    },
  );
}

function once(element: Element, fn: () => void) {
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      observer.disconnect();
      fn();
    }
  });
  observer.observe(element);
  return () => {
    observer.disconnect();
  };
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

type Paint = (
  ctx: CanvasRenderingContext2D,
  k: number,
  box: { x: number; y: number; w: number; h: number },
  color: (name: string) => string,
) => void;

/** Construct: the block is drawn in, its frame lines grow, crosses land, the lines go. */
const construct: Paint = (ctx, k, { x, y, w, h }, color) => {
  const a = Math.min(1, k / 0.45);
  const land = clamp((k - 0.45) / 0.3);
  const decay = Math.max(0, (k - 0.75) / 0.25);
  const done = Math.floor(land * 4);
  ctx.fillStyle = color('--ground');
  for (let band = done; band < 4; band++) ctx.fillRect(x + (w * band) / 4, y, w / 4 + 1, h);
  if (decay >= 0.66) return;
  ctx.strokeStyle = color('--line-strong');
  ctx.lineWidth = 1;
  ctx.setLineDash(decay > 0.33 ? [2, 4] : []);
  ctx.beginPath();
  ctx.moveTo(x, y + 0.5);
  ctx.lineTo(x + a * w, y + 0.5);
  ctx.moveTo(x + w, y + h - 0.5);
  ctx.lineTo(x + w - a * w, y + h - 0.5);
  ctx.moveTo(x + 0.5, y);
  ctx.lineTo(x + 0.5, y + a * h);
  ctx.moveTo(x + w - 0.5, y + h);
  ctx.lineTo(x + w - 0.5, y + h - a * h);
  ctx.stroke();
  if (a < 1) return;
  ctx.setLineDash([]);
  ctx.strokeStyle = color('--ink');
  ctx.beginPath();
  for (const [cx, cy] of [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ] as const) {
    ctx.moveTo(cx - 5.5, cy);
    ctx.lineTo(cx + 5.5, cy);
    ctx.moveTo(cx, cy - 5.5);
    ctx.lineTo(cx, cy + 5.5);
  }
  ctx.stroke();
};

/** ASCII: cells of 7×12 resolve left to right through a ramp of glyphs. */
function asciiPaint(): Paint {
  const noise: number[] = [];
  const glyphs: { x: number; y: number; g: string }[] = [];
  return (ctx, k, { x, y, w, h }, color) => {
    const cols = Math.ceil(w / 7);
    const rows = Math.ceil(h / 12);
    // One fill colour per pass: the ground cells first, then the glyphs over them.
    glyphs.length = 0;
    ctx.fillStyle = color('--ground');
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        noise[i] ??= Math.random();
        const d = (c / cols) * 0.7 + (noise[i] ?? 0) * 0.3;
        const ph = (k * 1.6 - d) * 3.2;
        if (ph >= 1) continue;
        ctx.fillRect(x + c * 7, y + r * 12, 7, 12);
        if (ph > 0)
          glyphs.push({ x: x + c * 7, y: y + r * 12, g: '@%#*+=-:.'[Math.floor(ph * 9)] ?? '.' });
      }
    }
    ctx.font = '500 11px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = color('--ink');
    for (const glyph of glyphs) ctx.fillText(glyph.g, glyph.x, glyph.y);
  };
}

/**
 * Reveal: a block's entrance, once when it comes into view; a canvas mask
 * over it, removed at the end. Never on controls; at most a few per view.
 */
export function Reveal({
  mode = 'construct',
  delay = 0,
  play = true,
  class: cls,
  children,
}: {
  mode?: 'construct' | 'ascii';
  delay?: number;
  /** False for what was already there when the view opened. */
  play?: boolean;
  class?: string;
  children: ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host || !play || reducedMotion()) return;
    let cancel: (() => void) | null = null;
    let timer = 0;
    const canvas = document.createElement('canvas');
    canvas.className = 'cn-reveal-mask';
    const extend = mode === 'construct' ? 14 : 0;
    // The colours are read once: reading the computed style on every cell of
    // every step is what made the entrances stutter.
    const style = getComputedStyle(host);
    const colors = new Map<string, string>();
    const color = (name: string) => {
      let value = colors.get(name);
      if (value === undefined) {
        value = style.getPropertyValue(name).trim() || '#000';
        colors.set(name, value);
      }
      return value;
    };
    const paint = mode === 'construct' ? construct : asciiPaint();
    const start = () => {
      const w = host.offsetWidth;
      const h = host.offsetHeight;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = (w + 2 * extend) * ratio;
      canvas.height = (h + 2 * extend) * ratio;
      canvas.style.left = `${String(-extend)}px`;
      canvas.style.top = `${String(-extend)}px`;
      canvas.style.width = `${String(w + 2 * extend)}px`;
      canvas.style.height = `${String(h + 2 * extend)}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(ratio, ratio);
      const [n, ms] = mode === 'construct' ? [12, TEMPO.step] : [14, TEMPO.tick];
      cancel = steps(
        n,
        ms,
        (p) => {
          ctx.clearRect(0, 0, w + 2 * extend, h + 2 * extend);
          paint(ctx, p, { x: extend, y: extend, w, h }, color);
        },
        () => {
          canvas.remove();
        },
      );
    };
    // Covered from the start (one ground pixel, stretched by the CSS), so the
    // block never shows before its entrance.
    canvas.width = 1;
    canvas.height = 1;
    const cover = canvas.getContext('2d');
    if (cover) {
      cover.fillStyle = color('--ground');
      cover.fillRect(0, 0, 1, 1);
    }
    host.appendChild(canvas);
    const stop = once(host, () => {
      timer = window.setTimeout(start, delay);
    });
    return () => {
      stop();
      window.clearTimeout(timer);
      cancel?.();
      canvas.remove();
    };
  }, []);
  return (
    <div ref={ref} class={cls ? `cn-reveal ${cls}` : 'cn-reveal'}>
      {children}
    </div>
  );
}

/** A tick every `ms` while mounted; still under reduced motion. */
function useTick(ms: number): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (reducedMotion()) return;
    const timer = window.setInterval(() => {
      setFrame((f) => f + 1);
    }, ms);
    return () => {
      window.clearInterval(timer);
    };
  }, [ms]);
  return frame;
}

/**
 * Progress: cells, ascii or a spinner. Without a value it is indeterminate:
 * a window of three cells sweeps left to right.
 */
export function Progress({
  value = null,
  variant = 'cells',
  cells = 12,
  label,
}: {
  value?: number | null;
  variant?: 'cells' | 'ascii' | 'spinner';
  cells?: number;
  label?: string;
}) {
  const frame = useTick(variant === 'spinner' ? 110 : TEMPO.frame);
  const on = (i: number) => {
    if (value === null) {
      const head = frame % (cells + 3);
      return i >= head - 3 && i < head;
    }
    return i < Math.round(value * cells);
  };
  return (
    <span class={`cn-progress cn-progress--${variant}`} role="progressbar" aria-label={label}>
      {label && <span class="cn-progress__label">{label}</span>}
      {variant === 'spinner' ? (
        <span class="cn-progress__bar">{'|/-\\'[frame % 4]}</span>
      ) : variant === 'ascii' ? (
        <span class="cn-progress__bar">
          [{Array.from({ length: cells }, (_, i) => (on(i) ? '#' : '.')).join('')}]
        </span>
      ) : (
        <span class="cn-progress__bar">
          {Array.from({ length: cells }, (_, i) => (
            <i key={i} class={on(i) ? 'on' : undefined} />
          ))}
        </span>
      )}
    </span>
  );
}

/** Counter: a number that counts from its last value to the new one in 16 steps. */
export function Counter({ value, format }: { value: number; format: (value: number) => string }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = from.current;
    const stop = steps(
      16,
      TEMPO.tick,
      (p) => {
        setShown(start + (value - start) * p);
      },
      () => {
        from.current = value;
      },
    );
    return () => {
      stop();
      from.current = value;
    };
  }, [value]);
  return <span class="cn-counter">{format(shown)}</span>;
}
