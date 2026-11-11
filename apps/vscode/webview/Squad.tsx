// The Squad panel (ADR 0016): over the chat, veiled in 1-bit, as one Lattice
// with no gaps: the bar, the board's head and port, the activity's tabs and
// list, the selected role's head and fields, what waits for you, the foot;
// shared lines, a + at each junction. The agents are panels framed by their
// vertices on a board that can be moved and zoomed, linked by what passes
// between them: the two roles, and the nodes added beside them (ADR 0023),
// each with its own thread and no link. Selecting an agent makes it the one
// the chat writes to. Data from the host's stores; settings written as the
// roles view did.

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  NODE_NAME_LENGTH,
  type MonitorAgent,
  type MonitorState,
  type NodeInfo,
  type RoleInfo,
  type RoleName,
  type RolesState,
  type SessionInfo,
} from '../src/webview/protocol.js';
import { Board } from './board.js';
import { Crossed, Lattice } from './lattice.js';
import { Decode, flash, Progress, Reveal } from './motion.js';
import type { ThreadItem } from './state.js';
import { waitingItems, type WaitingItem } from './threadModel.js';
import {
  clock,
  kilo,
  Meter,
  PERMISSIONS,
  post,
  PROVIDER,
  ROLE,
  RoleEditor,
  RoleFields,
  writeNode,
} from './ui.js';

const STATE_TAG = { working: 'LAVORA', waiting: '▲ ASPETTA TE', idle: '○ FERMO' } as const;
const LEVEL = { info: '■', warn: '▲', error: '×' } as const;
const INDEX: Record<RoleName, string> = { leader: 'A', implementer: 'B' };
/** A node's letter on the board: C, D, … after the two roles. */
const nodeIndex = (index: number) => String.fromCharCode(67 + (index % 24));
const isRole = (id: string): id is RoleName => id === 'leader' || id === 'implementer';

