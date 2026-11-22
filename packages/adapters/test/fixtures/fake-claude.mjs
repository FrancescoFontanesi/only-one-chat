// Fake `claude` CLI for tests. It replays the stream-json output recorded from
// the real CLI (test/fixtures/claude/<version>/turn-ok.jsonl, redacted) and
// shares no code with the adapter under test. Like the real CLI it emits
// nothing until the first user message arrives on stdin.
//
// `auth status --json` prints a status (flags below); otherwise it runs a turn. A
// `control_request` initialize is answered with the models before any turn.
// Flags: --log=<file> (argv, cwd, env and stdin lines, JSONL)
//        --logged-out | --auth-method=<m> | --api-provider=<p> | --auth-malformed
//        --api-key-source=<s> (in the init event) | --echo (answer with the prompt)
//        --hang (no result; a grandchild keeps the pipes open) | --exit-early
//        --scenario=<fixture> (default turn-ok; turn-usage-limit is a 429 rejection;
//        turn-subagent runs a sub-agent through the Agent tool)
//        --permission-mode-reported=<m> (in the init event; default: the -p argument)
//        --subagent-hang (stops after the first message of a sub-agent and never
//        finishes, like a sub-agent still running)
//        --ask (after init, asks its host with two can_use_tool control requests, a
//        Bash command then AskUserQuestion, and answers with the host's two responses)
// Real Claude arguments (-p, --model, …) are accepted and ignored; they are all in the
// --log entry's argv, so a test reads --mcp-config and --allowedTools there.
//
// Handoff calls (ADR 0035): prompt lines, one call each, run in order after init:
//   [handoff <tool> <json>]          the main agent calls the tool mcp__ooc__<tool>
//   [handoff-sub <tool> <json>]      the same from a sub-agent (parent_tool_use_id set)
//   [handoff@<server> <tool> <json>] the tool mcp__<server>__<tool>
// <json> is the call's input, one line. Like Claude, the fake emits the tool_use only
// if the tool is allowed: named in --allowedTools; else the host is asked when
// --permission-prompt-tool is given (a can_use_tool control request, allowed on
// "allow"), else it is denied (a tool_result with is_error, no tool_use). --ask-handoff
// asks the host for every call, allowed or not. The result of the turn reports each
// call's outcome: "handoffs: <tool>=allowed|denied, …".

import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const option = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name) => argv.includes(`--${name}`);
const logFile = option('log');
const log = (entry) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
const send = (message) => writeSync(1, `${JSON.stringify(message)}\n`);

log({ argv, cwd: process.cwd(), env: process.env });

if (argv.includes('auth') && argv.includes('status')) {
  if (flag('auth-malformed')) {
    writeSync(1, 'not json\n');
    process.exit(0);
  }
  writeSync(
    1,
    `${JSON.stringify({
      loggedIn: !flag('logged-out'),
      authMethod: option('auth-method') ?? 'claude.ai',
      apiProvider: option('api-provider') ?? 'firstParty',
      email: 'user@example.com',
      subscriptionType: 'pro',
    })}\n`,
  );
  process.exit(0);
}

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'claude');
const version = readdirSync(fixtures).sort().at(-1);
const scenario = option('scenario') ?? 'turn-ok';
const recorded = readFileSync(join(fixtures, version, `${scenario}.jsonl`), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.type === 'message' && entry.dir === 'server')
  .map((entry) => entry.message);

/** `[handoff…]` lines of a prompt: { sub, server, tool, input }. */
const handoffCalls = (prompt) =>
  [...prompt.matchAll(/^\[handoff(-sub)?(?:@(\S+))? (\S+) (.*)\]$/gm)].map((match) => ({
    sub: match[1] !== undefined,
    server: match[2] ?? 'ooc',
    tool: match[3],
    input: JSON.parse(match[4]),
  }));
const allowedTools = (argv[argv.indexOf('--allowedTools') + 1] ?? '').split(',');

let started = false;
/** Control requests sent to the host, waiting for its response, by request id. */
const waiting = new Map();
const askHost = (id, request) =>
  new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ type: 'control_request', request_id: id, request });
  });
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  log({ stdin: line });
  const request = JSON.parse(line);
  if (request.type === 'control_response' && waiting.has(request.response?.request_id)) {
    waiting.get(request.response.request_id)(request.response.response);
    return;
  }
  // The control protocol's initialize, answered with no turn (models as in 2.1.308).
  if (request.type === 'control_request' && request.request?.subtype === 'initialize') {
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.request_id,
        response: {
          models: [
            { value: 'default', displayName: 'Default (recommended)' },
            {
              value: 'sonnet',
              displayName: 'Sonnet 5.5',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
            {
              value: 'haiku',
              displayName: 'Haiku 5.5',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
            { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
          ],
          // Skills are tagged with where they come from; Claude Code's own commands are not.
          commands: [
            { name: 'tdd', description: 'Test-driven development. (user)', argumentHint: '' },
            { name: 'probe', description: 'A probe skill. (project)', argumentHint: '' },
            { name: 'clear', description: 'Clear conversation history', argumentHint: '' },
            { name: 'compact', description: 'Clear history but keep a summary', argumentHint: '' },
          ],
          account: { email: 'user@example.com' },
        },
      },
    });
    return;
  }
  if (started) return;
  started = true;
  void replay(request.message.content);
});

