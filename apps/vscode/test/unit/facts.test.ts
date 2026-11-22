// The facts after an implementer's turn list the files that turn changed beside
// the files changed since the request began (ADR 0041).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles } from '@only-one-chat/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot, verifiedFacts } from '../../src/session/facts.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'facts '));
  mkdirSync(join(dir, 'tests'));
  writeFileSync(join(dir, 'main.py'), 'a');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('verifiedFacts', () => {
  it('lists the files of the last turn apart from the files of the request', async () => {
    const baseline = snapshot(dir);
    writeFileSync(join(dir, 'main.py'), 'b'); // round 1
    writeFileSync(join(dir, 'tests', 'test_rev.py'), 't'); // the reviewer's test
    const turnBase = snapshot(dir);
    writeFileSync(join(dir, 'extra.py'), 'c'); // round 2
    const facts = await verifiedFacts(dir, baseline, [], undefined, turnBase);
    expect(facts).toContain("Files changed by the implementer's last turn:\n- added extra.py");
    // The contract check reads this turn's list only.
    expect(changedFiles(facts)).toEqual(['extra.py', 'main.py', 'tests/test_rev.py']);
    expect(facts.split('last turn:')[1]).not.toContain('main.py');
  });

  it('has no turn list without a snapshot of the turn', async () => {
    const facts = await verifiedFacts(dir, snapshot(dir), []);
    expect(facts).not.toContain('last turn');
  });
});
