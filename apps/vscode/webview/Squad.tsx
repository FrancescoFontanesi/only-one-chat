// The Squad panel (ADR 0016): over the chat, veiled in 1-bit, as one Lattice
// with no gaps: the bar, the board's head and port, the activity's tabs and
// list, the selected role's head and fields, what waits for you, the foot;
// shared lines, a + at each junction. The agents are panels framed by their
// vertices on a board that can be moved and zoomed, linked by what passes
// between them (today the backend's two roles; the board takes more). Data
// from the host's stores; settings written as the roles view did.

import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  MonitorAgent,
  MonitorState,
  RoleInfo,
  RoleName,
  RolesState,
  SessionInfo,
} from '../src/webview/protocol.js';
import { Board } from './board.js';
import { Crossed, Lattice } from './lattice.js';
import { Decode, flash, Progress, Reveal } from './motion.js';
import type { ThreadItem } from './state.js';
import { clock, kilo, Meter, PERMISSIONS, PROVIDER, ROLE, RoleEditor } from './ui.js';

const STATE_TAG = { working: 'LAVORA', waiting: '▲ ASPETTA TE', idle: '○ FERMO' } as const;
const LEVEL = { info: '■', warn: '▲', error: '×' } as const;
const INDEX: Record<RoleName, string> = { leader: 'A', implementer: 'B' };

type Tab = 'events' | 'waiting' | 'changes';
type Waiting = Extract<ThreadItem, { kind: 'permission' | 'approval' }>;

function agentOf(monitor: MonitorState, role: RoleName): MonitorAgent | undefined {
  return monitor.agents.find((a) => a.role === role);
}

function percent(agent: MonitorAgent | undefined): number | null {
  const context = agent?.context;
  return context?.window ? context.used / context.window : null;
}

/**
 * An agent: a panel framed by its vertices whose head selects it; model, how
 * it is set, its context, what it does.
 */
function Agent({
  role,
  info,
  agent,
  selected,
  locked,
  select,
}: {
  role: RoleName;
  info: RoleInfo | undefined;
  agent: MonitorAgent | undefined;
  selected: boolean;
  locked: boolean;
  select: () => void;
}) {
  const value = percent(agent);
  const status = agent?.status ?? 'idle';
  return (
    <Crossed class={selected ? 'sq-agent sq-agent--on' : 'sq-agent'}>
      <section class="sq-agent__in" aria-label={ROLE[role]} onClick={select}>
        <button class="xf__h sq-agent__h" type="button" aria-pressed={selected} onClick={select}>
          <span class="cn-tag">
            <b class={selected ? 'cn-frame__idx cn-accent' : 'cn-frame__idx'}>{INDEX[role]}</b>{' '}
            {ROLE[role]}
          </span>
          <span
            class={
              status === 'working'
                ? 'cn-tag cn-tag--live cn-tag--ink'
                : status === 'waiting'
                  ? 'cn-tag cn-tag--ink'
                  : 'cn-tag'
            }
          >
            {STATE_TAG[status]}
          </span>
        </button>
        <div class="xf__b sq-agent__b">
          <Decode initial class="sq-agent__m" text={info?.modelName ?? '—'} />
          <span class="t-data mut">
            {info
              ? [
                  PROVIDER[info.cli],
                  info.effort || 'nessun reasoning',
                  PERMISSIONS.find((p) => p.value === info.permission)?.short ?? '',
                  ...(locked ? ['bloccato'] : []),
                ].join(' · ')
              : 'ruolo non letto'}
          </span>
          <dl class="cn-spec sq-agent__s">
            <dt>Contesto</dt>
            <dd>
              {value !== null ? (
                <>
                  <Meter value={value} />
                  <span class="t-data">{Math.round(value * 100)}%</span>
                </>
              ) : (
                <span class="t-data mut">—</span>
              )}
            </dd>
            <dt>Ora</dt>
            <dd>
              <span class={status === 'working' ? 't-data cn-cursor sq-agent__a' : 't-data mut'}>
                {agent?.activity ?? (status === 'working' ? 'in corso' : 'niente')}
              </span>
            </dd>
            {agent && agent.subagents.length > 0 && (
              <>
                <dt>Sotto-agenti</dt>
                <dd class="sq-agent__subs">
                  {agent.subagents.map((label, index) => (
                    <span key={index} class="t-data">
                      └ {label} <Progress variant="spinner" />
                    </span>
                  ))}
                </dd>
              </>
            )}
          </dl>
        </div>
        <footer class="xf__f">
          <span class="cn-tag">
            {agent?.context ? `${kilo(agent.context.used)} token` : '— token'}
          </span>
        </footer>
      </section>
    </Crossed>
  );
}

/**
 * What waits for you, as a cell of the panel: inverted (the view's one
 * accent) when something waits, and it flashes when it comes; plain when not.
 */
