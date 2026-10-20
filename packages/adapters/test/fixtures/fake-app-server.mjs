// Fake `codex app-server` for tests. It speaks the documented stdio framing
// (one JSON object per line, no "jsonrpc" field) and shares no code with the
// client under test. Methods under `test/*` let a test trigger specific wire
// behaviour; everything is written with fs.writeSync so chunk boundaries and
// pipe back-pressure are real.
//
// Flags: app-server (required) | --ignore-eof | --exit-at-start | --fail-initialize

import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';

const flags = new Set(process.argv.slice(2));
if (!flags.has('app-server')) {
  writeSync(2, 'usage: fake-app-server app-server [flags]\n');
  process.exit(2);
}
if (flags.has('--exit-at-start')) {
  writeSync(2, 'fatal: fake startup failure\n');
  process.exit(3);
}

const out = (text) => writeSync(1, text);
const send = (message) => out(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const received = [];
const awaitingClient = new Map();
let initialized = false;
let nextServerRequestId = 1000;

const handlers = {
  'test/received': () => received,

  'test/echo': async ({ value, delayMs = 0 }) => {
    await sleep(delayMs);
    return { value };
  },

  // Responds byte-by-byte groups so UTF-8 sequences are split across chunks.
  'test/chunked': async ({ value }, id) => {
    const bytes = Buffer.from(`${JSON.stringify({ id, result: { value } })}\n`);
    for (let i = 0; i < bytes.length; i += 3) {
      writeSync(1, bytes, i, Math.min(3, bytes.length - i));
      await sleep(1);
    }
  },

  // Several notifications and the response in a single write.
  'test/batch': ({ count }, id) => {
    let text = '';
    for (let i = 0; i < count; i++)
      text += `${JSON.stringify({ method: 'test/tick', params: { i } })}\n`;
    out(`${text}${JSON.stringify({ id, result: 'batched' })}\n`);
  },

  'test/malformed': (_params, id) => {
    out('{not json\n');
    out('42\n');
    out('{"method":5}\n');
    out('{"result":"no id"}\n');
    send({ id, result: 'after-garbage' });
  },

  'test/invalidResponse': (_params, id) => send({ id }),

  'test/unknownId': (_params, id) => {
    send({ id: 999999, result: 'stray' });
    send({ id: 'not-ours', result: 'stray' });
    send({ id, result: 'ok' });
  },

  'test/error': (_params, id) =>
    send({ id, error: { code: -32602, message: 'bad params', data: { field: 'x' } } }),

  'test/never': () => undefined,

  'test/exit': ({ code }) => process.exit(code),

  // The response reaches stdout only after this process has exited: a helper
  // that inherited stdout writes it. Deterministic version of "output still in
  // the pipe when the exit is observed".
  'test/respondAfterExit': (_params, id) => {
    const line = `${JSON.stringify({ id, result: 'last words' })}\n`;
    // detached: on Windows, libuv kills non-detached children when this process exits.
    spawn(
      process.execPath,
      ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(line)}), 200)`],
      {
        stdio: ['ignore', 'inherit', 'ignore'],
        detached: true,
      },
    );
    process.exit(0);
  },

  'test/stderrFlood': ({ bytes }) => {
    writeSync(2, 'x'.repeat(bytes));
    return 'flooded';
  },

  // Sends a request to the client and returns the client's reply verbatim.
  'test/serverRequest': async ({ method, params }) => {
    const serverId = nextServerRequestId++;
    const reply = new Promise((resolve) => awaitingClient.set(serverId, resolve));
    send({ id: serverId, method, params });
    return reply;
  },
};

async function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  received.push(message);

  const { id, method, params } = message;
  if (method === undefined) {
    awaitingClient.get(id)?.(message);
    awaitingClient.delete(id);
    return;
  }
  if (id === undefined) return; // notification, e.g. `initialized`

  if (method === 'initialize') {
    if (initialized) return send({ id, error: { code: -32600, message: 'Already initialized' } });
    if (flags.has('--fail-initialize')) {
      return send({ id, error: { code: -32603, message: 'fake initialize failure' } });
    }
    initialized = true;
    return send({
      id,
      result: {
        userAgent: `fake-codex/0.0.0 (${String(params?.clientInfo?.name)})`,
        codexHome: '/fake/codex-home',
        platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
        platformOs: process.platform,
      },
    });
  }
  if (!initialized) return send({ id, error: { code: -32600, message: 'Not initialized' } });

  const handler = handlers[method];
  if (!handler)
    return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  const result = await handler(params ?? {}, id);
  if (result !== undefined) send({ id, result });
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => void handle(line));
input.on('close', () => {
  if (!flags.has('--ignore-eof')) process.exit(0);
});
if (flags.has('--ignore-eof')) setInterval(() => undefined, 60_000);
