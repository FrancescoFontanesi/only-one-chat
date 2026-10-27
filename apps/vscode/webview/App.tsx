import { useEffect, useRef, useState } from 'preact/hooks';
import {
  parseHostMessage,
  type ApprovalMode,
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

function Header({ session }: { session: SessionInfo | undefined }) {
  if (!session) return <header class="bar">Collegamento all’estensione…</header>;
  const setMode = (mode: ApprovalMode) => {
    post({ type: 'setMode', mode });
  };
  return (
    <header class="bar">
      <div class="bar-row">
        <span class="brand">ONLY ONE CHAT</span>
        {session.fake && <span class="tag tag-strong">FAKE</span>}
        <span class={session.busy ? 'state busy' : 'state'}>
          {session.busy ? '▶ IN CORSO' : '■ PRONTO'}
        </span>
      </div>
      <div class="bar-row data">
        <span class="label">LEADER</span>
        <span>{session.leader}</span>
        <span class="label">IMPLEMENTA</span>
        <span>{session.implementer}</span>
      </div>
      <div class="bar-row data">
        <span class="label">CARTELLA</span>
        <span class="path">{session.workspace ?? 'nessuna cartella aperta'}</span>
        {!session.trusted && <span class="tag">NON ATTENDIBILE</span>}
      </div>
      <div class="bar-row">
        <span class="label">APPROVAZIONI</span>
        <button
          type="button"
          class={session.mode === 'manual' ? 'seg on' : 'seg'}
          onClick={() => {
            setMode('manual');
          }}
        >
          MANUALI
        </button>
        <button
          type="button"
          class={session.mode === 'auto' ? 'seg on' : 'seg'}
          onClick={() => {
            setMode('auto');
          }}
        >
          AUTOMATICHE
        </button>
      </div>
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
          <span class="prompt">&gt;</span>
          <div class="text">{item.text}</div>
        </section>
      );
    case 'turn':
      return <Turn item={item} />;
    case 'approval':
      return <Approval item={item} />;
    case 'notice':
      return (
        <section class={`notice ${item.level}`}>
          <span class="glyph">{NOTICE_GLYPH[item.level]}</span>
          <pre class="data">{item.text}</pre>
        </section>
      );
  }
}

function Composer({ busy }: { busy: boolean }) {
  const [text, setText] = useState('');
  const send = () => {
    if (text.trim() === '' || busy) return;
    post({ type: 'send', text });
    setText('');
  };
  return (
    <footer class="composer">
      <textarea
        class="editor"
        placeholder="Scrivi al leader, oppure incolla un brief. Ctrl+Invio per inviare."
        value={text}
        rows={4}
        onInput={(event) => {
          setText((event.target as HTMLTextAreaElement).value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div class="actions">
        <button
          type="button"
          class="btn primary"
          disabled={busy || text.trim() === ''}
          onClick={send}
        >
          INVIA
        </button>
        <button
          type="button"
          class="btn"
          disabled={!busy}
          onClick={() => {
            post({ type: 'stop' });
          }}
        >
          FERMA
        </button>
        <button
          type="button"
          class="btn"
          disabled={busy}
          onClick={() => {
            post({ type: 'newChat' });
          }}
        >
          NUOVA CHAT
        </button>
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
            Scrivi una richiesta: il leader risponde, fa da sé le modifiche piccole o le delega
            all’implementatore. Un brief copiato da ChatGPT (&lt;&lt;&lt;OOC-BRIEF) va inoltrato
            così com’è.
          </p>
        )}
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        <div ref={end} />
      </main>
      <Composer busy={session?.busy ?? false} />
    </div>
  );
}