function Alert({
  waiting,
  theme,
  go,
}: {
  waiting: readonly Waiting[];
  theme: string;
  go: (id: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const first = waiting[0];
  useEffect(() => {
    if (first && ref.current) flash(ref.current);
  }, [first?.id]);
  if (!first) {
    return (
      <section class="cn-cell sq-alert" aria-live="polite">
        <span class="cn-tag">○ Niente aspetta te</span>
        <p class="hint">Permessi, deleghe e rapporti da approvare compaiono qui.</p>
      </section>
    );
  }
  return (
    <section
      ref={ref}
      class="cn-cell cn-accent sq-alert"
      data-theme={theme === 'dark' ? 'light' : 'dark'}
      aria-live="polite"
    >
      <span class="cn-tag">
        <b>▲</b> Aspetta te{waiting.length > 1 ? ` · ${String(waiting.length)}` : ''}
      </span>
      <h3 class="t-title">
        {first.kind === 'permission'
          ? `Permesso · ${ROLE[first.role]}`
          : `${first.approval === 'delegation' ? 'Delega' : 'Rapporto'} da approvare`}
      </h3>
      <p class="t-data mut">
        {first.kind === 'permission' ? first.summary : `${first.from} → ${first.to}`}
      </p>
      <div class="sq-alert__a">
        <button
          class="cn-btn cn-btn--sm"
          type="button"
          onClick={() => {
            go(first.id);
          }}
        >
          <span class="cn-btn__label">Rispondi</span>
          <span class="cn-btn__icon">→</span>
        </button>
      </div>
    </section>
  );
}

export function Squad({
  session,
  roles,
  monitor,
  items,
  theme,
  close,
  go,
}: {
  session: SessionInfo | undefined;
  roles: RolesState | undefined;
  monitor: MonitorState;
  items: readonly ThreadItem[];
  theme: 'dark' | 'light';
  close: () => void;
  /** Closes the panel and shows an item of the thread. */
  go: (id: string) => void;
}) {
  const [selected, setSelected] = useState<RoleName>('leader');
  const [tab, setTab] = useState<Tab>('events');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [close]);

  // The chat's own roles once it has run, else those of the next chat.
  const shown = (role: RoleName): RoleInfo | undefined => roles?.chat?.[role] ?? roles?.roles[role];
  const started = roles?.chat !== null && roles?.chat !== undefined;
  const waiting = items.filter(
    (i): i is Waiting => (i.kind === 'permission' || i.kind === 'approval') && !i.closed,
  );
  const changes = items.filter(
    (i): i is Extract<ThreadItem, { kind: 'changes' }> => i.kind === 'changes',
  );
  const open = changes.flatMap((c) =>
    c.files.filter((f) => !c.decisions[f.path]).map((f) => ({ card: c, file: f })),
  );
  const working = monitor.agents.filter((a) => a.status === 'working');
  const agentStatus = (role: RoleName) => agentOf(monitor, role)?.status ?? 'idle';
  const waitingFor = (approval: 'delegation' | 'report') =>
    waiting.some((w) => w.kind === 'approval' && w.approval === approval);
  const agentBlock = (role: RoleName, x: number) => ({
    id: role,
    x,
    y: 0,
    width: 340,
    children: (
      <Reveal delay={role === 'leader' ? 0 : 150}>
        <Agent
          role={role}
          info={shown(role)}
          agent={agentOf(monitor, role)}
          selected={selected === role}
          locked={role === 'leader' && started}
          select={() => {
            setSelected(role);
          }}
        />
      </Reveal>
    ),
  });
  const tabs = [
    ['events', 'Eventi', monitor.events.length],
    ['waiting', 'In attesa', waiting.length],
    ['changes', 'Modifiche', open.length],
  ] as const;

  return (
    <div class="stage stage--layer" data-theme={theme}>
      <div class="veil veil--mezzatinta" onClick={close} />
      <Lattice class="sqw" edges={{ top: true, bottom: true, left: true, right: true }} dense={40}>
        <header class="cn-cell cn-cell--row sq-bar" role="dialog" aria-label="Pannello Squad">
          <span class="lt-mark">Squad</span>
          <span class="crumb">
            Chat / <b>{session?.title || 'Nuova chat'}</b>
          </span>
          <div class="sq-bar__end">
            {roles?.fake && <span class="cn-tag cn-tag--ink">▲ CLI finti</span>}
            <span class="cn-tag">
              Deleghe · <b>{session?.mode === 'auto' ? 'automatiche' : 'approvo io'}</b>
            </span>
            <button class="cn-btn cn-btn--outline cn-btn--sm" type="button" onClick={close}>
              <span class="cn-btn__label">Chiudi · Esc</span>
              <span class="cn-btn__icon">×</span>
            </button>
          </div>
        </header>

        <Board
          label="Lavagna degli agenti"
          blocks={[agentBlock('leader', 0), agentBlock('implementer', 500)]}
          links={[
            {
              id: 'delegation',
              from: 'leader',
              to: 'implementer',
              label: waitingFor('delegation') ? '▲ Delega' : 'Delega',
              lane: -16,
              live: agentStatus('implementer') === 'working',
              waiting: waitingFor('delegation'),
            },
            {
              id: 'report',
              from: 'implementer',
              to: 'leader',
              label: waitingFor('report') ? '▲ Rapporto' : 'Rapporto',
              lane: 16,
              waiting: waitingFor('report'),
            },
          ]}
          legend={
            <>
              <span class="cn-tag">
                <b>01/</b> Lavagna
              </span>
            </>
          }
        />

        <header class="cn-cell cn-cell--row sq-acth">
          <span class="sq-tabs" role="tablist">
            {tabs.map(([id, label, count], index) => (
              <button
                key={id}
                class="sq-tab"
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => {
                  setTab(id);
                }}
              >
                <span class={tab === id ? 'cn-frame__idx cn-accent' : 'cn-frame__idx'}>
                  0{index + 2}
                </span>
                {label}
                {count > 0 && <b>{count}</b>}
              </button>
            ))}
          </span>
        </header>
        <div class="cn-cell sq-actb" role="tabpanel">
          {tab === 'events' && (
            <ol class="log">
              <li>
                <span>{clock(Date.now())}</span>
                <span class="cn-cursor">
                  {working.length > 0
                    ? `${working.map((a) => ROLE[a.role]).join(' e ')} al lavoro`
                    : 'In ascolto'}
                </span>
                <span class="mut">{working.length > 0 ? '▶' : '○'}</span>
              </li>
              {monitor.events.map((event, index) => (
                <li key={`${String(event.at)}-${String(index)}`}>
                  <span>{clock(event.at)}</span>
                  <span>{event.text}</span>
                  <span>{LEVEL[event.level]}</span>
                </li>
              ))}
            </ol>
          )}
          {tab === 'waiting' &&
            (waiting.length === 0 ? (
              <p class="hint">Nessuna richiesta aperta.</p>
            ) : (
              <div class="ilist">
                {waiting.map((i) => (
                  <div key={i.id}>
                    <span>
                      {i.kind === 'permission'
                        ? `▲ Permesso · ${ROLE[i.role].toLowerCase()} · ${i.summary}`
                        : `▲ ${i.approval === 'delegation' ? 'Delega' : 'Rapporto'} da approvare · ${i.from} → ${i.to}`}
                    </span>
                    <button
                      class="cn-btn cn-btn--text"
                      type="button"
                      onClick={() => {
                        go(i.id);
                      }}
                    >
                      <span class="cn-btn__label">VAI ↗</span>
                    </button>
                  </div>
                ))}
              </div>
            ))}
          {tab === 'changes' &&
            (changes.length === 0 ? (
              <p class="hint">Nessuna modifica in questa chat.</p>
            ) : (
              <div class="ilist">
                {changes.flatMap((card) =>
                  card.files.map((file) => (
                    <div key={`${card.id}-${file.path}`}>
                      <span>{file.path}</span>
                      <span>
                        {card.decisions[file.path] === 'accepted'
                          ? '■ ACCETTATO'
                          : card.decisions[file.path] === 'rejected'
                            ? '× RIFIUTATO'
                            : file.binary
                              ? 'BINARIO'
                              : `+${String(file.added)} −${String(file.removed)}`}
                      </span>
                    </div>
                  )),
                )}
                {open[0] && (
                  <div>
                    <span class="mut">{open.length} da rivedere</span>
                    <button
                      class="cn-btn cn-btn--text"
                      type="button"
                      onClick={() => {
                        if (open[0]) go(open[0].card.id);
                      }}
                    >
                      <span class="cn-btn__label">RIVEDI ↗</span>
                    </button>
                  </div>
                )}
              </div>
            ))}
        </div>

        <header class="cn-cell cn-cell--row sq-roleh" aria-label="Ruolo selezionato">
          <span class="cn-tag">
            <b>{INDEX[selected]}/</b> {ROLE[selected]}
          </span>
          <span class="cn-tag">{started ? 'Di questa chat' : 'Prossima chat'}</span>
        </header>
        <div class="cn-cell sq-roleb">
          {roles ? (
            <RoleEditor role={selected} roles={roles} />
          ) : (
            <p class="hint">Lettura dei ruoli…</p>
          )}
        </div>

        <Alert waiting={waiting} theme={theme} go={go} />

        <footer class="cn-cell cn-cell--row sq-foot">
          <span class="cn-tag">Trascina la lavagna · rotella per lo zoom</span>
        </footer>
      </Lattice>
    </div>
  );
}
