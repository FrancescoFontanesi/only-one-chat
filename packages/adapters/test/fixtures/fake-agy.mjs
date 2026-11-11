// A fake Antigravity CLI for the tests (ADR 0023): `models` prints the list,
// `--version` its version (`FAKE_AGY_VERSION`, default 1.5.5), `-p /quota
// --output-format json` the usage as agy answers it with no turn, `acp`
// serves the Agent Client Protocol on stdio. No network, no account.
//
// What a prompt does depends on its text:
// - "PERMESSO": asks to run a command and answers with the option it got;
// - "LENTO": works until `session/cancel`, then ends as cancelled;
// - anything else: a thought, a command, a plan, then "ECHO: <last line>".
// Every reply carries the model and mode the session has, and whether the
// prompt opened with the instructions of a new session (a `---` line after them).

import { createInterface } from 'node:readline';

const command = process.argv[2];
if (command === 'models') {
  process.stdout.write('fake-flash-low\tFake Flash (Low)\nfake-pro\tFake Pro\n');
  process.exit(0);
}
if (command === '--version') {
  process.stdout.write(`${process.env.FAKE_AGY_VERSION ?? '1.5.5'}\n`);
  process.exit(0);
}
if (command === '-p' && process.argv[3] === '/quota') {
  const bucket = (window, remaining, reset) => ({
    id: window,
    window,
    remaining_fraction: remaining,
    reset_time: reset,
  });
  process.stdout.write(
    JSON.stringify({
      conversation_id: '',
      status: 'SUCCESS',
      num_turns: 0,
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                bucket('weekly', 0.75, '2026-11-14T10:00:00Z'),
                bucket('5h', 0.9, '2026-11-11T20:00:00Z'),
              ],
            },
            { name: 'Claude and GPT models', buckets: [bucket('5h', 1, 'non una data')] },
          ],
        },
      },
    }),
  );
  process.exit(0);
}
if (command !== 'acp') {
  process.stderr.write(`unknown command ${String(command)}\n`);
  process.exit(2);
}

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const sessions = new Map();
const waiting = new Map();
let nextRequest = 1;
let cancel = () => undefined;

function ask(method, params) {
  const id = `s-${String(nextRequest++)}`;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

const update = (sessionId, body) =>
  send({ method: 'session/update', params: { sessionId, update: body } });

async function prompt(sessionId, text) {
  const session = sessions.get(sessionId);
  const say = (chunk) =>
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: chunk },
    });
  const instructed = text.includes('\n\n---\n\n');
  const tag = `[${session.model}|${session.mode}${instructed ? '|istruzioni' : ''}]`;
  if (text.includes('PERMESSO')) {
    const toolCall = {
      toolCallId: 'c1',
      title: 'rm -rf build',
      kind: 'execute',
      status: 'pending',
    };
    update(sessionId, { sessionUpdate: 'tool_call', ...toolCall });
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall,
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    say(`${tag} permesso: ${JSON.stringify(answer.outcome)}`);
    return { stopReason: 'end_turn' };
  }
  if (text.includes('LENTO')) {
    say(`${tag} inizio`);
    await new Promise((resolve) => (cancel = resolve));
    return { stopReason: 'cancelled' };
  }
  update(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Penso' },
  });
  update(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: ' ancora' },
  });
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'dir',
    kind: 'execute',
    status: 'in_progress',
  });
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 't1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }],
  });
  update(sessionId, {
    sessionUpdate: 'plan',
    entries: [{ content: 'Leggere', status: 'completed', priority: 'high' }],
  });
  say(`${tag} ECHO: `);
  say(text.trim().split('\n').at(-1));
  session.turns++;
  return {
    stopReason: 'end_turn',
    usage: {
      inputTokens: 100,
      outputTokens: 7,
      cachedReadTokens: 40,
      cachedWriteTokens: 0,
      thoughtTokens: 3,
      totalTokens: 107,
    },
  };
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === undefined) {
    waiting.get(id)?.(message.result);
    waiting.delete(id);
    return;
  }
  const reply = (result) => send({ id, result });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      });
    case 'session/new': {
      const sessionId = `fake-${String(sessions.size + 1)}`;
      sessions.set(sessionId, { model: 'fake-flash-high', mode: 'default', turns: 0 });
      return reply({
        sessionId,
        models: { currentModelId: 'fake-flash-high', availableModels: [] },
      });
    }
    case 'session/load':
      if (!String(params.sessionId).startsWith('fake-')) {
        return send({ id, error: { code: -32002, message: 'Resource not found' } });
      }
      sessions.set(params.sessionId, { model: 'fake-flash-high', mode: 'default', turns: 1 });
      update(params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'storia' },
      });
      return reply(null);
    case 'session/set_model':
      sessions.get(params.sessionId).model = params.modelId;
      return reply({});
    case 'session/set_mode':
      sessions.get(params.sessionId).mode = params.modeId;
      return reply({});
    case 'session/prompt':
      return reply(
        await prompt(params.sessionId, params.prompt.map((block) => block.text).join('')),
      );
    case 'session/cancel':
      cancel();
      return undefined;
    default:
      if (id !== undefined)
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return undefined;
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim()) void handle(JSON.parse(line));
});
