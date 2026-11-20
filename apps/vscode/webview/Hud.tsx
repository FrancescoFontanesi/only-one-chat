// The two dials beside the composer (ADR 0016; the "Pannelli laterali"
// canvas, v5, as a reference), working on the backend as it is. Each is
// 216 × 192, joined to the composer by a dashed connector and a chevron at the
// middle of its edge. Every control is in view; nothing opens on hover and
// nothing loops: a dial turns, an arc fills and a name settles only when what
// it shows changes.
//
// On the left, who you talk to: the dial's marks are the roles, chosen on
// their label (LDR, IMP) or on the outer ring. The sight sets the reasoning:
// drag or click a segment, wheel, arrows; its reading sits above the middle
// line. For the leader how its delegations are delivered, automatic or manual
// (ADR 0018; its model stays the chat's); for the implementer its model (↕ to the next one, in the same session) and HANDOFF:
// a new session of the same model that starts from a handoff of this one (ADR
// 0017). On the right each provider's usage: the 5-hour window as a solid arc
// and its number (or why there is none), the weekly one dashed and in cells,
// the renewal when it is known.

import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  Cli,
  ApprovalMode,
  MonitorState,
  NodeInfo,
  PermissionLevel,
  ProviderUsage,
  RolesState,
  TurnRole,
} from '../src/webview/protocol.js';
import {
  bezel,
  dial,
  ends,
  gauge,
  GAUGE,
  HUD,
  label,
  marks,
  R,
  type Side,
  steps,
} from './hudGeometry.js';
import { Counter, Decode, reducedMotion } from './motion.js';
import {
  clock,
  editableRole,
  PERMISSIONS,
  post,
  PROVIDER,
  writeNode,
  writeRole,
  type RoleChange,
} from './ui.js';

/** The pace the dials were drawn for: `rate` is how far a value moves in one of these frames. */
const FPS = 24;

/**
 * A value that eases toward `target` on every frame of the display, only
 * while it is on its way; at once under reduced motion. `rate` sets the pace
 * (a unit takes about 1/rate frames at 24 fps, as before), the arrival slows
 * down. `hold` shows a value given from outside (a drag) and starts the next
 * move from there.
 */
function useTween(target: number, rate: number, hold: number | null = null): number {
  const current = useRef(target);
  const [value, setValue] = useState(target);
  useEffect(() => {
    if (hold !== null) {
      current.current = hold;
      return;
    }
    if (reducedMotion() || current.current === target) {
      current.current = target;
      setValue(target);
      return;
    }
    // Time constant of the easing: 95% of the way in about the old linear time.
    const tau = 1000 / (rate * FPS) / 3;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const d = target - current.current;
      current.current =
        Math.abs(d) < 1e-3 ? target : current.current + d * (1 - Math.exp(-(now - last) / tau));
      last = now;
      setValue(current.current);
      if (current.current !== target) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [target, hold]);
  return hold ?? value;
}

/** Turning a dial by dragging over it, the wheel or the arrows. */
function useDial(count: number, selected: number, go: (index: number) => void) {
  const drag = useRef<{ y: number; from: number } | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const wheelAt = useRef(0);
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  return {
    dragged,
    handlers: {
      onPointerDown: (event: PointerEvent) => {
        (event.currentTarget as Element).setPointerCapture(event.pointerId);
        drag.current = { y: event.clientY, from: selected };
        setDragged(selected);
      },
      onPointerMove: (event: PointerEvent) => {
        if (!drag.current) return;
        const v = drag.current.from + (drag.current.y - event.clientY) / 36;
        setDragged(Math.max(-0.4, Math.min(count - 0.6, v)));
      },
      onPointerUp: () => {
        if (!drag.current) return;
        drag.current = null;
        if (dragged !== null) go(clamp(Math.round(dragged)));
        setDragged(null);
      },
      onWheel: (event: WheelEvent) => {
        event.preventDefault();
        const now = Date.now();
        if (now - wheelAt.current < 160) return;
        wheelAt.current = now;
        go(clamp(selected + (event.deltaY > 0 ? 1 : -1)));
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === 'ArrowDown') go(clamp(selected + 1));
        else if (event.key === 'ArrowUp') go(clamp(selected - 1));
        else return;
        event.preventDefault();
      },
    },
  };
}