async function replay(prompt) {
  let answered = null;
  const outcomes = [];
  const denials = [];
  for (const original of recorded) {
    const message = structuredClone(original);
    if (message.type === 'system' && message.subtype === 'init') {
      message.cwd = process.cwd();
      if (option('api-key-source')) message.apiKeySource = option('api-key-source');
      const mode = argv[argv.indexOf('--permission-mode') + 1];
      message.permissionMode =
        option('permission-mode-reported') ??
        (argv.includes('--permission-mode') ? mode : 'default');
      send(message);
      if (flag('exit-early')) process.exit(4);
      if (flag('hang')) {
        // Like a tool still running: a grandchild holding stdout and stderr.
        const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
          stdio: ['ignore', 'inherit', 'inherit'],
          detached: process.platform === 'win32',
        });
        log({ hung: true, grandchild: grandchild.pid });
        setInterval(() => undefined, 60_000);
        return;
      }
      if (flag('ask')) {
        const bash = await askHost('ask-1', {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'rm -rf build' },
        });
        const ask = await askHost('ask-2', {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Quale formato?',
                header: 'Formato',
                options: [
                  { label: 'CSV', description: 'semplice' },
                  { label: 'JSON', description: 'annidato' },
                ],
                multiSelect: true,
              },
            ],
          },
        });
        answered = JSON.stringify({ bash, ask });
      }
      if (prompt.includes('[bash-evidence]')) {
        for (const [id, command, error] of [
          ['bash-pass', 'fake-check --success', false],
          ['bash-fail', 'fake-check --error', true],
          ['bash-denied', 'fake-check --denied', true],
        ]) {
          send({
            type: 'assistant',
            message: {
              id: 'msg-bash',
              content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
            },
          });
          send({
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error }] },
          });
          if (id === 'bash-denied') {
            denials.push({ tool_name: 'Bash', tool_use_id: id, tool_input: { command } });
          }
        }
      }
      for (const [index, call] of handoffCalls(prompt).entries()) {
        const name = `mcp__${call.server}__${call.tool}`;
        let allowed = allowedTools.includes(name);
        if (flag('ask-handoff') || (!allowed && argv.includes('--permission-prompt-tool'))) {
          const reply = await askHost(`handoff-${String(index)}`, {
            subtype: 'can_use_tool',
            tool_name: name,
            input: call.input,
          });
          allowed = reply?.behavior === 'allow';
        }
        outcomes.push(`${call.tool}=${allowed ? 'allowed' : 'denied'}`);
        if (!allowed) continue;
        const parent = call.sub ? 'toolu_sub' : null;
        send({
          type: 'assistant',
          parent_tool_use_id: parent,
          message: {
            role: 'assistant',
            model: 'claude-haiku-5-5',
            content: [{ type: 'tool_use', id: `toolu_h${String(index)}`, name, input: call.input }],
          },
        });
        send({
          type: 'user',
          parent_tool_use_id: parent,
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: `toolu_h${String(index)}`, content: 'received' },
            ],
          },
        });
      }
      continue;
    }
    if (flag('subagent-hang') && typeof message.parent_tool_use_id === 'string') {
      send(message);
      setInterval(() => undefined, 60_000);
      return;
    }
    if (flag('echo') && message.type === 'assistant') {
      message.message.content = [{ type: 'text', text: `ECHO: ${prompt}` }];
    }
    if (flag('echo') && message.type === 'result') message.result = `ECHO: ${prompt}`;
    if (flag('blank-session-id') && message.type === 'result') message.session_id = ' ';
    if (answered !== null && message.type === 'result') message.result = answered;
    if (denials.length > 0 && message.type === 'result') message.permission_denials = denials;
    if (outcomes.length > 0 && message.type === 'result') {
      message.result = `${message.result} handoffs: ${outcomes.join(', ')}`;
    }
    send(message);
  }
}
input.on('close', () => {
  if (!flag('hang')) process.exit(0);
});
