// The README's screenshots (docs/images): the real webview bundle in headless
// Chrome, fed by a fake host with a recorded chat (dev/screenshots/thread.json,
// from a bench run). No model turn, no quota.
//
//   pnpm --filter only-one-chat build && node dev/screenshots.mjs
//
// Each scene waits WAIT_MS of the page's time after its last click, so the
// animations of the chat and of Squad are over. CHROME: the browser's path.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = join(import.meta.dirname, '..');
const WAIT_MS = 2000;
const chrome =
  process.env['CHROME'] ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((path) => existsSync(path));
if (!chrome) throw new Error('no Chrome found: set CHROME');
const bundle = join(REPO, 'apps', 'vscode', 'dist', 'webview', 'main.js');
if (!existsSync(bundle)) throw new Error('build the extension first: dist/webview/main.js');

const thread = JSON.parse(
  readFileSync(join(import.meta.dirname, 'screenshots', 'thread.json'), 'utf8'),
);
const role = (cli, model, modelName, effort, permission) => ({
  cli,
  model,
  modelName,
  effort,
  permission,
});
const leader = role('codex', 'gpt-6.1-sol', 'GPT-6.1-Sol', 'medium', 'read-only');
const implementer = role('claude', 'sonnet', 'Sonnet', 'low', 'auto');
const reviewer = { ...role('claude', 'haiku', 'Haiku', 'high', 'auto'), enabled: true };
const gemini = {
  ...role('antigravity', 'gemini-3.8-flash', 'Gemini 3.8 Flash', 'medium', 'read-only'),
  id: 'n1',
  name: 'Gemini',
};
const efforts = ['low', 'medium', 'high', 'xhigh'];
const now = Date.now();
const minutes = (m) => now - m * 60_000;
const host = {
  session: {
    workspace: 'calc',
    trusted: true,
    leader,
    implementer,
    mode: 'auto',
    fake: false,
    busy: false,
    busyNodes: [],
    title: 'Include fra script',
    chats: [
      {
        id: 'c1',
        title: 'Include fra script',
        updatedAt: now,
        leader: 'GPT-6.1-Sol',
        implementer: 'Sonnet',
        implementerUsed: true,
        nodes: ['Gemini'],
      },
    ],
    chatId: 'c1',
    enterSends: true,
    context: {
      leader: { used: 80_000, window: 400_000 },
      implementer: { used: 281_000, window: 1_000_000 },
    },
    nodeContext: { n1: { used: 24_900, window: 1_000_000 } },
    removedNodes: [],
    usageThreshold: 80,
  },
  roles: {
    roles: { leader, implementer },
    chat: { leader, implementer },
    catalog: [
      {
        cli: 'codex',
        status: 'ready',
        models: [
          { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts, defaultEffort: 'medium' },
          { id: 'gpt-6.1-terra', name: 'GPT-6.1-Terra', efforts, defaultEffort: 'medium' },
        ],
      },
      {
        cli: 'claude',
        status: 'ready',
        models: [
          { id: 'sonnet', name: 'Sonnet', efforts, defaultEffort: 'medium' },
          { id: 'haiku', name: 'Haiku', efforts, defaultEffort: 'medium' },
        ],
      },
      {
        cli: 'antigravity',
        status: 'ready',
        models: [
          {
            id: 'gemini-3.8-flash',
            name: 'Gemini 3.8 Flash',
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
          },
        ],
      },
    ],
    nodes: [gemini],
    team: { name: 'Codex', alias: '' },
    reviewer,
    fake: false,
  },
  monitor: {
    agents: [
      {
        role: 'leader',
        info: leader,
        status: 'idle',
        activity: null,
        subagents: [],
        context: { used: 80_000, window: 400_000 },
      },
      {
        role: 'implementer',
        info: implementer,
        status: 'idle',
        activity: null,
        subagents: [],
        context: { used: 281_000, window: 1_000_000 },
      },
      {
        role: 'reviewer',
        info: reviewer,
        status: 'idle',
        activity: null,
        subagents: [],
        context: { used: 62_000, window: 200_000 },
      },
    ],
    events: [
      { at: minutes(1), level: 'info', text: 'Leader ha finito · risposta' },
      { at: minutes(2), level: 'info', text: 'Revisione di Claude (haiku): CON RISERVE · 1 giro' },
      { at: minutes(3), level: 'info', text: 'Implementatore ha corretto R1 e R2 · 43 s' },
      { at: minutes(5), level: 'warn', text: 'Rilievi del revisore: 2 bloccanti' },
      { at: minutes(8), level: 'info', text: 'Implementatore ha finito · 166 s' },
      { at: minutes(9), level: 'info', text: 'Delega inviata all’implementatore' },
    ],
  },
  usage: [
    {
      provider: 'codex',
      windows: [
        { name: '5h', usedPercent: 4, resetsAt: null },
        { name: 'weekly', usedPercent: 5, resetsAt: null },
      ],
      updatedAt: now,
      note: '',
    },
    {
      provider: 'claude',
      windows: [
        { name: '5h', usedPercent: 42, resetsAt: null },
        { name: 'weekly', usedPercent: 41, resetsAt: null },
      ],
      updatedAt: now,
      note: '',
    },
    {
      provider: 'antigravity',
      windows: [{ name: '5h', usedPercent: 1, resetsAt: null }],
      updatedAt: now,
      note: '',
    },
  ],
  node: [
    {
      type: 'user',
      id: 'nu1',
      text: 'Leggi main.py: la gestione degli include ha casi che sfuggono ai test?',
      to: 'implementer',
    },
    {
      type: 'turn',
      id: 'nt1',
      role: 'implementer',
      agent: 'Antigravity (gemini-3.8-flash)',
      status: 'done',
      label: 'Antigravity · gemini-3.8-flash-medium · predefinito',
      text: 'Due: un nome con soli spazi arriva a `open` e dà un errore generico, e `include "a.calc"` seguito da un commento sulla stessa riga non viene riconosciuto. Il resto (`..`, percorsi assoluti, cicli) è coperto da `test_hostile_paths` e `test_cycle_and_repeat`.',
      usage: { context: 24_900, output: 194, costUsd: null, durationMs: 6_000 },
    },
  ],
};

