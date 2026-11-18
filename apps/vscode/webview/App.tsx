// The chat, as the canvas's Chat board draws it (ADR 0016): a bar, the
// thread (why the chat cannot run at its top), the dock (on a wide panel, the
// dials beside the composer); the Squad panel over it on request.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  parseHostMessage,
  type MonitorState,
  type NodeInfo,
  type ProviderUsage,
  type TurnRole,
  type RolesState,
  type SessionInfo,
} from '../src/webview/protocol.js';
import { Dock, NotReady } from './Dock.js';
import { Squad } from './Squad.js';
import { applyUpdate, type ThreadItem } from './state.js';
import { Thread } from './Thread.js';
import { Decode } from './motion.js';
import { delegationNumbers, waitingItems } from './threadModel.js';
import { post, ShownNode, useTheme } from './ui.js';

function chatDate(ms: number): string {
  return new Date(ms).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
}

/** The chats of this folder: opens one. */
function History({ session, close }: { session: SessionInfo; close: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [close]);
  return (
    <section
      class="pop pop--down cn-frame cn-frame--ink"
      aria-label="Storico delle chat di questa cartella"
    >
      <div class="cn-frame__head pop__h">
        <span class="t-label">
          STORICO{session.workspace ? ` · ${folderName(session.workspace).toUpperCase()}` : ''}
        </span>
        <span class="t-label mut">{session.chats.length} CHAT</span>
      </div>
      {session.chats.length === 0 && <p class="hint pop__e">Nessuna chat salvata.</p>}
      {session.chats.map((chat) => (
        <div key={chat.id} class="pick-row">
          <button
            class={chat.id === session.chatId ? 'pick cn-accent' : 'pick'}
            type="button"
            aria-current={chat.id === session.chatId}
            disabled={session.busy}
            onClick={() => {
              if (chat.id !== session.chatId) post({ type: 'openChat', id: chat.id });
              close();
            }}
          >
            <span class="pick__n">{chat.title || 'Senza titolo'}</span>
            <span class="pick__m">{chatDate(chat.updatedAt)}</span>
            {/* Who worked in it (ADR 0027): the leader's block, then the nodes. */}
            {(chat.leader || chat.nodes.length > 0) && (
              <span class="pick__r">
                {chat.leader && <span>LDR {chat.leader}</span>}
                {chat.implementer && (
                  <span class={chat.implementerUsed ? undefined : 'mut'}>
                    IMP {chat.implementer}
                  </span>
                )}
                {chat.nodes.map((name, index) => (
                  <span key={index}>+ {name}</span>
                ))}
              </span>
            )}
          </button>
          {/* The host asks for confirmation before deleting. */}
          <button
            class="pick__x"
            type="button"
            aria-label={`Elimina la chat ${chat.title || 'senza titolo'}`}
            title="Elimina la chat"
            disabled={session.busy && chat.id === session.chatId}
            onClick={() => {
              post({ type: 'deleteChat', id: chat.id });
            }}
          >
            ×
          </button>
        </div>
      ))}
    </section>
  );
}

