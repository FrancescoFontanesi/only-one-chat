import { useEffect, useState } from 'preact/hooks';
import { parseHostMessage, type ProviderUsage } from '../src/webview/protocol.js';
import { formatTokens } from './state.js';
import { vscodeApi } from './vscodeApi.js';

const NAMES = { codex: 'CODEX', claude: 'CLAUDE' } as const;
const WINDOWS: Record<string, string> = { '5h': '5 ORE', weekly: 'SETTIMANA' };

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function resets(seconds: number | null): string {
  if (seconds === null) return '';
  const date = new Date(seconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  return ` · reset ${sameDay ? time(date.getTime()) : date.toLocaleDateString([], { weekday: 'short', day: 'numeric' })}`;
}

/** The subscriptions in use: usage windows and what this chat has used. */
export function UsageApp() {
  const [providers, setProviders] = useState<readonly ProviderUsage[]>([]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = parseHostMessage(event.data);
      if (message?.type === 'usage') setProviders(message.providers);
    };
    window.addEventListener('message', onMessage);
    vscodeApi.postMessage({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, []);

  return (
    <div class="usage">
      {providers.length === 0 && <p class="data muted">Nessuna subscription configurata.</p>}
      {providers.map((p) => (
        <section key={p.provider} class="card usage-card">
          <div class="card-head">
            <span class="label">{NAMES[p.provider]}</span>
            <span class="data muted">
              {p.updatedAt === null ? 'nessuna lettura' : `letto alle ${time(p.updatedAt)}`}
            </span>
          </div>
          {p.windows.map((w) => (
            <div key={w.name} class="meter">
              <div class="meter-row data">
                <span>{WINDOWS[w.name] ?? w.name}</span>
                <span>
                  {w.usedPercent.toFixed(w.usedPercent % 1 === 0 ? 0 : 1)}%{resets(w.resetsAt)}
                </span>
              </div>
              <div class="meter-bar">
                <div
                  class={`meter-fill p${String(Math.min(10, Math.round(w.usedPercent / 10)))}`}
                />
              </div>
            </div>
          ))}
          <div class="data muted">
            questa chat: contesto {formatTokens(p.chat.context)} · output{' '}
            {formatTokens(p.chat.output)}
            {p.chat.costUsd > 0 && ` · $${p.chat.costUsd.toFixed(3)} nominali`}
          </div>
          <div class="data muted">{p.note}</div>
        </section>
      ))}
      <button
        type="button"
        class="btn"
        onClick={() => {
          vscodeApi.postMessage({ type: 'refreshUsage' });
        }}
      >
        AGGIORNA CODEX
      </button>
    </div>
  );
}
