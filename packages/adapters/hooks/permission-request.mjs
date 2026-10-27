// PermissionRequest hook of Claude Code (docs: hooks, "PermissionRequest"):
// Claude runs it for each tool call that would ask for permission. It asks the
// extension through the local permission bridge (127.0.0.1, a token per
// session; packages/adapters/src/claude/permission.ts) and prints the
// decision. Anything that goes wrong denies: no token, no bridge, no answer
// in time, a malformed reply. Plain Node, no dependencies: it runs outside the
// bundle, under the Node that the extension names.

import { connect } from 'node:net';

const ANSWER_TIMEOUT_MS = 9 * 60 * 1000; // below Claude's 10-minute hook timeout
const MAX_LINE = 1024 * 1024;

function print(behavior, input, message) {
  const decision =
    behavior === 'allow'
      ? { behavior: 'allow', updatedInput: input ?? {} }
      : { behavior: 'deny', message };
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })}\n`,
  );
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > MAX_LINE) throw new Error('hook input too large');
  }
  return JSON.parse(text);
}

function ask(port, token, request) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let reply = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('no answer in time'));
    }, ANSWER_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token, ...request })}\n`);
    });
    socket.on('data', (chunk) => {
      reply += chunk;
      if (reply.length > MAX_LINE) socket.destroy(new Error('reply too large'));
      if (reply.includes('\n')) {
        clearTimeout(timer);
        socket.end();
        resolve(JSON.parse(reply.slice(0, reply.indexOf('\n'))));
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!reply.includes('\n')) reject(new Error('the bridge closed without an answer'));
    });
  });
}

let input;
try {
  const hook = await readStdin();
  input = hook.tool_input;
  const port = Number(process.env.OOC_PERMISSION_PORT);
  const token = process.env.OOC_PERMISSION_TOKEN;
  if (!Number.isInteger(port) || !token) throw new Error('no permission bridge configured');
  const answer = await ask(port, token, { tool_name: hook.tool_name, tool_input: hook.tool_input });
  if (answer.behavior === 'allow') print('allow', input);
  else print('deny', undefined, answer.message || 'Negato dall’utente in Only One Chat.');
} catch (error) {
  print('deny', undefined, `Only One Chat non ha potuto chiedere all’utente: ${String(error)}`);
}