function Bar({
  session,
  waiting,
  node,
  leave,
}: {
  session: SessionInfo | undefined;
  waiting: number;
  /** The node whose thread is shown (ADR 0023), and the way back to the chat's. */
  node: NodeInfo | null;
  leave: () => void;
}) {
  const [history, setHistory] = useState(false);
  if (!session) {
    return (
      <header class="bar">
        <span class="crumb">COLLEGAMENTO ALL’ESTENSIONE…</span>
      </header>
    );
  }
  const ready = session.workspace !== null && session.trusted;
  const status = !ready
    ? '× NON PRONTO'
    : waiting > 0
      ? '▲ ASPETTA TE'
      : session.busy
        ? '▶ IN CORSO'
        : '■ PRONTO';
  return (
    <header class="bar">
      <span class="crumb" title={session.workspace ?? undefined}>
        {session.workspace
          ? `${folderName(session.workspace).toUpperCase()} / `
          : 'NESSUNA CARTELLA / '}
        {/* Settles once when the panel opens (the intro), then on every new title. */}
        <Decode initial class="crumb__t" text={(session.title || 'Nuova chat').toUpperCase()} />
        {node && (
          <>
            {' / '}
            <b>{node.name.toUpperCase()}</b>
          </>
        )}
        {' / '}
        <Decode class="crumb__st" text={status} />
      </span>
      <div class="bar__r">
        {session.fake && <span class="cn-tag cn-tag--bracket hide-m">SIMULAZIONE</span>}
        {node && (
          <button class="cn-btn cn-btn--text" type="button" onClick={leave}>
            <span class="cn-btn__label">← CHAT</span>
          </button>
        )}
        <button
          class="cn-btn cn-btn--text hide-m"
          type="button"
          aria-expanded={history}
          onClick={() => {
            setHistory(!history);
          }}
        >
          <span class="cn-btn__label">STORICO</span>
        </button>
        <button
          class="cn-btn cn-btn--text hide-m"
          type="button"
          disabled={session.busy}
          onClick={() => {
            setHistory(false);
            post({ type: 'newChat' });
          }}
        >
          <span class="cn-btn__label">NUOVA</span>
        </button>
        <button
          class="cn-btn cn-btn--text hide-m"
          type="button"
          onClick={() => {
            post({ type: 'openSettings' });
          }}
        >
          <span class="cn-btn__label">IMPOSTAZIONI</span>
        </button>
      </div>
      {history && (
        <History
          session={session}
          close={() => {
            setHistory(false);
          }}
        />
      )}
    </header>
  );
}

