// The hidden tests of each sandbox scenario pass on its reference
// implementation, so the specification can be met and the tests are
// consistent with it. Needs Python; skipped without it.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSuite, runHiddenTests } from '../dev/bench/hidden.js';

const SCENARIOS = join(import.meta.dirname, '..', 'sandbox', 'scenarios');
const python = spawnSync('python', ['--version'], { encoding: 'utf8' }).status === 0;

describe.runIf(python)('sandbox scenario calc', () => {
  it('passes every hidden test on the reference implementation', async () => {
    const suite = loadSuite(join(SCENARIOS, 'calc', 'hidden-tests.json'));
    const results = await runHiddenTests(suite, join(SCENARIOS, 'calc', 'reference'), {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
    });
    expect(results.cases.filter((c) => !c.passed)).toEqual([]);
    expect(results.total).toBe(30);
  }, 120_000);

  it('names the run directory <RUN> in failure reasons, so results carry no local path', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'bench run '));
    try {
      const suite = loadSuite(join(SCENARIOS, 'calc', 'hidden-tests.json'));
      const results = await runHiddenTests({ ...suite, cases: suite.cases.slice(-1) }, empty, {
        ...process.env,
      });
      expect(results.passed).toBe(0);
      expect(results.cases[0]?.reason).toContain('<RUN>');
      expect(results.cases[0]?.reason).not.toContain(empty);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