type Tab = 'events' | 'waiting' | 'changes';
type Waiting = WaitingItem;

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
  title,
  index,
  info,
  agent,
  status: own,
  selected,
  locked,
  select,
}: {
  title: string;
  index: string;
  info: RoleInfo | undefined;
  agent: MonitorAgent | undefined;
  /** A node's state, which the monitor does not follow. */
  status?: 'working' | 'waiting' | 'idle';
  selected: boolean;
  locked: boolean;
  select: () => void;
}) {
  const value = percent(agent);
  const status = agent?.status ?? own ?? 'idle';
  return (
    <Crossed class={selected ? 'sq-agent sq-agent--on' : 'sq-agent'}>
      <section class="sq-agent__in" aria-label={title} onClick={select}>
        <button class="xf__h sq-agent__h" type="button" aria-pressed={selected} onClick={select}>
          <span class="cn-tag">
            <b class={selected ? 'cn-frame__idx cn-accent' : 'cn-frame__idx'}>{index}</b> {title}
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
function waitingTitle(item: Waiting): string {
  if (item.kind === 'permission') return `Permesso · ${ROLE[item.role]}`;
  if (item.kind === 'question') return `Domanda · ${ROLE[item.role]}`;
  return `${item.approval === 'delegation' ? 'Delega' : 'Rapporto'} da approvare`;
}

function waitingDetail(item: Waiting): string {
  if (item.kind === 'permission') return item.summary;
  if (item.kind === 'question') return item.questions.map((q) => q.question).join(' · ');
  return `${item.from} → ${item.to}`;
}

/**
 * A request in the waiting list, answered from here (ADR 0021): a permission
 * with its three answers, a delegation sent or cancelled as written; a
 * question, or a delegation to edit, opens where it is in the chat.
 */
function WaitingRow({ item, go }: { item: Waiting; go: (id: string) => void }) {
  const open = (
    <button
      class="cn-btn cn-btn--text"
      type="button"
      onClick={() => {
        go(item.id);
      }}
    >
      <span class="cn-btn__label">{item.kind === 'question' ? 'RISPONDI ↗' : 'VAI ↗'}</span>
    </button>
  );
  const action = (label: string, run: () => void) => (
    <button class="cn-btn cn-btn--text" type="button" onClick={run}>
      <span class="cn-btn__label">{label}</span>
    </button>
  );
  return (
    <div>
      <span>
        ▲ {waitingTitle(item)} · {waitingDetail(item)}
      </span>
      <span class="wlist__a">
        {item.kind === 'permission' && (
          <>
            {action('CONSENTI', () => {
              post({ type: 'permit', id: item.id, decision: 'accept' });
            })}
            {action('PER LA SESSIONE', () => {
              post({ type: 'permit', id: item.id, decision: 'acceptForSession' });
            })}
            {action('RIFIUTA', () => {
              post({ type: 'permit', id: item.id, decision: 'decline' });
            })}
          </>
        )}
        {item.kind === 'approval' && (
          <>
            {action('INVIA', () => {
              post({ type: 'decide', id: item.id, action: 'approve' });
            })}
            {action('ANNULLA', () => {
              post({ type: 'decide', id: item.id, action: 'cancel' });
            })}
          </>
        )}
        {open}
      </span>
    </div>
  );
}

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
      <h3 class="t-title">{waitingTitle(first)}</h3>
      <p class="t-data mut">{waitingDetail(first)}</p>
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

/** A node's name and fields (ADR 0023): written to the folder's settings as they change. */
function NodeEditor({ node, roles }: { node: NodeInfo; roles: RolesState }) {
  const [name, setName] = useState(node.name);
  const rename = () => {
    const trimmed = name.trim();
    if (trimmed !== '' && trimmed !== node.name) writeNode(node, { name: trimmed });
    else setName(node.name);
  };
  return (
    <>
      <label class="nd-name">
        <span class="t-label">Nome</span>
        <input
          class="t-data"
          type="text"
          value={name}
          maxLength={NODE_NAME_LENGTH}
          onInput={(event) => {
            setName((event.target as HTMLInputElement).value);
          }}
          onBlur={rename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') rename();
          }}
        />
      </label>
      <RoleFields
        role="implementer"
        info={node}
        catalog={roles.catalog}
        node={{
          name: node.name,
          write: (change) => {
            writeNode(node, change);
          },
        }}
      />
      <p class="hint">
        {PROVIDER[node.cli].toUpperCase()} · UNA CONVERSAZIONE SUA · NESSUNA DELEGA
      </p>
    </>
  );
}

export function Squad({
  session,
  roles,
  monitor,
  items,
  nodeItems,
  theme,
  view,
  to,
  select,
  close,
  go,
}: {
  session: SessionInfo | undefined;
  roles: RolesState | undefined;
  monitor: MonitorState;
  items: readonly ThreadItem[];
  /** The nodes' own threads (ADR 0023). */
  nodeItems: Readonly<Record<string, readonly ThreadItem[]>>;
  theme: 'dark' | 'light';
  /** The node whose thread the chat shows, and the role it writes to otherwise. */
  view: string | null;
  to: RoleName;
  /** Makes an agent the one the chat writes to: a role, or a node by id. */
  select: (target: string) => void;
  close: () => void;
  /** Closes the panel and shows an item of the thread. */
  go: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string>(view ?? to);
  const nodes = roles?.nodes ?? [];
  const allItems = [...items, ...Object.values(nodeItems).flat()];
  // Opened with something waiting: its list first (ADR 0021).
  const [tab, setTab] = useState<Tab>(() =>
    waitingItems(allItems).length > 0 ? 'waiting' : 'events',
  );

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
  const waiting = waitingItems(allItems);
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
          title={ROLE[role]}
          index={INDEX[role]}
          info={shown(role)}
          agent={agentOf(monitor, role)}
          selected={selected === role}
          locked={role === 'leader' && started}
          select={() => {
            setSelected(role);
            select(role);
          }}
        />
      </Reveal>
    ),
  });
  // The nodes in a row under the roles, with no link: each talks only to you.
  const nodeBlock = (node: NodeInfo, index: number) => ({
    id: node.id,
    x: index * 500,
    y: 420,
    width: 340,
    children: (
      <Reveal delay={300 + index * 100}>
        <Agent
          title={node.name}
          index={nodeIndex(index)}
          info={node}
          agent={undefined}
          status={
            waitingItems(nodeItems[node.id] ?? []).length > 0
              ? 'waiting'
              : session?.busyNodes.includes(node.id)
                ? 'working'
                : 'idle'
          }
          selected={selected === node.id}
          locked={false}
          select={() => {
            setSelected(node.id);
            select(node.id);
          }}
        />
      </Reveal>
    ),
  });
  const selectedNode = nodes.find((n) => n.id === selected);
  const selectedIndex = selectedNode ? nodes.indexOf(selectedNode) : -1;
  /** A new node: Antigravity's first model when it is read, else the implementer's. */
  const addNode = () => {
    const agy = roles?.catalog.find((c) => c.cli === 'antigravity');
    const first = agy?.status === 'ready' ? agy.models[0] : undefined;
    const fallback = roles?.roles.implementer;
    if (first) post({ type: 'addNode', cli: 'antigravity', model: first.id });
    else if (fallback) post({ type: 'addNode', cli: fallback.cli, model: fallback.model });
  };
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
          blocks={[
            agentBlock('leader', 0),
            agentBlock('implementer', 500),
            ...nodes.map(nodeBlock),
          ]}
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
              <button
                class="cn-btn cn-btn--outline cn-btn--sm"
                type="button"
                disabled={!roles}
                title="Un agente in più, con una conversazione sua: lo selezioni e gli scrivi"
                onClick={addNode}
              >
                <span class="cn-btn__label">+ Nodo</span>
              </button>
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
                  <WaitingRow key={i.id} item={i} go={go} />
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

        <header class="cn-cell cn-cell--row sq-roleh" aria-label="Agente selezionato">
          {selectedNode ? (
            <>
              <span class="cn-tag">
                <b>{nodeIndex(selectedIndex)}/</b> Nodo
              </span>
              <button
                class="cn-btn cn-btn--text"
                type="button"
                onClick={() => {
                  post({ type: 'removeNode', id: selectedNode.id });
                  setSelected('leader');
                  select('leader');
                }}
              >
                <span class="cn-btn__label">× Rimuovi</span>
              </button>
            </>
          ) : (
            <>
              <span class="cn-tag">
                <b>{INDEX[isRole(selected) ? selected : 'leader']}/</b>{' '}
                {ROLE[isRole(selected) ? selected : 'leader']}
              </span>
              <span class="cn-tag">{started ? 'Di questa chat' : 'Prossima chat'}</span>
            </>
          )}
        </header>
        <div class="cn-cell sq-roleb">
          {!roles ? (
            <p class="hint">Lettura dei ruoli…</p>
          ) : selectedNode ? (
            <NodeEditor key={selectedNode.id} node={selectedNode} roles={roles} />
          ) : (
            <RoleEditor role={isRole(selected) ? selected : 'leader'} roles={roles} />
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
