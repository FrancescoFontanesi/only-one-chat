// Messages exchanged between the extension host and the webview.
// Imported by both sides: it must not import `vscode` or DOM-only APIs.

export interface ExtensionStatus {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly runtime: { readonly name: string; readonly version: string };
  readonly workspaceTrusted: boolean;
}

export type HostToWebviewMessage =
  | { readonly type: 'status'; readonly status: ExtensionStatus }
  | { readonly type: 'pong'; readonly id: number; readonly receivedAt: string };

export type WebviewToHostMessage =
  { readonly type: 'ready' } | { readonly type: 'ping'; readonly id: number };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Validates a message received from the webview; anything unexpected is dropped. */
export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
  const msg = asRecord(value);
  switch (msg?.['type']) {
    case 'ready':
      return { type: 'ready' };
    case 'ping': {
      const id = msg['id'];
      return typeof id === 'number' && Number.isSafeInteger(id) ? { type: 'ping', id } : undefined;
    }
    default:
      return undefined;
  }
}

/** Validates a message received from the extension host. */
export function parseHostMessage(value: unknown): HostToWebviewMessage | undefined {
  const msg = asRecord(value);
  switch (msg?.['type']) {
    case 'status': {
      const status = asRecord(msg['status']);
      return status ? { type: 'status', status: status as unknown as ExtensionStatus } : undefined;
    }
    case 'pong': {
      const id = msg['id'];
      const receivedAt = msg['receivedAt'];
      return typeof id === 'number' && typeof receivedAt === 'string'
        ? { type: 'pong', id, receivedAt }
        : undefined;
    }
    default:
      return undefined;
  }
}
