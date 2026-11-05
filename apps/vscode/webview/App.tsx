// The chat, as the canvas's Chat board draws it (ADR 0016): a bar, the
// thread (why the chat cannot run at its top), the dock (on a wide panel, the
// dials beside the composer); the Squad panel over it on request.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  parseHostMessage,
  type MonitorState,
  type ProviderUsage,
  type RolesState,
  type SessionInfo,
} from '../src/webview/protocol.js';
import { Dock, NotReady } from './Dock.js';
import { Squad } from './Squad.js';
import { applyUpdate, type ThreadItem } from './state.js';
import { Thread } from './Thread.js';
import { Decode, useHoverScramble } from './motion.js';
import { delegationNumbers } from './threadModel.js';
import { post, useTheme } from './ui.js';

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
        <button
          key={chat.id}
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
        </button>
      ))}
    </section>
  );
}

function Bar({
  session,
  waiting,
  openSquad,
}: {
  session: SessionInfo | undefined;
  waiting: number;
  openSquad: () => void;
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
        <b>{(session.title || 'Nuova chat').toUpperCase()}</b>
        {' / '}
        <Decode class="crumb__st" text={status} />
      </span>
      <div class="bar__r">
        {session.fake && <span class="cn-tag cn-tag--bracket hide-m">SIMULAZIONE</span>}
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
          <span class="cn-btn__label">+ NUOVA</span>
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
        <span class="vsep hide-m" />
        <button
          class="cn-btn cn-btn--outline cn-btn--sm"
          type="button"
          aria-label={`Apri il pannello Squad${waiting > 0 ? `, ${String(waiting)} richieste in attesa` : ''}`}
          onClick={openSquad}
        >
          <span class="cn-btn__label">SQUAD{waiting > 0 ? ` · ▲ ${String(waiting)}` : ''}</span>
          <span class="cn-btn__icon">↗</span>
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

function Empty({ session }: { session: SessionInfo | undefined }) {
  return (
    <section class="turn">
      <div class="who">
        <span>00/</span>
        <b>CHAT NUOVA</b>
      </div>
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
  const [session, setSession] = useState<SessionInfo>();
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [roles, setRoles] = useState<RolesState>();
  const [monitor, setMonitor] = useState<MonitorState>({ agents: [], events: [] });
  const [usage, setUsage] = useState<readonly ProviderUsage[]>([]);
  const [squad, setSquad] = useState(false);
  /** Changes when the thread is loaded again: what it brings is not animated. */
  const [epoch, setEpoch] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useHoverScramble(root);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = parseHostMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case 'session':
          setSession(message.session);
          break;
        case 'thread':
          setItems((current) => applyUpdate(current, message.update));
          break;
        case 'reset':
          setItems([]);
          setEpoch((e) => e + 1);
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

  // To the end once a frame at most: a streamed turn changes the items many times a second.
  const scrolling = useRef(0);
  useEffect(() => {
    if (scrolling.current !== 0) return;
    scrolling.current = requestAnimationFrame(() => {
      scrolling.current = 0;
      end.current?.scrollIntoView({ block: 'end' });
    });
  }, [items]);
  useEffect(
    () => () => {
      cancelAnimationFrame(scrolling.current);
    },
    [],
  );

  const numbers = useMemo(() => delegationNumbers(items), [items]);
  const waiting = items.filter(
    (i) => (i.kind === 'permission' || i.kind === 'approval') && !i.closed,
  ).length;

  return (
    <div ref={root} class="cn app app--live" data-theme={theme}>
      <Bar
        session={session}
        waiting={waiting}
        openSquad={() => {
          setSquad(true);
        }}
      />
      <main class="thread" ref={thread}>
        <div class="colw">
          {/* The thread reaches 15% of the composer's column past it on each side. */}
          <div class="thread__col">
            {session && (session.workspace === null || !session.trusted) && (
              <NotReady session={session} />
            )}
            {items.length === 0 && <Empty session={session} />}
            <Thread items={items} numbers={numbers} session={session} epoch={epoch} />
            <div ref={end} />
          </div>
        </div>
      </main>
      <Dock
        session={session}
        items={items}
        numbers={numbers}
        theme={theme}
        roles={roles}
        monitor={monitor}
        usage={usage}
        openSquad={() => {
          setSquad(true);
        }}
      />
      {squad && (
        <Squad
          session={session}
          roles={roles}
          monitor={monitor}
          items={items}
          theme={theme}
          close={() => {
            setSquad(false);
          }}
          go={(id) => {
            setSquad(false);
            // What waits is in the dock; anything else is in the thread.
            const target = document.getElementById(`item-${id}`);
            (target ?? end.current)?.scrollIntoView({ block: 'center' });
          }}
        />
      )}
    </div>
  );
}