/** The bezel and the fixed marks never move: drawn once per side. */
const BEZEL = { left: bezel('left', 0), right: bezel('right', 0) } as const;
const MARKS = { left: marks('left'), right: marks('right') } as const;

/** The dial and the still bezel of one side, with the fixed marks. */
function Instrument({
  side,
  rot,
  count,
  children,
}: {
  side: Side;
  rot: number;
  count: number;
  children?: ComponentChildren;
}) {
  const d = useMemo(() => dial(side, rot, count), [side, rot, count]);
  const b = BEZEL[side];
  const m = MARKS[side];
  return (
    <svg
      class="hud__svg"
      width={HUD.width}
      height={HUD.height}
      viewBox={`0 0 ${String(HUD.width)} ${String(HUD.height)}`}
      aria-hidden="true"
    >
      <path class="hud__dash" d={m.connector} />
      <path class="hud__ink" d={m.chevron} />
      {children}
      <path class="hud__strong" d={d.base} />
      <path class="hud__strong" d={d.minor} />
      <path class="hud__ink" d={d.major} />
      <path class="hud__line" d={b.minor} />
      <path class="hud__strong" d={b.major} />
      <path class="hud__ink" d={m.bracket} />
      <path class="hud__strong" d={m.focus} />
    </svg>
  );
}

/** The labels on a dial, every one that is on its visible part, each a button. */
function Labels({
  side,
  items,
  rot,
  selected,
  pick,
}: {
  side: Side;
  items: readonly { id: string; short: string; name: string }[];
  rot: number;
  selected: number;
  pick: (index: number) => void;
}) {
  return (
    <>
      {items.map((item, index) => {
        const at = label(side, index, rot);
        return (
          <button
            key={item.id}
            class={index === selected ? 'hud__lbl is-on' : 'hud__lbl'}
            type="button"
            aria-label={item.name}
            aria-pressed={index === selected}
            style={{
              ...(side === 'left'
                ? { right: `${(HUD.width - at.x + 2).toFixed(1)}px` }
                : { left: `${(at.x + 2).toFixed(1)}px` }),
              top: `${(at.y - 7).toFixed(1)}px`,
              visibility: at.visible ? 'visible' : 'hidden',
            }}
            onClick={() => {
              pick(index);
            }}
          >
            {item.short}
          </button>
        );
      })}
    </>
  );
}

const ROLES = [
  { id: 'leader', name: 'Leader', short: 'LDR' },
  { id: 'implementer', name: 'Implementer', short: 'IMP' },
  { id: 'reviewer', name: 'Reviewer', short: 'REV' },
] as const;

/** The reviewer on or off (ADR 0033): the setting, for the chat open and the next. */
const REVIEWER_ON: readonly { value: 'on' | 'off'; label: string; title: string }[] = [
  { value: 'on', label: 'On', title: 'Reviews all implementer work' },
  { value: 'off', label: 'Off', title: 'The leader reads the implementer’s report directly' },
];

const EFFORT_SHORT: Record<string, string> = {
  minimal: 'MIN',
  low: 'LOW',
  medium: 'MED',
  high: 'HIGH',
  xhigh: 'XHI',
  max: 'MAX',
  ultra: 'ULTRA',
};

/**
 * Choices side by side under their key: the chosen one bright, the others dim;
 * a click on another chooses it, the wheel or the arrows move to the next.
 */
