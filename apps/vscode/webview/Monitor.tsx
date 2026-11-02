import { useEffect, useState } from 'preact/hooks';
import { parseHostMessage, type MonitorAgent, type MonitorState } from '../src/webview/protocol.js';
import { vscodeApi } from './vscodeApi.js';

const STATUS = {
  working: { glyph: '▶', label: 'LAVORA' },
  waiting: { glyph: '▲', label: 'ASPETTA TE' },
  idle: { glyph: '■', label: 'FERMO' },
} as const;

const LEVEL = { info: '■', warn: '▲', error: '×' } as const;

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function Agent({ agent }: { agent: MonitorAgent }) {
  const status = STATUS[agent.status];
  const { info } = agent;
  return (
    <section class={`card agent ${agent.status}`}>
      <div class="card-head">
        <span class="glyph">{status.glyph}</span>
        <span class="label">{agent.role === 'leader' ? 'LEADER' : 'IMPLEMENTATORE'}</span>
        <span class="data muted">{status.label}</span>
      </div>
      <div class="data">
        {info.cli === 'codex' ? 'Codex' : 'Claude'} · {info.modelName}
        {info.effort && ` · ${info.effort}`}
      </div>
      {agent.activity && <div class="data muted">{agent.activity}</div>}
      {agent.subagents.map((label, index) => (
        <div key={index} class="data muted">
          ↳ {label}
        </div>
      ))}
    </section>
  );
}

/** Who works now and what passed between the user and the agents, latest first. */
export function MonitorApp() {
  const [state, setState] = useState<MonitorState>({ agents: [], events: [] });

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = parseHostMessage(event.data);
      if (message?.type === 'monitor') setState(message.monitor);
    };
    window.addEventListener('message', onMessage);
    vscodeApi.postMessage({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, []);

  return (
    <div class="side">
      {state.agents.length === 0 && <p class="data muted">Apri la chat per vedere gli agenti.</p>}
      {state.agents.map((agent) => (
        <Agent key={agent.role} agent={agent} />
      ))}
      <div class="label">EVENTI</div>
      {state.events.length === 0 && <p class="data muted">Nessun evento in questa chat.</p>}
      <ol class="events">
        {state.events.map((event, index) => (
          <li key={`${String(event.at)}-${String(index)}`} class={`data ${event.level}`}>
            <span class="muted">{time(event.at)}</span> {LEVEL[event.level]} {event.text}
          </li>
        ))}
      </ol>
    </div>
  );
}
