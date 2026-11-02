import { useEffect, useRef, useState } from 'preact/hooks';
import {
  parseHostMessage,
  type ApprovalMode,
  type PermitDecision,
  type RoleInfo,
  type RoleName,
  type Route,
  type SessionInfo,
  type WebviewToHostMessage,
} from '../src/webview/protocol.js';
import { applyUpdate, formatTokens, type ThreadItem } from './state.js';
import { vscodeApi } from './vscodeApi.js';

const post = (message: WebviewToHostMessage) => {
  vscodeApi.postMessage(message);
};

const STATUS_GLYPH = { running: '▶', done: '■', failed: '×' } as const;
const NOTICE_GLYPH = { info: '■', warn: '▲', error: '×' } as const;

function chatDate(ms: number): string {
  return new Date(ms).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The chats kept for this folder: opens one of them. */
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
    <div class="history" role="listbox" aria-label="Chat precedenti">
      {session.chats.length === 0 && <p class="data muted">Nessuna chat salvata.</p>}
      {session.chats.map((chat) => (
        <button
          key={chat.id}
          type="button"
          role="option"
          aria-selected={chat.id === session.chatId}
          class={chat.id === session.chatId ? 'history-item on' : 'history-item'}
          disabled={session.busy}
          onClick={() => {
            if (chat.id !== session.chatId) post({ type: 'openChat', id: chat.id });
            close();
          }}
        >
          <span class="history-title">{chat.title || 'senza titolo'}</span>
          <span class="muted">{chatDate(chat.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
}

/** As in the Codex and Claude extensions: the chat's title, its history, a new chat. */
function Header({ session }: { session: SessionInfo | undefined }) {
  const [open, setOpen] = useState(false);
  if (!session) return <header class="bar">Collegamento all’estensione…</header>;
  return (
    <header class="bar top">
      <div class="bar-row">
        <span class="chat-title" title={session.title || 'Nuova chat'}>
          {session.title || 'Nuova chat'}
        </span>
        {session.fake && <span class="tag tag-strong">FAKE</span>}
        <span class={session.busy ? 'state busy' : 'state'}>
          {session.busy ? '▶ IN CORSO' : ready(session) ? '■ PRONTO' : '× NON PRONTO'}
        </span>
        <button
          type="button"
          class={open ? 'seg on' : 'seg'}
          aria-expanded={open}
          title="Chat precedenti"
          onClick={() => {
            setOpen(!open);
          }}
        >
          STORICO
        </button>
        <button
          type="button"
          class="seg"
          disabled={session.busy}
          title="Nuova chat"
          onClick={() => {
            setOpen(false);
            post({ type: 'newChat' });
          }}
        >
          + NUOVA
        </button>
        <button
          type="button"
          class="seg"
          title="Impostazioni di Only One Chat"
          onClick={() => {
            post({ type: 'openSettings' });
          }}
        >
          IMPOSTAZIONI
        </button>
      </div>
      <div class="bar-row data muted" title={session.workspace ?? undefined}>
        {session.workspace ? `CARTELLA ${folderName(session.workspace)}` : 'NESSUNA CARTELLA'}
      </div>
      {open && (
        <History
          session={session}
          close={() => {
            setOpen(false);
          }}
        />
      )}
    </header>
  );
}
function Approval({ item }: { item: Extract<ThreadItem, { kind: 'approval' }> }) {
  const [text, setText] = useState(item.text);
  const edited = text !== item.text;
  const title = item.approval === 'delegation' ? 'DELEGA' : 'RISULTATO AL LEADER';
  return (
    <section class={item.closed ? 'card approval closed' : 'card approval waiting'}>
      <div class="card-head">
        <span class="label">{title}</span>
        <span class="data">
          {item.from} → {item.to}
        </span>
      </div>
      {item.closed ? (
        <div class="data">
          ■{' '}
          {item.closed === 'cancel'
            ? 'annullato'
            : item.closed === 'edit'
              ? 'approvato con modifiche'
              : 'approvato'}
        </div>
      ) : (
        <>
          <textarea
            class="editor"
            value={text}
            rows={Math.min(18, Math.max(6, text.split('\n').length + 1))}
            onInput={(event) => {
              setText((event.target as HTMLTextAreaElement).value);
            }}
          />
          <div class="actions">
            <button
              type="button"
              class="btn primary"
              onClick={() => {
                post(
                  edited
                    ? { type: 'decide', id: item.id, action: 'edit', text }
                    : { type: 'decide', id: item.id, action: 'approve' },
                );
              }}
            >
              {edited ? 'APPROVA MODIFICATO' : 'APPROVA'}
            </button>
            <button
              type="button"
              class="btn"
              onClick={() => {
                post({ type: 'decide', id: item.id, action: 'cancel' });
              }}
            >
              ANNULLA
            </button>
          </div>
        </>
      )}
    </section>
  );
}

const PERMIT_LABEL: Record<string, string> = {
  accept: '■ consentito una volta',
  acceptForSession: '■ consentito per la sessione',
  decline: '× negato',
};

/** An agent asks before acting (R9): once, for the session, or no. */
function Permission({ item }: { item: Extract<ThreadItem, { kind: 'permission' }> }) {
  const answer = (decision: PermitDecision) => {
    post({ type: 'permit', id: item.id, decision });
  };
  return (
    <section class={item.closed ? 'card approval closed' : 'card approval waiting'}>
      <div class="card-head">
        <span class="label">PERMESSO</span>
        <span class="data">
          {item.role === 'leader' ? 'leader' : 'implementatore'} · {item.agent}
        </span>
      </div>
      <pre class="data">{item.summary}</pre>
      {item.closed ? (
        <div class="data">{PERMIT_LABEL[item.closed] ?? item.closed}</div>
      ) : (
        <div class="actions">
          <button
            type="button"
            class="btn primary"
            onClick={() => {
              answer('accept');
            }}
          >
            CONSENTI
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => {
              answer('acceptForSession');
            }}
          >
            CONSENTI PER LA SESSIONE
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => {
              answer('decline');
            }}
          >
            NEGA
          </button>
        </div>
      )}
    </section>
  );
}

function Turn({ item }: { item: Extract<ThreadItem, { kind: 'turn' }> }) {
  const usage = item.usage;
  return (
    <section class={`card turn ${item.role} ${item.status}`}>
      <div class="card-head">
        <span class="glyph">{STATUS_GLYPH[item.status]}</span>
        <span class="label">{item.role === 'leader' ? 'LEADER' : 'IMPLEMENTATORE'}</span>
        <span class="data">{item.label ?? item.agent}</span>
      </div>
      {item.subagents.length > 0 && (
        <ul class="subagents">
          {item.subagents.map((s) => (
            <li key={s.id} class="data">
              ↳ {s.label}
            </li>
          ))}
        </ul>
      )}
      {item.text ? (
        <div class="text">{item.text}</div>
      ) : (
        item.status === 'running' && <div class="data muted">lavora…</div>
      )}
      {item.activity.length > 0 && (
        <details class="activity">
          <summary class="label">ATTIVITÀ · {item.activity.length}</summary>
          <pre class="data">{item.activity.join('\n')}</pre>
        </details>
      )}
      {usage && (
        <div class="data muted usage">
          contesto {formatTokens(usage.context)} · output {formatTokens(usage.output)} ·{' '}
          {(usage.durationMs / 1000).toFixed(1)} s
          {usage.costUsd !== null && ` · $${usage.costUsd.toFixed(3)}`}
        </div>
      )}
    </section>
  );
}

function Item({ item }: { item: ThreadItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <section class="card user">
          <span class="label">TU</span>
          <div class="text">{item.text}</div>
        </section>
      );
    case 'turn':
      return <Turn item={item} />;
    case 'approval':
      return <Approval item={item} />;
    case 'permission':
      return <Permission item={item} />;
    case 'notice':
      return (
        <section class={`notice ${item.level}`}>
          <span class="glyph">{NOTICE_GLYPH[item.level]}</span>
          <pre class="data">{item.text}</pre>
        </section>
      );
  }
}

const ROUTES: readonly { value: Route | ''; label: string }[] = [
  { value: '', label: 'decide il leader' },
  { value: 'delega', label: 'delega' },
  { value: 'fai', label: 'fai tu' },
  { value: 'chiedi', label: 'chiedi prima' },
];

/** The agents can start: a folder is open and trusted. */
function ready(session: SessionInfo): boolean {
  return session.workspace !== null && session.trusted;
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
}

/** A role as one line: provider, model and reasoning. */
function roleLine(info: RoleInfo): string {
  return `${info.cli === 'codex' ? 'Codex' : 'Claude'} · ${info.modelName}${info.effort ? ` · ${info.effort}` : ''}`;
}

/**
 * The box to write in, and under its divider the settings of the message: who
 * receives it, the route asked of the leader, how messages between agents pass.
 */
function Composer({ session }: { session: SessionInfo | undefined }) {
  const [text, setText] = useState('');
  const [to, setTo] = useState<RoleName>('leader');
  const [route, setRoute] = useState<Route | ''>('');
  const busy = session?.busy ?? false;
  const canSend = session !== undefined && ready(session) && !busy && text.trim() !== '';
  const enterSends = session?.enterSends ?? true;
  const send = () => {
    if (!canSend) return;
    post({
      type: 'send',
      text,
      ...(to === 'implementer' ? { to } : {}),
      ...(to === 'leader' && route ? { route } : {}),
    });
    setText('');
  };
  const setMode = (mode: ApprovalMode) => {
    post({ type: 'setMode', mode });
  };
  const recipient = session ? (to === 'leader' ? session.leader : session.implementer) : undefined;
  const placeholder =
    to === 'leader'
      ? 'Scrivi al leader, oppure incolla un brief (<<<OOC-BRIEF).'
      : 'Scrivi all’implementatore: il leader legge il suo rapporto con il tuo prossimo messaggio.';
  return (
    <footer class="composer">
      {session && !session.workspace && (
        <div class="notice warn">
          <span class="glyph">▲</span>
          <span class="data">Apri la cartella in cui gli agenti devono lavorare.</span>
          <button
            type="button"
            class="seg"
            onClick={() => {
              post({ type: 'openFolder' });
            }}
          >
            APRI CARTELLA
          </button>
        </div>
      )}
      {session?.workspace && !session.trusted && (
        <div class="notice warn">
          <span class="glyph">▲</span>
          <span class="data">
            Cartella non attendibile (Workspace Trust): gli agenti non partono.
          </span>
        </div>
      )}
      <div class="compose-box">
        <textarea
          class="editor bare"
          placeholder={`${placeholder} ${
            enterSends
              ? 'Invio per inviare, Maiusc+Invio per andare a capo.'
              : 'Ctrl+Invio per inviare.'
          }`}
          value={text}
          rows={3}
          onInput={(event) => {
            setText((event.target as HTMLTextAreaElement).value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.isComposing) return;
            const sends = enterSends ? !event.shiftKey : event.ctrlKey || event.metaKey;
            if (sends) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div class="toolbar">
          <span class="seg-group" role="group" aria-label="Destinatario">
            <button
              type="button"
              class={to === 'leader' ? 'seg on' : 'seg'}
              title={session ? roleLine(session.leader) : undefined}
              onClick={() => {
                setTo('leader');
              }}
            >
              LEADER
            </button>
            <button
              type="button"
              class={to === 'implementer' ? 'seg on' : 'seg'}
              title={session ? roleLine(session.implementer) : undefined}
              onClick={() => {
                setTo('implementer');
              }}
            >
              IMPLEMENTATORE
            </button>
          </span>
          {to === 'leader' && (
            <label class="field-inline">
              <span class="label">VIA</span>
              <select
                class="select"
                value={route}
                onChange={(event) => {
                  setRoute((event.target as HTMLSelectElement).value as Route | '');
                }}
              >
                {ROUTES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label class="field-inline" title="Come passano i messaggi fra leader e implementatore">
            <span class="label">DELEGHE</span>
            <select
              class="select"
              value={session?.mode ?? 'manual'}
              onChange={(event) => {
                setMode((event.target as HTMLSelectElement).value as ApprovalMode);
              }}
            >
              <option value="manual">approvo io</option>
              <option value="auto">automatiche</option>
            </select>
          </label>
          <span class="spacer" />
          {recipient && <span class="data muted recipient">{roleLine(recipient)}</span>}
          {busy ? (
            <button
              type="button"
              class="btn"
              onClick={() => {
                post({ type: 'stop' });
              }}
            >
              FERMA
            </button>
          ) : (
            <button type="button" class="btn primary" disabled={!canSend} onClick={send}>
              INVIA
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}
export function App() {
  const [session, setSession] = useState<SessionInfo>();
  const [items, setItems] = useState<ThreadItem[]>([]);
  const end = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [items]);

  return (
    <div class="app">
      <Header session={session} />
      <main class="thread">
        {items.length === 0 && (
          <p class="data muted empty">
            Scrivi una richiesta: il leader risponde, oppure delega le modifiche all’implementatore.
            Un brief copiato da ChatGPT (&lt;&lt;&lt;OOC-BRIEF) va inoltrato così com’è.
          </p>
        )}
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        <div ref={end} />
      </main>
      <Composer session={session} />
    </div>
  );
}