function Switch<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; title: string }[];
  onChange: (value: T) => void;
}) {
  const other = (step = 1) => {
    const at = options.findIndex((o) => o.value === value);
    const next = options[(at + step + options.length) % options.length];
    if (next && next.value !== value) onChange(next.value);
  };
  return (
    <div
      class="sw"
      role="radiogroup"
      tabIndex={0}
      aria-label={label}
      onWheel={(event: WheelEvent) => {
        event.preventDefault();
        other(event.deltaY > 0 ? 1 : -1);
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        other(event.key === 'ArrowDown' ? 1 : -1);
      }}
    >
      <span class="hud__k">{label}</span>
      <span class="sw__opts">
        {options.map((o) => (
          <button
            key={o.value}
            class={o.value === value ? 'sw__o sw__o--on' : 'sw__o'}
            type="button"
            role="radio"
            tabIndex={-1}
            aria-checked={o.value === value}
            title={o.title}
            onClick={() => {
              if (o.value !== value) onChange(o.value);
            }}
          >
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/** How the leader's delegations reach the implementer (ADR 0018). */
const DELIVERY: readonly { value: ApprovalMode; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Send the brief to the implementer immediately' },
  {
    value: 'manual',
    label: 'Manual',
    title: 'Edit the brief before sending. The chat waits until you send or cancel it.',
  },
];

/**
 * The implementer's permissions (ADR 0021), as Claude Code calls its modes:
 * read only, ask before acting, auto (Claude Code's own auto mode). From its next turn.
 */
const PERMISSION_TITLE: Record<PermissionLevel, string> = {
  'read-only': 'Can read and search files',
  ask: 'Asks before making changes or running commands',
  auto: 'Works in the folder without asking. Claude Code uses its own auto mode.',
};
const PERMISSION_OPTIONS = PERMISSIONS.map((p) => ({
  value: p.value,
  label: p.short,
  title: PERMISSION_TITLE[p.value],
}));

/** The reasoning step under a point of the sight: its segments run from the bottom up. */
function stepAt(y: number, count: number): number {
  const s = Math.max(-1, Math.min(1, (y - HUD.cy) / R.outer));
  const deg = (Math.asin(s) * 180) / Math.PI;
  const span = (2 * GAUGE) / Math.max(1, count);
  return Math.max(0, Math.min(count - 1, Math.floor((GAUGE - deg) / span)));
}

/**
 * Who you talk to; its reasoning on the sight, and the leader's delivery or the
 * implementer's model and handoff. The sight sets the reasoning (drag, click
 * on a segment, wheel, arrows); the agent is chosen on its label or on the
 * outer ring (click, wheel): the two roles, then the nodes (ADR 0023), which
 * have only their model and reasoning here.
 */
export function RoleHud({
  roles,
  monitor,
  to,
  node,
  removedNodes,
  select,
  mode,
  setMode,
  busy,
}: {
  roles: RolesState | undefined;
  monitor: MonitorState;
  to: TurnRole;
  /** The node the chat shows, if any: the dial is its. */
  node: NodeInfo | null;
  /** Nodes of this chat off the board: on the ring too, their threads read only. */
  removedNodes: readonly { readonly id: string; readonly name: string }[];
  /** Chooses who you talk to: a role, or a node by id. */
  select: (target: string) => void;
  /** How the leader's delegations are delivered. */
  mode: ApprovalMode;
  setMode: (mode: ApprovalMode) => void;
  /** A message of who is shown is running: no handoff now. */
  busy: boolean;
}) {
  // Two choices (ADR 0028). The label at the top picks the group or the node alone: the pair of
  // the leader and the implementer, then each node (those off the board, read only, last). The
  // ring picks the role inside the group; a node alone has no roles, so its ring is empty.
  const groups = [
    { id: 'team', name: roles?.team.name ?? 'Team' },
    ...[...(roles?.nodes ?? []), ...removedNodes].map((n) => ({ id: n.id, name: n.name })),
  ];
  const at = Math.max(
    0,
    groups.findIndex((g) => g.id === node?.id),
  );
  const cycle = (step: number) => {
    const next = groups[(at + step + groups.length) % groups.length];
    if (next) select(next.id === 'team' ? to : next.id);
  };
  const ring = node ? [] : ROLES;
  const selected = Math.max(
    0,
    ring.findIndex((role) => role.id === to),
  );
  const go = (index: number) => {
    const role = ring[(index + ring.length) % ring.length];
    if (role) select(role.id);
  };
  const rot = useTween(selected, 1 / 8);

  const reviewer = to === 'reviewer' && !node ? roles?.reviewer : undefined;
  const edit = roles && !node && to !== 'reviewer' ? editableRole(to, roles) : null;
  const info = node ?? reviewer ?? edit?.info;
  /** A node's settings go to its entry, the reviewer's to its keys, a role's to its keys. */
  const write = (change: RoleChange) => {
    if (node) writeNode(node, change);
    else if (reviewer) {
      post({
        type: 'setReviewer',
        cli: change.cli ?? reviewer.cli,
        model: change.model ?? reviewer.model,
        effort: change.effort ?? reviewer.effort,
      });
    } else if (info && to !== 'reviewer') writeRole(to, info, change);
  };
  const provider = roles?.catalog.find((c) => c.cli === info?.cli);
  const model = provider?.models.find((m) => m.id === info?.model);
  const efforts: readonly string[] = model?.efforts ?? [];
  const effort = info ? efforts.indexOf(info.effort) : -1;
  // While the sight is dragged, the step under the pointer; written on release.
  const [pending, setPending] = useState<number | null>(null);
  const dragging = useRef(false);
  const shownStep = pending ?? effort;
  const ra = useTween(shownStep + 1, 1 / 6);
  const rsn = steps('left', R.outer, Math.max(1, efforts.length), ra);
  const setStep = (index: number) => {
    const level = efforts[Math.max(0, Math.min(efforts.length - 1, index))];
    if (info && level && level !== info.effort) write({ effort: level });
  };
  // In the dial's own units: the dock draws the dials smaller (CSS zoom).
  const local = (event: PointerEvent | MouseEvent) => {
    const element = event.currentTarget as HTMLElement;
    const box = element.getBoundingClientRect();
    return (event.clientY - box.top) * (element.offsetHeight / (box.height || 1));
  };
  const wheelAt = useRef(0);
  const throttled = (fn: () => void) => {
    const now = Date.now();
    if (now - wheelAt.current < 160) return;
    wheelAt.current = now;
    fn();
  };

  const status = node
    ? busy
      ? 'working'
      : 'idle'
    : (monitor.agents.find((a) => a.role === to)?.status ?? 'idle');
  const models = provider?.models ?? [];
  const isLeader = to === 'leader' && !node;
  const canModel = !isLeader && info !== undefined && models.length > 1;
  const nextModel = () => {
    if (!info || !canModel) return;
    const at = models.findIndex((m) => m.id === info.model);
    const next = models[(at + 1) % models.length];
    if (!next) return;
    const keep = next.efforts.includes(info.effort) ? info.effort : (next.efforts[0] ?? '');
    write({ model: next.id, effort: keep });
  };
  const started = roles?.chat !== null && roles?.chat !== undefined;
  const current = node
    ? { name: node.name }
    : { name: ROLES.find((role) => role.id === to)?.name ?? '' };
  const level = efforts[shownStep];

  return (
    <div class="hud hud--left">
      <Instrument side="left" rot={rot} count={Math.max(1, ring.length)}>
        <path class="hud__dots" d={gauge('left', R.inner, 1)} />
        <path class="hud__strong" d={rsn.off} />
        <path class="hud__ink hud__w3" d={rsn.on} />
        <path class="hud__ink" d={ends('left')} />
      </Instrument>
      <div
        class="hud__ring"
        aria-hidden="true"
        title="Change role"
        onClick={() => {
          go(selected + 1);
        }}
        onWheel={(event: WheelEvent) => {
          event.preventDefault();
          throttled(() => {
            go(selected + (event.deltaY > 0 ? 1 : -1));
          });
        }}
      />
      <div
        class="hud__turn hud__turn--left"
        role="slider"
        tabIndex={efforts.length > 0 ? 0 : -1}
        aria-label={`Reasoning: ${current.name}`}
        aria-valuemin={1}
        aria-valuemax={Math.max(1, efforts.length)}
        aria-valuenow={shownStep + 1}
        aria-valuetext={level ?? 'none'}
        onPointerDown={(event: PointerEvent) => {
          if (efforts.length === 0) return;
          (event.currentTarget as Element).setPointerCapture(event.pointerId);
          dragging.current = true;
          setPending(stepAt(local(event), efforts.length));
        }}
        onPointerMove={(event: PointerEvent) => {
          if (dragging.current) setPending(stepAt(local(event), efforts.length));
        }}
        onPointerUp={() => {
          if (!dragging.current) return;
          dragging.current = false;
          if (pending !== null) setStep(pending);
          setPending(null);
        }}
        onWheel={(event: WheelEvent) => {
          event.preventDefault();
          throttled(() => {
            setStep(effort + (event.deltaY < 0 ? 1 : -1));
          });
        }}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key === 'ArrowUp') setStep(effort + 1);
          else if (event.key === 'ArrowDown') setStep(effort - 1);
          else return;
          event.preventDefault();
        }}
      />
      <Labels side="left" items={ring} rot={rot} selected={selected} pick={go} />
      <button
        class="hud__grp"
        type="button"
        aria-label={`Team or node: ${node?.name ?? groups[0]?.name ?? ''}`}
        title={groups.length > 1 ? 'Click or scroll to switch teams or nodes' : 'Team'}
        disabled={groups.length < 2}
        onClick={() => {
          cycle(1);
        }}
        onWheel={(event: WheelEvent) => {
          event.preventDefault();
          throttled(() => {
            cycle(event.deltaY > 0 ? 1 : -1);
          });
        }}
      >
        <b>R/</b>
        <Decode text={node?.name ?? groups[0]?.name ?? ''} />
        <span aria-hidden="true">{groups.length > 1 ? '↕' : '■'}</span>
      </button>
      <span class="hud__meta hud__meta--left">
        {info ? PROVIDER[info.cli] : '—'}
        {status === 'working' ? ' · ▶ Working' : status === 'waiting' ? ' · ▲ Waiting' : ''}
      </span>
      <Decode class="hud__big hud__big--left" text={current.name} />
      <span class="hud__read">
        <span class="hud__k">RSN</span>
        <Decode text={level ? (EFFORT_SHORT[level] ?? level.toUpperCase()) : '—'} />
        {efforts.length > 0 && (
          <span class="hud__k">
            {String(shownStep + 1)}/{String(efforts.length)}
          </span>
        )}
      </span>
      <button
        class="hud__model"
        type="button"
        aria-label={canModel ? 'Next model' : 'Model'}
        title={
          isLeader
            ? 'The leader’s model stays fixed for this chat'
            : canModel
              ? 'Switch to the next model in this session'
              : 'No other models from this provider'
        }
        disabled={!canModel}
        onClick={nextModel}
      >
        <Decode text={info?.modelName ?? '—'} />
        <span aria-hidden="true">{canModel ? '↕' : '■'}</span>
      </button>
      <div class="hud__act">
        {node ? (
          // A node has no role: no delivery, permissions or handoff here (Squad sets them).
          <span class="hud__k">Standalone node</span>
        ) : isLeader ? (
          <Switch label="Delivery" value={mode} options={DELIVERY} onChange={setMode} />
        ) : reviewer ? (
          <Switch
            label="Review"
            value={reviewer.enabled ? 'on' : 'off'}
            options={REVIEWER_ON}
            onChange={(value) => {
              post({ type: 'setReviewerOn', enabled: value === 'on' });
            }}
          />
        ) : (
          <>
            {info && (
              <Switch
                label="Permissions"
                value={info.permission}
                options={PERMISSION_OPTIONS}
                onChange={(permission) => {
                  write({ permission });
                }}
              />
            )}
            <button
              class="cn-btn cn-btn--outline cn-btn--sm hud__handoff"
              type="button"
              disabled={busy || !started}
              title={
                !started
                  ? 'The implementer will start a new session when the chat begins'
                  : busy
                    ? 'Handoff is available after the current turn'
                    : 'Start a new session with the same model and a handoff from this one'
              }
              onClick={() => {
                post({ type: 'handoff' });
              }}
            >
              <span class="cn-btn__label">Handoff</span>
              <span class="cn-btn__icon" aria-hidden="true">
                →
              </span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const PROVIDERS = [
  { id: 'codex', name: 'Codex', short: 'CDX' },
  { id: 'claude', name: 'Claude', short: 'CLD' },
  { id: 'antigravity', name: 'Antigravity', short: 'AGY' },
] as const;

/** Why a provider's 5-hour window shows no number. */
const NO_WINDOW: Record<Cli, { word: string; note: string }> = {
  codex: { word: 'Unavailable', note: 'Codex usage has not been loaded yet.' },
  claude: { word: 'After a turn', note: 'Claude reports usage at the end of a turn.' },
  antigravity: {
    word: 'Unavailable',
    note: 'When a node uses Antigravity, agy reads /quota without using quota.',
  },
};

const windowOf = (usage: ProviderUsage | undefined, name: '5h' | 'weekly') =>
  usage?.windows.find((w) => w.name === name);

/** Each provider's usage: the 5-hour window as an arc and a number, the weekly one dashed. */
export function UsageHud({
  usage,
  threshold,
  active,
}: {
  usage: readonly ProviderUsage[];
  /** From which percentage a window is shown as over; 0 for none. */
  threshold: number;
  /** The provider of who you talk to: the one shown until you turn the dial. */
  active: Cli;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  useEffect(() => {
    setChosen(null);
  }, [active]);
  const selected =
    chosen ??
    Math.max(
      0,
      PROVIDERS.findIndex((p) => p.id === active),
    );
  const turn = useDial(PROVIDERS.length, selected, setChosen);
  const rot = useTween(selected, 1 / 8, turn.dragged);
  const cli = (PROVIDERS[selected] ?? PROVIDERS[0]).id;
  const data = usage.find((p) => p.provider === cli);
  const five = windowOf(data, '5h');
  const week = windowOf(data, 'weekly');
  // What is left, not what is used: the arcs empty as the windows fill.
  const left = (w: { usedPercent: number } | undefined) =>
    w ? Math.max(0, 100 - w.usedPercent) : 0;
  const v5 = useTween(left(five) / 100, 0.025);
  const v1 = useTween(left(week) / 100, 0.025);
  const over =
    threshold > 0 && [five, week].some((w) => w !== undefined && w.usedPercent >= threshold);
  const lit = week ? Math.round(left(week) / 10) : 0;

  return (
    <div class="hud hud--right">
      <Instrument side="right" rot={rot} count={PROVIDERS.length}>
        <path class="hud__dots" d={gauge('right', R.outer, 1)} />
        <path class="hud__dots" d={gauge('right', R.inner, 1)} />
        <path class="hud__ink hud__w3" d={gauge('right', R.outer, v5)} />
        <path class="hud__ink hud__w3 hud__dashed" d={gauge('right', R.inner, v1)} />
        <path class="hud__ink" d={ends('right')} />
      </Instrument>
      <div
        class="hud__turn hud__turn--right"
        role="slider"
        tabIndex={0}
        aria-label="Provider"
        aria-valuemin={1}
        aria-valuemax={PROVIDERS.length}
        aria-valuenow={selected + 1}
        aria-valuetext={`${PROVIDER[cli]}, 5H ${five ? `${String(Math.round(left(five)))}% left` : '—'}`}
        {...turn.handlers}
      />
      <Labels side="right" items={PROVIDERS} rot={rot} selected={selected} pick={setChosen} />
      <span class="cn-tag hud__key hud__key--right">
        <b>U/</b> Remaining
      </span>
      <span class="hud__meta hud__meta--right">
        {PROVIDER[cli]}
        {over ? ' ▲ Threshold' : ''}
      </span>
      {five ? (
        <span class="hud__fig" title={data?.note || undefined}>
          <span class="hud__k">5H</span>
          <span class="hud__num">
            <Counter value={Math.round(left(five))} format={(v) => String(Math.round(v))} />
            <small>%</small>
          </span>
        </span>
      ) : (
        <span class="hud__fig hud__fig--none" title={data?.note || NO_WINDOW[cli].note}>
          <span class="hud__k">5H</span>
          {/* A short word on the dial; the provider's whole note is its tooltip. */}
          <span class="hud__k hud__fit">{NO_WINDOW[cli].word}</span>
        </span>
      )}
      <div class="hud__ctl hud__ctl--right">
        {week && (
          <span class="hud__row">
            <span class="hud__k">1W</span>
            <span class="hud__cells">
              {Array.from({ length: 10 }, (_, k) => (
                <i key={k} class={k < lit ? 'is-on' : undefined} />
              ))}
            </span>
            <span>{String(Math.round(left(week)))}%</span>
          </span>
        )}
        {five?.resetsAt && <span class="hud__k">Resets at {clock(five.resetsAt * 1000)}</span>}
      </div>
    </div>
  );
}
