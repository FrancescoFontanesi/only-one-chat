import { useEffect, useRef, useState } from 'preact/hooks';
import { parseHostMessage, type ExtensionStatus } from '../src/webview/protocol.js';
import { vscodeApi } from './vscodeApi.js';

// Bootstrap view: shows the extension status and proves the host <-> webview
// round trip. The orchestration chat is not implemented yet.
export function App() {
  const [status, setStatus] = useState<ExtensionStatus>();
  const [lastPong, setLastPong] = useState<string>();
  const nextPingId = useRef(1);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = parseHostMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case 'status':
          setStatus(message.status);
          break;
        case 'pong':
          setLastPong(`#${String(message.id)} at ${message.receivedAt}`);
          break;
      }
    };
    window.addEventListener('message', onMessage);
    vscodeApi.postMessage({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, []);

  const ping = () => {
    vscodeApi.postMessage({ type: 'ping', id: nextPingId.current++ });
  };

  return (
    <main>
      <h1>Agent Workspace</h1>
      <p class="muted">Development bootstrap. The orchestrator is not implemented yet.</p>
      {status ? (
        <dl>
          <dt>Extension</dt>
          <dd>{status.extensionVersion}</dd>
          <dt>VS Code</dt>
          <dd>{status.vscodeVersion}</dd>
          <dt>Runtime</dt>
          <dd>
            {status.runtime.name} {status.runtime.version}
          </dd>
          <dt>Workspace trusted</dt>
          <dd>{status.workspaceTrusted ? 'yes' : 'no'}</dd>
        </dl>
      ) : (
        <p>Waiting for the extension host…</p>
      )}
      <button type="button" onClick={ping}>
        Ping extension host
      </button>
      {lastPong && <p data-testid="pong">Last reply: {lastPong}</p>}
    </main>
  );
}
