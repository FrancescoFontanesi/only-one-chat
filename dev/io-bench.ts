// I/O micro-benchmark of the workspace walks (ADR 0047): what `snapshot()` and
// the checkpoint store cost at 1,000 and 5,000 files, the stat cache included.
//
//   node --import ./dev/ts-resolve.mjs dev/io-bench.ts
//
// Median of 3 for the repeatable operations; "take cold" is one run on a fresh
// store. The "warm" runs use the same store and the module's cache, as the
// product does. The folder is temporary; nothing outside it is touched.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { longPath } from '../packages/adapters/src/index.js';
import { CheckpointStore } from '../apps/vscode/src/session/checkpoints.js';
import { changes, snapshot } from '../apps/vscode/src/session/facts.js';

const ms = (run: () => unknown, runs = 3): string => {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return (times[Math.floor(runs / 2)] ?? 0).toFixed(0);
};

for (const count of [1000, 5000]) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ooc-io-')));
  const cwd = join(root, 'w');
  const body = 'x = 1\n'.repeat(300); // ~1.8 KB, a small source file
  // Files last modified an hour ago, as in a workspace that is not being edited right now.
  const past = Date.now() / 1000 - 3600;
  for (let i = 0; i < count; i++) {
    const dir = join(cwd, `pkg${String(i % 50)}`, `sub${String(i % 7)}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `m${String(i)}.py`);
    writeFileSync(file, `${body}# ${String(i)}\n`);
    utimesSync(file, past, past);
  }
  const edit = (path: string, content: string) => {
    writeFileSync(path, content);
    utimesSync(path, past, past + 1);
  };
  const cold = (() => {
    const start = performance.now();
    snapshot(cwd);
    return (performance.now() - start).toFixed(0);
  })();
  const snapWarm = ms(() => snapshot(cwd));
  const base = snapshot(cwd);
  edit(join(cwd, 'pkg0', 'sub0', 'm0.py'), 'changed\n');
  const diff = ms(() => changes(base, snapshot(cwd)));
  const store = new CheckpointStore(join(root, 'store'), cwd);
  let k = 0;
  const takeCold = (() => {
    const start = performance.now();
    store.take(`c${String(k++)}`);
    return (performance.now() - start).toFixed(0);
  })();
  const takeWarm = ms(() => store.take(`c${String(k++)}`));
  const checkpoint = store.take('r0');
  if (!checkpoint) throw new Error('no checkpoint');
  edit(join(cwd, 'pkg1', 'sub1', 'm1.py'), 'changed too\n');
  const review = ms(() => store.review(checkpoint));
  const paths = Array.from({ length: 1000 }, (_, i) => join(cwd, `pkg${String(i % 50)}`));
  const longPaths = ms(() => {
    for (const path of paths) longPath(path);
  });
  console.log(
    `${String(count)} files | snapshot cold ${cold} ms | snapshot warm ${snapWarm} ms | snapshot+changes ${diff} ms | take cold ${takeCold} ms | take warm ${takeWarm} ms | review ${review} ms | longPath x1000 ${longPaths} ms`,
  );
  rmSync(root, { recursive: true, force: true });
}
