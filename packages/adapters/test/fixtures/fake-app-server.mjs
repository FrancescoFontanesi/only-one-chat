// Fake `codex app-server` for tests. It speaks the documented stdio framing
// (one JSON object per line, no "jsonrpc" field) and shares no code with the
// client under test. Methods under `test/*` let a test trigger specific wire
// behaviour; everything is written with fs.writeSync so chunk boundaries and
// pipe back-pressure are real.
//
// Real behaviour wins: shapes, error codes and message order follow the
// transcripts recorded from Codex in test/fixtures/codex/<version>/, and
// test/codex-contract.test.ts fails when the two diverge.
//
// Flags: app-server (required) | --ignore-eof | --exit-at-start | --fail-initialize
//        --account=<kind> (see ACCOUNTS) | --log=<file> (received messages, JSONL)
//        --provider=<id> --provider-name=<name> (config/read; `readError` fails it)
// Unknown arguments (such as Codex `-c key=value` overrides) are ignored.

import { spawn } from 'node:child_process';
import { appendFileSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';

const flags = new Set(process.argv.slice(2));
const option = (name) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const logFile = option('log');
if (!flags.has('app-server')) {
  writeSync(2, 'usage: fake-app-server app-server [flags]\n');
  process.exit(2);
}
if (flags.has('--exit-at-start')) {
  writeSync(2, 'fatal: fake startup failure\n');
  process.exit(3);
}

const out = (text) => writeSync(1, text);
// Returns nothing: handlers `return send(...)` to mean "already answered".
const send = (message) => {
  out(`${JSON.stringify(message)}\n`);
};
// Real notifications carry emittedAtMs next to method and params, not inside params.
const notify = (method, params) => send({ method, params, emittedAtMs: Date.now() });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const received = [];
const awaitingClient = new Map();
let initialized = false;
let nextServerRequestId = 1000;
const threads = new Map();
const turns = [];
const hanging = new Map();
let nextTurn = 1;

// `account/read` results, shaped like codex-rs GetAccountResponse.
const chatgpt = { type: 'chatgpt', email: 'user@example.com', planType: 'plus' };
const ACCOUNTS = {
  chatgpt: { account: chatgpt, requiresOpenaiAuth: true, workspaceRouting: null },
  apiKey: { account: { type: 'apiKey' }, requiresOpenaiAuth: true, workspaceRouting: null },
  none: { account: null, requiresOpenaiAuth: true, workspaceRouting: null },
  bedrock: {
    account: { type: 'amazonBedrock', usesCodexManagedCredentials: false },
    requiresOpenaiAuth: true,
    workspaceRouting: null,
  },
  futureMode: {
    account: { type: 'quantumToken' },
    requiresOpenaiAuth: true,
    workspaceRouting: null,
  },
  // A custom model provider (proxy, local model): Codex reports no OpenAI auth requirement.
  customProvider: { account: null, requiresOpenaiAuth: false, workspaceRouting: null },
  customProviderChatgpt: { account: chatgpt, requiresOpenaiAuth: false, workspaceRouting: null },
  customProviderApiKey: {
    account: { type: 'apiKey' },
    requiresOpenaiAuth: false,
    workspaceRouting: null,
  },
  missingField: { account: chatgpt },
};
// AuthMode values of `account/updated` (lowercase on the wire, e.g. "apikey").
const AUTH_MODE = { chatgpt: 'chatgpt', apiKey: 'apikey', none: null };

let accountKind = option('account') ?? 'none';

function setAccount(kind) {
  accountKind = kind;
  notify('account/updated', {
    authMode: AUTH_MODE[kind] ?? kind,
    planType: kind === 'chatgpt' ? 'plus' : null,
  });
}

const handlers = {
  'test/received': () => received,
  'test/env': () => process.env,
  'test/argv': () => process.argv.slice(2),
  // Turns follow the v2 protocol shapes (thread.rs, turn.rs, item.rs at
  // rust-v0.164.0); no real turn has been recorded yet. Markers in the prompt
  // pick the behaviour: [approval] asks for a command approval first, [hang]
  // runs until turn/interrupt, [fail] ends with status failed.
  'thread/start': (params) => {
    threads.set('thread-1', params);
    return {
      thread: { id: 'thread-1' },
      model: params.model ?? 'fake-model',
      modelProvider: 'openai',
      cwd: params.cwd ?? process.cwd(),
      approvalPolicy: params.approvalPolicy ?? 'on-request',
      approvalsReviewer: params.approvalsReviewer ?? 'user',
      sandbox: { type: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' },
      reasoningEffort: null,
    };
  },

  'turn/start': async (params, id) => {
    if (params.threadId === undefined) return { turn: { id: 'turn-1' } }; // gate tests
    const turnId = `turn-${String(nextTurn++)}`;
    const threadId = params.threadId;
    const text = params.input?.[0]?.text ?? '';
    turns.push({ turnId, params });
    send({ id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } });
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
    const complete = (status, error = null) =>
      notify('turn/completed', {
        threadId,
        turn: { id: turnId, status, items: [], error: error && { message: error } },
      });
    if (text.includes('[hang]')) {
      hanging.set(turnId, () => complete('interrupted'));
      return;
    }
    if (text.includes('[fail]')) return complete('failed', 'boom');
    let answer = `Risposta: ${text}`;
    if (text.includes('[approval]')) {
      const serverId = nextServerRequestId++;
      const reply = new Promise((resolve) => awaitingClient.set(serverId, resolve));
      send({
        id: serverId,
        method: 'item/commandExecution/requestApproval',
        params: { threadId, turnId, itemId: 'cmd-1', command: 'git push', reason: 'needs network' },
      });
      answer = `decision=${JSON.stringify((await reply).result ?? (await reply).error)}`;
    }
    const itemId = `msg-${turnId}`;
    const half = Math.ceil(answer.length / 2);
    for (const delta of [answer.slice(0, half), answer.slice(half)]) {
      notify('item/agentMessage/delta', { threadId, turnId, itemId, delta });
    }
    notify('item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: itemId, text: answer },
    });
    complete('completed');
  },

  'turn/interrupt': ({ turnId }) => {
    const stop = hanging.get(turnId);
    hanging.delete(turnId);
    setTimeout(() => stop?.(), 10);
    return {};
  },

  'test/turns': () => ({ threads: Object.fromEntries(threads), turns }),

  // Switches the account and emits account/updated before responding.
  'test/setAccount': ({ kind }) => {
    setAccount(kind);
    return 'switched';
  },

  'account/read': (_params, id) => {
    if (accountKind === 'readError') {
      return send({ id, error: { code: -32603, message: 'failed to load auth' } });
    }
    if (accountKind === 'updateDuringRead') {
      // The account changes while this read is in flight: the notification is
      // written first, the stale answer second.
      setAccount('apiKey');
      return send({ id, result: ACCOUNTS.chatgpt });
    }
    return ACCOUNTS[accountKind];
  },

  // Only the fields the client reads; the contract test compares that projection.
  'config/read': (_params, id) => {
    if (option('provider') === 'readError') {
      return send({ id, error: { code: -32603, message: 'failed to read config' } });
    }
    const provider = option('provider');
    if (provider === undefined) return { config: { model_provider: null, model_providers: {} } };
    const name = option('provider-name') ?? null;
    return {
      config: {
        model_provider: provider,
        model_providers: {
          [provider]: { name, base_url: 'http://127.0.0.1:9/v1', requires_openai_auth: false },
        },
      },
    };
  },

  'account/rateLimits/read': (_params, id) => {
    if (accountKind === 'apiKey') {
      return send({
        id,
        error: { code: -32600, message: 'chatgpt authentication required to read rate limits' },
      });
    }
    // TODO(adapters): a logged-in result needs the recorded login-complete transcript.
    return send({
      id,
      error: { code: -32600, message: 'codex account authentication required to read rate limits' },
    });
  },

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
      text += `${JSON.stringify({ method: 'test/tick', params: { i }, emittedAtMs: Date.now() })}\n`;
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

  // A process started by the server that inherits its stdout and stderr and
  // never exits by itself, like git or a shell command left behind by Codex.
  'test/spawnGrandchild': () => {
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      // Windows: otherwise libuv's job object kills it together with this process.
      detached: process.platform === 'win32',
    });
    return { pid: grandchild.pid };
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
  if (logFile) appendFileSync(logFile, `${JSON.stringify(message)}\n`);

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
    // Codex puts the client name first: "<name>/<version> (<os>; <arch>) <terminal> (<name>; <version>)".
    const name = String(params?.clientInfo?.name);
    send({
      id,
      result: {
        userAgent: `${name}/0.0.0-fake (fake-os; ${process.arch}) unknown (${name}; ${String(params?.clientInfo?.version)})`,
        codexHome: '/fake/codex-home',
        platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
        platformOs: process.platform === 'win32' ? 'windows' : process.platform,
      },
    });
    // Unsolicited, right after the handshake and before any later response.
    return notify('remoteControl/status/changed', {
      status: 'disabled',
      serverName: 'fake-host',
      installationId: 'fake-installation',
      environmentId: null,
    });
  }
  if (!initialized) return send({ id, error: { code: -32600, message: 'Not initialized' } });

  const handler = handlers[method];
  // Codex rejects unknown methods while deserializing the request: -32600, not -32601.
  if (!handler) {
    return send({
      id,
      error: {
        code: -32600,
        message: `Invalid request: unknown variant \`${method}\`, expected one of \`initialize\`, …`,
      },
    });
  }
  const result = await handler(params ?? {}, id);
  if (result !== undefined) send({ id, result });
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => void handle(line));
input.on('close', () => {
  if (!flags.has('--ignore-eof')) process.exit(0);
});
if (flags.has('--ignore-eof')) setInterval(() => undefined, 60_000);
