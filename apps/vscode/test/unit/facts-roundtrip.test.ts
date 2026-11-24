// The facts' text as the session writes it, read back by the thread (ADR 0048):
// every case starts from the real producers, not from a hand-written string,
// except the one that stands for a chat saved before the change.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DIFF_CHECKS_UNAVAILABLE,
  GATE_SENT_BACK_HEADER,
  checkReport,
  contractFacts,
  type Report,
} from '@only-one-chat/runtime';
import { CheckpointStore } from '../../src/session/checkpoints.js';
import { configuredCommandFact, snapshot, verifiedFacts } from '../../src/session/facts.js';
import { isFacts, readContract, readFacts, readGate } from '../../webview/threadModel.js';

let root: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'facts-roundtrip '));
  cwd = join(root, 'workspace');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(
    join(cwd, 'src', 'calc.ts'),
    'export const add = (a: number, b: number) => a + b;\n',
  );
  writeFileSync(
    join(cwd, 'src', 'calc.test.ts'),
    "it('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n",
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** What ChatSession.facts() sends to the thread: the files, the command line, the diff checks. */
function sessionFacts(store: CheckpointStore, verify: readonly string[] = []) {
  const checkpoint = store.take('request');
  if (!checkpoint) throw new Error('no checkpoint');
  const baseline = snapshot(cwd);
  return {
    checkpoint,
    baseline,
    text: async (turnBase = baseline) =>
      [
        await verifiedFacts(cwd, baseline, verify, undefined, turnBase),
        configuredCommandFact(verify),
        store.diffChecks(checkpoint) ?? DIFF_CHECKS_UNAVAILABLE,
      ].join('\n\n'),
  };
}

describe('facts written by the session and read by the thread (ADR 0048)', () => {
  it('keeps the diff checks and the risk out of the files, with verify=[]', async () => {
    const store = new CheckpointStore(join(root, 'storage'), cwd);
    const facts = sessionFacts(store);
    writeFileSync(join(cwd, 'src', 'calc.ts'), 'export const add = () => 3;\n');
    writeFileSync(
      join(cwd, 'src', 'calc.test.ts'),
      "it('adds', () => {\n  expect(add(1, 2)).toBe(add(1, 2));\n});\n",
    );
    const text = await facts.text();
    expect(isFacts(text)).toBe(true);
    const read = readFacts(text);
    expect(read.files).toEqual(['modified src/calc.test.ts', 'modified src/calc.ts']);
    expect(read.flags).toEqual([
      'src/calc.test.ts: assertions that compare an expression with itself: 1',
    ]);
    expect(read.risk?.level).toMatch(/^(low|medium|high)$/);
    expect(read.risk?.reasons).toContain('1 diff check flag');
    expect(read.verify).toBeUndefined();
    expect(read.unavailable).toBe(false);
  });

  it('reads `no flags` as an empty list, and lists the last turn apart', async () => {
    const store = new CheckpointStore(join(root, 'storage'), cwd);
    const facts = sessionFacts(store);
    writeFileSync(
      join(cwd, 'src', 'calc.ts'),
      'export const add = (a: number, b: number) => b + a;\n',
    );
    const turnBase = snapshot(cwd);
    writeFileSync(join(cwd, 'src', 'extra.ts'), 'export {};\n');
    const read = readFacts(await facts.text(turnBase));
    expect(read.flags).toEqual([]);
    expect(read.files).toEqual(['modified src/calc.ts', 'added src/extra.ts']);
    expect(read.turn).toEqual(['added src/extra.ts']);
    expect(read.risk?.reasons.length).toBeGreaterThan(0);
  });

  it('ends the verification output where the diff checks begin', async () => {
    const store = new CheckpointStore(join(root, 'storage'), cwd);
    const facts = sessionFacts(store, [
      process.execPath,
      '-e',
      'console.log("FAIL: adds"); console.log("1 failed"); process.exit(1)',
    ]);
    const read = readFacts(await facts.text());
    expect(read.verify).toMatch(/· exit 1$/);
    expect(read.failed).toEqual(['FAIL: adds']);
    expect(read.output).toBe('FAIL: adds\n1 failed');
    expect(read.flags).toEqual([]);
    // Nothing changed: a score just under zero, as risk.ts computes it.
    expect(read.risk?.level).toBe('low');
  });

  it('says the workspace could not be compared instead of listing it as a file', async () => {
    const text = [
      await verifiedFacts(cwd, 'unavailable', []),
      configuredCommandFact([]),
      DIFF_CHECKS_UNAVAILABLE,
    ].join('\n\n');
    const read = readFacts(text);
    expect(read).toMatchObject({ files: [], unavailable: true, checksUnavailable: true });
    expect(read.flags).toBeUndefined();
  });

  it('reads the runtime checks of a report, scope-exceeded included', () => {
    const brief = '## Goal\nAdd.\n## Acceptance criteria\n- C1: adds\n## Paths\n- src/';
    const facts =
      'Files changed since the request began:\n- modified src/calc.ts\n- modified lib/x.ts';
    const report: Report = {
      outcome: 'done',
      summary: 'done',
      changes: [{ path: 'src/calc.ts', change: 'x' }],
      criteria: [{ id: 'C1', status: 'verified', evidence: 'test' }],
    };
    const text = contractFacts('Checks on the report', checkReport(brief, report, facts));
    expect(isFacts(text)).toBe(false);
    const read = readContract(text);
    expect(read?.title).toBe('Checks on the report');
    expect(read?.items.join('\n')).toContain("outside the brief's paths: lib/x.ts");
    expect(read?.items.join('\n')).toContain('does not list in changes: lib/x.ts');
    expect(readContract('Review by X: APPROVED')).toBeNull();
  });

  it('tells a check sent back before the review from any other notice', () => {
    expect(readGate(`${GATE_SENT_BACK_HEADER}\nfailed — 1 test failed`)).toBe(
      'failed — 1 test failed',
    );
    expect(readGate('Review by Haiku: REJECTED · 1 correction round')).toBeNull();
  });

  it('reads a chat saved before ADR 0048, text as it was written then', () => {
    const saved = [
      'Files changed since the request began:',
      '- modified src/calc.ts',
      '',
      'No runtime verification command configured.',
      '',
      'Runtime diff checks (flags for review):',
      '- lockfile changed: pnpm-lock.yaml',
      'Skipped because they were too large: data/big.bin',
      'Change risk estimated by the runtime: high (0.61) — 3 files changed; touches auth; 1 diff check flag.',
    ].join('\n');
    expect(readFacts(saved)).toEqual({
      files: ['modified src/calc.ts'],
      unavailable: false,
      failed: [],
      flags: ['lockfile changed: pnpm-lock.yaml'],
      skipped: 'data/big.bin',
      checksUnavailable: false,
      risk: {
        level: 'high',
        score: '0.61',
        reasons: ['3 files changed', 'touches auth', '1 diff check flag'],
      },
    });
  });
});
