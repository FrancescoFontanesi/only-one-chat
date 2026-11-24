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
  type TurnRole,
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

const STATE_TAG = { working: 'WORKING', waiting: '▲ ACTION REQUIRED', idle: '○ IDLE' } as const;
const LEVEL = { info: '■', warn: '▲', error: '×' } as const;
const INDEX: Record<TurnRole, string> = { leader: 'A', implementer: 'B', reviewer: 'C' };
/** A node's letter on the board: D, E, … after the three roles. */
const nodeIndex = (index: number) => String.fromCharCode(68 + (index % 23));
const isRole = (id: string): id is RoleName => id === 'leader' || id === 'implementer';

type Tab = 'events' | 'waiting' | 'changes';
type Waiting = WaitingItem;

function agentOf(monitor: MonitorState, role: TurnRole): MonitorAgent | undefined {
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
  off = false,
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
  /** Switched off (the reviewer, ADR 0033): shown, does nothing. */
  off?: boolean;
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
            {off ? '× OFF' : STATE_TAG[status]}
          </span>
        </button>
        <div class="xf__b sq-agent__b">
          <Decode initial class="sq-agent__m" text={info?.modelName ?? '—'} />
          <span class="t-data mut">
            {info
              ? [
                  PROVIDER[info.cli],
                  info.effort || 'no reasoning levels',
                  PERMISSIONS.find((p) => p.value === info.permission)?.short ?? '',
                  ...(locked ? ['locked'] : []),
                ].join(' · ')
              : 'role unavailable'}
          </span>
          <dl class="cn-spec sq-agent__s">
            <dt>Context</dt>
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
            <dt>Activity</dt>
            <dd>
              <span class={status === 'working' ? 't-data cn-cursor sq-agent__a' : 't-data mut'}>
                {agent?.activity ?? (status === 'working' ? 'working' : 'idle')}
              </span>
            </dd>
            {agent && agent.subagents.length > 0 && (
              <>
                <dt>Subagents</dt>
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
            {agent?.context ? `${kilo(agent.context.used)} tokens` : '— tokens'}
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
  if (item.kind === 'permission') return `Permission · ${ROLE[item.role]}`;
  if (item.kind === 'question') return `Question · ${ROLE[item.role]}`;
  return `${item.approval === 'delegation' ? 'Delegation' : 'Report'} awaiting approval`;
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
      <span class="cn-btn__label">{item.kind === 'question' ? 'REPLY ↗' : 'OPEN ↗'}</span>
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
            {action('ALLOW', () => {
              post({ type: 'permit', id: item.id, decision: 'accept' });
            })}
            {item.sessionAllowed !== false &&
              action('ALLOW FOR SESSION', () => {
                post({ type: 'permit', id: item.id, decision: 'acceptForSession' });
              })}
            {action('DENY', () => {
              post({ type: 'permit', id: item.id, decision: 'decline' });
            })}
          </>
        )}
        {item.kind === 'approval' && (
          <>
            {action('SEND', () => {
              post({ type: 'decide', id: item.id, action: 'approve' });
            })}
            {action('CANCEL', () => {
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
        <span class="cn-tag">○ No action needed</span>
        <p class="hint">
          Permission requests, delegations, and reports awaiting approval appear here.
        </p>
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
        <b>▲</b> Action required{waiting.length > 1 ? ` · ${String(waiting.length)}` : ''}
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
          <span class="cn-btn__label">Reply</span>
          <span class="cn-btn__icon">→</span>
        </button>
      </div>
    </section>
  );
}

/** The alias of the group the leader and the implementer form (ADR 0028). */
function TeamNameField({ roles }: { roles: RolesState }) {
  const shown = roles.team.alias;
  const [name, setName] = useState(shown);
  useEffect(() => {
    setName(shown);
  }, [shown]);
  const commit = () => {
    const trimmed = name.trim();
    if (trimmed !== shown) post({ type: 'setTeamName', name: trimmed });
  };
  return (
    <label class="nd-name">
      <span class="t-label">Team</span>
      <input
        class="t-data"
        type="text"
        value={name}
        maxLength={NODE_NAME_LENGTH}
        placeholder={roles.team.name}
        title="Name for the leader and implementer’s team. Leave blank to use the leader’s provider."
        onInput={(event) => {
          setName((event.target as HTMLInputElement).value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
    </label>
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
        <span class="t-label">Name</span>
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
      <p class="hint">{PROVIDER[node.cli].toUpperCase()} · SEPARATE CONVERSATION · NO DELEGATION</p>
    </>
  );
}

/**
 * The reviewer's fields (ADR 0029, 0033): any provider; it writes tests,
 * never the code, so there is no permission to choose.
 */
function ReviewerEditor({ roles }: { roles: RolesState }) {
  const { reviewer } = roles;
  return (
    <>
      <RoleFields
        role="implementer"
        info={reviewer}
        catalog={roles.catalog}
        only={['Provider', 'Model', 'Reasoning']}
        node={{
          name: ROLE.reviewer,
          write: (change) => {
            post({
              type: 'setReviewer',
              cli: change.cli ?? reviewer.cli,
              model: change.model ?? reviewer.model,
              effort: change.effort ?? reviewer.effort,
            });
          },
        }}
      />
      <p class="hint">REVIEWS ALL WORK · WRITES TESTS ONLY · THE LEADER READS THE REVIEW</p>
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
  to: TurnRole;
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
  const agentStatus = (role: TurnRole) => agentOf(monitor, role)?.status ?? 'idle';
  const waitingFor = (approval: 'delegation' | 'report') =>
    waiting.some((w) => w.kind === 'approval' && w.approval === approval);
  const reviewerOn = roles?.reviewer.enabled ?? false;
  const agentBlock = (role: TurnRole, x: number, y = 0) => ({
    id: role,
    x,
    y,
    width: 340,
    children: (
      <Reveal delay={role === 'leader' ? 0 : role === 'implementer' ? 150 : 250}>
        <Agent
          title={ROLE[role]}
          index={INDEX[role]}
          info={role === 'reviewer' ? roles?.reviewer : shown(role)}
          agent={agentOf(monitor, role)}
          selected={selected === role}
          locked={role === 'leader' && started}
          off={role === 'reviewer' && !reviewerOn}
          select={() => {
            setSelected(role);
            select(role);
          }}
        />
      </Reveal>
    ),
  });
  // The nodes on the reviewer's row, past the implementer, with no link: each talks only to you.
  const nodeBlock = (node: NodeInfo, index: number) => ({
    id: node.id,
    x: 1000 + index * 500,
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
    ['events', 'Events', monitor.events.length],
    ['waiting', 'Waiting', waiting.length],
    ['changes', 'Changes', open.length],
  ] as const;

  return (
    <div class="stage stage--layer" data-theme={theme}>
      <div class="veil veil--mezzatinta" onClick={close} />
      <Lattice class="sqw" edges={{ top: true, bottom: true, left: true, right: true }} dense={40}>
        <header class="cn-cell cn-cell--row sq-bar" role="dialog" aria-label="Squad panel">
          <span class="lt-mark">Squad</span>
          <span class="crumb">
            Chat / <b>{session?.title || 'New chat'}</b>
          </span>
          <div class="sq-bar__end">
            {roles?.fake && <span class="cn-tag cn-tag--ink">▲ Mock CLIs</span>}
            <span class="cn-tag">
              Delegations · <b>{session?.mode === 'auto' ? 'automatic' : 'manual'}</b>
            </span>
            <button class="cn-btn cn-btn--outline cn-btn--sm" type="button" onClick={close}>
              <span class="cn-btn__label">Close · Esc</span>
              <span class="cn-btn__icon">×</span>
            </button>
          </div>
        </header>

        <Board
          label="Agent board"
          blocks={[
            agentBlock('leader', 0),
            agentBlock('implementer', 500),
            // Under the two, between them: the work goes to it, and its review to the leader.
            agentBlock('reviewer', 250, 420),
            ...nodes.map(nodeBlock),
          ]}
          links={[
            {
              id: 'delegation',
              from: 'leader',
              to: 'implementer',
              label: waitingFor('delegation') ? '▲ Delegation' : 'Delegation',
              lane: -16,
              live: agentStatus('implementer') === 'working',
              waiting: waitingFor('delegation'),
            },
            ...(reviewerOn
              ? [
                  {
                    id: 'work',
                    from: 'implementer',
                    to: 'reviewer',
                    // The work goes to it and its findings come back: one line, both ways.
                    label: 'Work ⇄ Findings',
                    lane: 0,
                    live: agentStatus('reviewer') === 'working',
                  },
                  {
                    id: 'review',
                    from: 'reviewer',
                    to: 'leader',
                    label: waitingFor('report') ? '▲ Review' : 'Review',
                    lane: 0,
                    waiting: waitingFor('report'),
                  },
                ]
              : [
                  {
                    id: 'report',
                    from: 'implementer',
                    to: 'leader',
                    label: waitingFor('report') ? '▲ Report' : 'Report',
                    lane: 16,
                    waiting: waitingFor('report'),
                  },
                ]),
          ]}
          legend={
            <>
              <span class="cn-tag">
                <b>01/</b> Board
              </span>
              <button
                class="cn-btn cn-btn--outline cn-btn--sm"
                type="button"
                disabled={!roles}
                title="Add an agent with its own conversation"
                onClick={addNode}
              >
                <span class="cn-btn__label">+ Node</span>
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
                    ? `${working.map((a) => ROLE[a.role]).join(', ')} working`
                    : 'Listening'}
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
              <p class="hint">No open requests.</p>
            ) : (
              <div class="ilist">
                {waiting.map((i) => (
                  <WaitingRow key={i.id} item={i} go={go} />
                ))}
              </div>
            ))}
          {tab === 'changes' &&
            (changes.length === 0 ? (
              <p class="hint">No changes in this chat.</p>
            ) : (
              <div class="ilist">
                {changes.flatMap((card) =>
                  card.files.map((file) => (
                    <div key={`${card.id}-${file.path}`}>
                      <span>{file.path}</span>
                      <span>
                        {card.decisions[file.path] === 'accepted'
                          ? '■ ACCEPTED'
                          : card.decisions[file.path] === 'rejected'
                            ? '× REJECTED'
                            : file.binary
                              ? 'BINARY'
                              : `+${String(file.added)} −${String(file.removed)}`}
                      </span>
                    </div>
                  )),
                )}
                {open[0] && (
                  <div>
                    <span class="mut">{open.length} to review</span>
                    <button
                      class="cn-btn cn-btn--text"
                      type="button"
                      onClick={() => {
                        if (open[0]) go(open[0].card.id);
                      }}
                    >
                      <span class="cn-btn__label">REVIEW ↗</span>
                    </button>
                  </div>
                )}
              </div>
            ))}
        </div>

        <header class="cn-cell cn-cell--row sq-roleh" aria-label="Selected agent">
          {selectedNode ? (
            <>
              <span class="cn-tag">
                <b>{nodeIndex(selectedIndex)}/</b> Node
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
                <span class="cn-btn__label">× Remove</span>
              </button>
            </>
          ) : selected === 'reviewer' ? (
            <>
              <span class="cn-tag">
                <b>{INDEX.reviewer}/</b> {ROLE.reviewer}
              </span>
              <button
                class="cn-btn cn-btn--text"
                type="button"
                disabled={!roles}
                aria-pressed={reviewerOn}
                title={
                  reviewerOn
                    ? 'Turn off reviews so the leader reads the implementer’s report directly'
                    : 'Review all implementer work, including direct requests'
                }
                onClick={() => {
                  post({ type: 'setReviewerOn', enabled: !reviewerOn });
                }}
              >
                <span class="cn-btn__label">
                  {reviewerOn ? '■ On · turn off' : '○ Off · turn on'}
                </span>
              </button>
            </>
          ) : (
            <>
              <span class="cn-tag">
                <b>{INDEX[isRole(selected) ? selected : 'leader']}/</b>{' '}
                {ROLE[isRole(selected) ? selected : 'leader']}
              </span>
              <span class="cn-tag">{started ? 'This chat' : 'Next chat'}</span>
            </>
          )}
        </header>
        <div class="cn-cell sq-roleb">
          {!roles ? (
            <p class="hint">Loading roles…</p>
          ) : selectedNode ? (
            <NodeEditor key={selectedNode.id} node={selectedNode} roles={roles} />
          ) : selected === 'reviewer' ? (
            <ReviewerEditor roles={roles} />
          ) : (
            <>
              <TeamNameField roles={roles} />
              <RoleEditor role={isRole(selected) ? selected : 'leader'} roles={roles} />
            </>
          )}
        </div>

        <Alert waiting={waiting} theme={theme} go={go} />

        <footer class="cn-cell cn-cell--row sq-foot">
          <span class="cn-tag">Drag to pan · scroll to zoom</span>
        </footer>
      </Lattice>
    </div>
  );
}
