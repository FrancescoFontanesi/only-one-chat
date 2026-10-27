// Interactive permissions for headless Claude Code (R9, ADR 0011). The
// documented way for a host that is not the Agent SDK is a PermissionRequest
// hook (Claude Code docs: hooks), passed for the run only with --settings. The
// hook script (hooks/permission-request.mjs) asks this bridge, a TCP server on
// 127.0.0.1 that takes one JSON line per request and checks a random token,
// then prints Claude's decision. Nothing is written to the user's settings.
//
// "For the session" is kept here, as an exact match of the tool and its whole
// input, never a program or a prefix (threat T5).

import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export type PermissionDecision = 'accept' | 'acceptForSession' | 'decline';

export interface PermissionRequest {
  readonly tool: string;
  readonly input: unknown;
  /** One line for the user: the command, or the file and the tool. */
  readonly summary: string;
}

export interface PermissionBridge {
  /** Settings for `--settings`: the PermissionRequest hook, for this run only. */
  readonly settings: string;
  /** What the hook needs from the environment: the bridge's port and token. */
  readonly env: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

export interface PermissionBridgeOptions {
  /** Node that runs the hook script: `node`, or the editor's own (see env). */
  readonly nodeExecutable: string;
  /** Path of hooks/permission-request.mjs. */
  readonly hookScript: string;
  /** Extra environment for the hook, e.g. ELECTRON_RUN_AS_NODE=1 for the editor's Node. */
  readonly nodeEnv?: Readonly<Record<string, string>>;
}

const MAX_LINE = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One line for the user: Bash shows its command, the file tools their path. */
export function summarizeToolCall(tool: string, input: unknown): string {
  if (isRecord(input)) {
    if (typeof input['command'] === 'string') return `${tool}: ${input['command']}`;
    if (typeof input['file_path'] === 'string') return `${tool}: ${input['file_path']}`;
  }
  return tool;
}

/** Stable key of a request: the tool and its whole input, keys sorted. */
function requestKey(tool: string, input: unknown): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : isRecord(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, sorted(value[key])]),
          )
        : value;
  return `${tool}\u0000${JSON.stringify(sorted(input))}`;
}

/** The hook command line: forward slashes and double quotes work in cmd and bash alike. */
function hookCommand(node: string, script: string): string {
  const quote = (path: string) => `"${path.replaceAll('\\', '/')}"`;
  return `${quote(node)} ${quote(script)}`;
}

export async function startPermissionBridge(
  ask: (request: PermissionRequest) => Promise<PermissionDecision>,
  options: PermissionBridgeOptions,
): Promise<PermissionBridge> {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(token);
  const allowed = new Set<string>();
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let line = '';
    const answer = (behavior: 'allow' | 'deny', message?: string) => {
      if (!socket.destroyed) socket.end(`${JSON.stringify({ behavior, message })}\n`);
    };
    socket.on('data', (chunk: string) => {
      line += chunk;
      if (line.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      const end = line.indexOf('\n');
      if (end < 0) return;
      socket.removeAllListeners('data');
      let message: unknown;
      try {
        message = JSON.parse(line.slice(0, end));
      } catch {
        answer('deny', 'Malformed request');
        return;
      }
      const given =
        isRecord(message) && typeof message['token'] === 'string' ? message['token'] : '';
      const tokenOk =
        given.length === token.length && timingSafeEqual(Buffer.from(given), expected);
      if (!tokenOk || !isRecord(message) || typeof message['tool_name'] !== 'string') {
        answer('deny', 'Unknown caller');
        return;
      }
      const tool = message['tool_name'];
      const input = message['tool_input'];
      const key = requestKey(tool, input);
      if (allowed.has(key)) {
        answer('allow');
        return;
      }
      ask({ tool, input, summary: summarizeToolCall(tool, input) })
        .then((decision) => {
          if (decision === 'acceptForSession') allowed.add(key);
          if (decision === 'decline') answer('deny', 'Negato dall’utente in Only One Chat.');
          else answer('allow');
        })
        .catch(() => {
          answer('deny', 'Nessuna risposta dall’utente.');
        });
    });
    socket.on('error', () => undefined);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('the permission bridge has no port'));
    });
  });

  const settings = JSON.stringify({
    hooks: {
      PermissionRequest: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: hookCommand(options.nodeExecutable, options.hookScript),
              timeout: 600,
            },
          ],
        },
      ],
    },
  });

  return {
    settings,
    env: {
      OOC_PERMISSION_PORT: String(port),
      OOC_PERMISSION_TOKEN: token,
      ...(options.nodeEnv ?? {}),
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