const scenes = [
  { name: 'chat', height: 900, clicks: [] },
  // Squad, with the reviewer selected: its fields and its switch.
  { name: 'squad', height: 1100, clicks: ['.sq-open', 'section[aria-label="Revisore"] button'] },
  // The group of the dial, once: the first node, Gemini, and its own thread.
  { name: 'node', height: 900, clicks: ['.hud__grp'] },
];

const media = pathToFileURL(join(REPO, 'apps', 'vscode', 'media', 'cn')).href;
const dir = mkdtempSync(join(tmpdir(), 'ooc-shots-'));
try {
  for (const scene of scenes) {
    const page = join(dir, `${scene.name}.html`);
    writeFileSync(
      page,
      `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8">
${['fonts.css', 'oo.css', 'bundle.css', 'app.css'].map((css) => `<link rel="stylesheet" href="${media}/${css}">`).join('\n')}
</head><body><div id="root" data-view="chat"></div>
<script>
const host = ${JSON.stringify(host)};
const thread = ${JSON.stringify(thread)};
const clicks = ${JSON.stringify(scene.clicks)};
const send = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
window.acquireVsCodeApi = () => ({
  postMessage(message) {
    if (message.type !== 'ready') return;
    setTimeout(() => {
      send({ type: 'session', session: host.session });
      send({ type: 'roles', roles: host.roles });
      send({ type: 'monitor', monitor: host.monitor });
      send({ type: 'usage', providers: host.usage });
      for (const update of thread) send({ type: 'thread', update });
      for (const update of host.node) send({ type: 'thread', update, node: 'n1' });
      clicks.forEach((selector, at) =>
        setTimeout(() => document.querySelector(selector)?.click(), 300 * (at + 1)));
    }, 0);
  },
});
</script>
<script src="${pathToFileURL(bundle).href}"></script>
</body></html>`,
    );
    const out = join(REPO, 'docs', 'images', `${scene.name}.png`);
    execFileSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--allow-file-access-from-files',
      `--user-data-dir=${join(dir, 'profile')}`,
      `--window-size=1600,${String(scene.height)}`,
      `--virtual-time-budget=${String(300 * (scene.clicks.length + 1) + WAIT_MS + 500)}`,
      `--screenshot=${out}`,
      pathToFileURL(page).href,
    ]);
    process.stdout.write(`${out}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