function Empty({ session, node }: { session: SessionInfo | undefined; node: NodeInfo | null }) {
  if (node) {
    return (
      <section class="empty">
        <div class="tb">
          <h2 class="t-title">Scrivi a {node.name}</h2>
          <p class="t-body mut">
            Una conversazione sua, nella stessa cartella: il leader e l’implementatore non la
            vedono, e lui non vede la loro.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section class="empty">
      <div class="tb">
        <h2 class="t-title">Scrivi al leader</h2>
        <p class="t-body mut">
          Ragiona e pianifica con te; quando glielo chiedi scrive il brief per l’implementatore.
          {session?.mode === 'manual'
            ? ' Il brief aspetta che tu lo invii.'
            : ' Il brief parte subito.'}
        </p>
        <p class="hint">
          UN BRIEF DA CHATGPT (&lt;&lt;&lt;OOC-BRIEF) PARTE SUBITO, CON LE NOTE DEL LEADER
        </p>
      </div>
    </section>
  );
}

export function App() {
  const theme = useTheme();
  /** The panel's entrance, once when it opens: the bar, the dials, the composer, the thread. */
  const [intro, setIntro] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => {
      setIntro(false);
    }, 1600);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  const [session, setSession] = useState<SessionInfo>();
  const [items, setItems] = useState<ThreadItem[]>([]);
  /** The nodes' own threads (ADR 0023), by node id. */
  const [nodeItems, setNodeItems] = useState<Readonly<Record<string, ThreadItem[]>>>({});
  /** The node whose thread is shown; null: the chat's. */
  const [view, setView] = useState<string | null>(null);
  const [to, setTo] = useState<TurnRole>('leader');
  const [roles, setRoles] = useState<RolesState>();
  const [monitor, setMonitor] = useState<MonitorState>({ agents: [], events: [] });
  const [usage, setUsage] = useState<readonly ProviderUsage[]>([]);
  const [squad, setSquad] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = parseHostMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case 'session':
          setSession(message.session);
          break;
        case 'thread': {
          const { node, update } = message;
          if (node) {
            setNodeItems((current) => ({
              ...current,
              [node]: applyUpdate(current[node] ?? [], update),
            }));
          } else setItems((current) => applyUpdate(current, update));
          break;
        }
        case 'reset':
          setItems([]);
          setNodeItems({});
          break;
        case 'roles':
          setRoles(message.roles);
          break;
        case 'monitor':
          setMonitor(message.monitor);
          break;
        case 'usage':
          setUsage(message.providers);
          break;
        default:
          break;
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, []);

  // A node taken off the board: its thread is no longer shown.
  const removed = session?.removedNodes.find((n) => n.id === view);
  const node =
    roles?.nodes.find((n) => n.id === view) ??
    (removed
      ? {
          ...removed,
          model: '',
          modelName: '—',
          effort: '',
          permission: 'read-only' as const,
          removed: true,
        }
      : null);
  const shown = node ? (nodeItems[node.id] ?? []) : items;
  const chooseRole = (role: TurnRole) => {
    setView(null);
    setTo(role);
  };
  /** Who you talk to, from Squad or the dial: a role, the reviewer, or a node by id. */
  const select = (target: string) => {
    if (target === 'leader' || target === 'implementer' || target === 'reviewer') {
      chooseRole(target);
    } else setView(target);
  };

  // To the end once a frame at most: a streamed turn changes the items many times a second.
  const scrolling = useRef(0);
  useEffect(() => {
    if (scrolling.current !== 0) return;
    scrolling.current = requestAnimationFrame(() => {
      scrolling.current = 0;
      end.current?.scrollIntoView({ block: 'end' });
    });
  }, [shown]);
  useEffect(
    () => () => {
      cancelAnimationFrame(scrolling.current);
    },
    [],
  );

  const numbers = useMemo(() => delegationNumbers(items), [items]);
  // What waits for you, in the chat's thread or in a node's.
  const open = useMemo(
    () => waitingItems([...items, ...Object.values(nodeItems).flat()]),
    [items, nodeItems],
  );
  const waiting = open.length;

  // A short notice above the dock when something new waits for you (ADR 0021):
  // `notice` counts the arrivals, and each one shows it again for 4 seconds.
  const [notice, setNotice] = useState(0);
  const [toast, setToast] = useState(false);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const fresh = open.filter((item) => !seen.current.has(item.id));
    for (const item of fresh) seen.current.add(item.id);
    if (fresh.length > 0 && !squad) setNotice((n) => n + 1);
  }, [open, squad]);
  useEffect(() => {
    if (notice === 0) return;
    setToast(true);
    const timer = setTimeout(() => {
      setToast(false);
    }, 4000);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

  return (
    <div
      ref={root}
      class={intro ? 'cn app app--live app--intro' : 'cn app app--live'}
      data-theme={theme}
    >
      <Bar
        session={session}
        waiting={waiting}
        node={node}
        leave={() => {
          setView(null);
        }}
      />
      <ShownNode.Provider value={node}>
        <main class="thread" ref={thread}>
          <div class="colw">
            {/* The thread reaches 15% of the composer's column past it on each side. */}
            <div class="thread__col">
              {session && (session.workspace === null || !session.trusted) && (
                <NotReady session={session} />
              )}
              {shown.length === 0 && <Empty session={session} node={node} />}
              <Thread key={node?.id ?? 'chat'} items={shown} numbers={numbers} session={session} />
              <div ref={end} />
            </div>
          </div>
        </main>
        {/* Takes no room: the notice floats over the end of the thread, above the dock. */}
        <div class="toast-slot" aria-live="polite">
          {toast && !squad && waiting > 0 && (
            <button
              class="toast"
              type="button"
              onClick={() => {
                setToast(false);
                setSquad(true);
              }}
            >
              <b>▲</b> Azione richiesta{waiting > 1 ? ` · ${String(waiting)}` : ''}
              <span class="toast__go">Apri Squad ↗</span>
            </button>
          )}
        </div>
        <Dock
          session={session}
          items={shown}
          numbers={numbers}
          theme={theme}
          roles={roles}
          monitor={monitor}
          usage={usage}
          openSquad={() => {
            setSquad(true);
          }}
          waiting={waiting}
          to={to}
          setTo={chooseRole}
          select={select}
        />
      </ShownNode.Provider>
      {squad && (
        <Squad
          session={session}
          roles={roles}
          monitor={monitor}
          items={items}
          nodeItems={nodeItems}
          theme={theme}
          view={view}
          to={to}
          select={select}
          close={() => {
            setSquad(false);
          }}
          go={(id) => {
            setSquad(false);
            // The thread that holds it is shown first: the chat's, or a node's.
            const owner = Object.entries(nodeItems).find(([, list]) =>
              list.some((item) => item.id === id),
            )?.[0];
            setView(owner ?? null);
            // What waits is in the dock; anything else is in the thread, drawn on the next frame.
            requestAnimationFrame(() => {
              const target = document.getElementById(`item-${id}`);
              (target ?? end.current)?.scrollIntoView({ block: 'center' });
            });
          }}
        />
      )}
    </div>
  );
}
