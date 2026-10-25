// Fake `claude` CLI for tests. It replays the stream-json output recorded from
// the real CLI (test/fixtures/claude/<version>/turn-ok.jsonl, redacted) and
// shares no code with the adapter under test. Like the real CLI it emits
// nothing until the first user message arrives on stdin.
//
// `auth status --json` prints a status (flags below); otherwise it runs a turn.
// Flags: --log=<file> (argv, cwd, env and stdin lines, JSONL)
//        --logged-out | --auth-method=<m> | --api-provider=<p> | --auth-malformed
//        --api-key-source=<s> (in the init event) | --echo (answer with the prompt)
//        --hang (no result; a grandchild keeps the pipes open) | --exit-early
//        --scenario=<fixture> (default turn-ok; turn-usage-limit is a 429 rejection)
//        --permission-mode-reported=<m> (in the init event; default: the -p argument)
// Real Claude arguments (-p, --model, …) are accepted and ignored.

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

let started = false;
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  log({ stdin: line });
  if (started) return;
  started = true;
  const prompt = JSON.parse(line).message.content;
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
      continue;
    }
    if (flag('echo') && message.type === 'assistant') {
      message.message.content = [{ type: 'text', text: `ECHO: ${prompt}` }];
    }
    if (flag('echo') && message.type === 'result') message.result = `ECHO: ${prompt}`;
    send(message);
  }
});
input.on('close', () => {
  if (!flag('hang')) process.exit(0);
});
