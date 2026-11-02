import { useEffect, useState } from 'preact/hooks';
import { parseHostMessage, type ProviderUsage, type UsageWindow } from '../src/webview/protocol.js';
import { vscodeApi } from './vscodeApi.js';

const NAMES = { codex: 'CODEX', claude: 'CLAUDE' } as const;

function time(ms: number): string {
  return new Date(ms).toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Why a window is missing, in a few words; the full note is in the tooltip. */
function missing(provider: ProviderUsage): string {
  if (provider.provider === 'claude') return 'dopo un turno';
  return provider.updatedAt === null && /non riuscita|non trovat|not found/i.test(provider.note)
    ? 'non letto'
    : 'in lettura';
}

function Cell({ window, provider }: { window: UsageWindow | undefined; provider: ProviderUsage }) {
  if (!window) {
    return (
      <td class="data muted" title={provider.note}>
        {missing(provider)}
      </td>
    );
  }
  const percent = window.usedPercent;
  return (
    <td
      class="data"
      title={window.resetsAt === null ? undefined : `reset ${time(window.resetsAt * 1000)}`}
    >
      <div class="meter-bar">
        <div class={`meter-fill p${String(Math.min(10, Math.round(percent / 10)))}`} />
      </div>
      {percent.toFixed(percent % 1 === 0 ? 0 : 1)}%
    </td>
  );
}

/** One table: each subscription with its 5-hour and weekly windows. */
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
    <div class="side">
      <table class="quota">
        <thead>
          <tr>
            <th class="label">PROVIDER</th>
            <th class="label">5H</th>
            <th class="label">1W</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.provider}>
              <th
                class="label"
                title={`${p.updatedAt === null ? 'nessuna lettura' : `letto ${time(p.updatedAt)}`} · ${p.note}`}
              >
                {NAMES[p.provider]}
              </th>
              <Cell window={p.windows.find((w) => w.name === '5h')} provider={p} />
              <Cell window={p.windows.find((w) => w.name === 'weekly')} provider={p} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
