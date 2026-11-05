// The skills catalog for `$` (ADR 0019): read once per CLI and folder, again on request.

import { describe, expect, it } from 'vitest';
import { SkillCatalog } from '../../src/session/skills.js';

describe('skill catalog', () => {
  it('reads a CLI’s skills for a folder once, and again only on request', async () => {
    const calls: string[] = [];
    const catalog = new SkillCatalog({
      codex: (cwd) => {
        calls.push(`codex ${cwd}`);
        return Promise.resolve([
          { name: 'tdd', description: 'Tests first', path: '/s/tdd/SKILL.md' },
        ]);
      },
      claude: () => Promise.reject(new Error('Claude non risponde')),
    });
    expect(await catalog.load('codex', 'F:/x')).toEqual({
      status: 'ready',
      skills: [{ name: 'tdd', description: 'Tests first', path: '/s/tdd/SKILL.md' }],
    });
    await catalog.load('codex', 'F:/x');
    expect(calls).toEqual(['codex F:/x']);
    await catalog.load('codex', 'F:/x', true);
    await catalog.load('codex', 'F:/y');
    expect(calls).toEqual(['codex F:/x', 'codex F:/x', 'codex F:/y']);
    expect(catalog.find('codex', 'F:/x', 'tdd')?.path).toBe('/s/tdd/SKILL.md');
    expect(catalog.find('codex', 'F:/x', 'nope')).toBeUndefined();
    expect(await catalog.load('claude', 'F:/x')).toEqual({
      status: 'unavailable',
      note: 'Claude non risponde',
    });
  });
});
