// Every model a setting names is checked before it reaches a CLI (security.md
// T13, ADR 0050): the reviewer, the sub-agents and the nodes, as the roles.

import { describe, expect, it } from 'vitest';
import { ModelCatalog } from '../../src/session/catalog.js';
import { nodesOf } from '../../src/session/node.js';
import { reviewerOf, subagentsOf, type Setting } from '../../src/session/setting-choices.js';
import { parseApprovals, parseRevoke, revokeIn } from '../../src/shared/approvals.js';
import { isModel, parseWebviewMessage } from '../../src/shared/protocol.js';

const model = (id: string) => ({
  id,
  name: id,
  efforts: ['low'],
  defaultEffort: 'low',
  isDefault: false,
});

async function catalog() {
  const read = new ModelCatalog({
    codex: () => Promise.resolve([model('gpt-6.1-sol')]),
    claude: () => Promise.resolve([model('sonnet'), model('haiku')]),
    antigravity: () => Promise.resolve([model('gemini-3.8-flash-low')]),
  });
  await read.load();
  return read;
}

/** Settings as VS Code gives them: the value, else the manifest's default. */
function settings(values: Readonly<Record<string, unknown>>): Setting {
  const defaults: Readonly<Record<string, unknown>> = {
    'reviewer.model': 'haiku',
    'subagents.codexModel': 'gpt-6-luna',
    'subagents.claudeModel': 'claude-haiku-5-5',
  };
  return (key) => ({ value: key in values ? values[key] : defaults[key], fallback: defaults[key] });
}

describe('model names (security.md T13)', () => {
  it('takes no option, space, control character or empty name', () => {
    for (const bad of ['-x', '--model', 'a b', '', 'a\u0007b', 'model\n', 42])
      expect(isModel(bad)).toBe(false);
    for (const good of ['sonnet', 'haiku', 'gpt-6.1-sol', 'claude-haiku-5-5'])
      expect(isModel(good)).toBe(true);
  });
});

describe('reviewer, sub-agents and nodes from the settings', () => {
  it('sets a reviewer model aside for its default, and says so', async () => {
    const rejected: string[] = [];
    const tell = (key: string) => rejected.push(key);
    const read = await catalog();
    for (const bad of ['--dangerously-skip-permissions', '-m', 'opus-nonexistent']) {
      const reviewer = reviewerOf(
        read,
        settings({ 'reviewer.enabled': true, 'reviewer.cli': 'claude', 'reviewer.model': bad }),
        tell,
      );
      expect(reviewer.choice.model).toBe('haiku');
    }
    expect(rejected).toEqual(['reviewer.model', 'reviewer.model', 'reviewer.model']);
    // Antigravity with none runs its own model; the reviewer is read-only whatever the settings.
    const agy = reviewerOf(
      read,
      settings({ 'reviewer.cli': 'antigravity', 'reviewer.model': '', 'reviewer.rounds': 9 }),
      tell,
    );
    expect(agy.choice).toMatchObject({ cli: 'antigravity', model: '', permission: 'read-only' });
    expect(agy.rounds).toBe(3);
    expect(rejected).toHaveLength(3);
  });

  it('gives a Codex reviewer no Claude default: the CLI’s own model (ADR 0050)', async () => {
    const rejected: string[] = [];
    const read = await catalog();
    for (const bad of ['--dangerously-skip-permissions', 'gpt-0']) {
      const reviewer = reviewerOf(
        read,
        settings({ 'reviewer.cli': 'codex', 'reviewer.model': bad }),
        (key) => rejected.push(key),
      );
      expect(reviewer.choice).toMatchObject({ cli: 'codex', model: '' });
    }
    // Before the catalogs are read, a default they cannot vouch for is not used either.
    const unread = new ModelCatalog({
      codex: () => Promise.resolve([]),
      claude: () => Promise.resolve([]),
      antigravity: () => Promise.resolve([]),
    });
    const early = reviewerOf(
      unread,
      settings({ 'reviewer.cli': 'codex', 'reviewer.model': '-m' }),
      (key) => rejected.push(key),
    );
    expect(early.choice.model).toBe('');
    expect(rejected).toEqual(['reviewer.model', 'reviewer.model', 'reviewer.model']);
  });

  it('checks the sub-agents’ models on the pattern alone', () => {
    const rejected: string[] = [];
    const subagents = subagentsOf(
      settings({ 'subagents.codexModel': '-m', 'subagents.claudeModel': 'claude-haiku-5-5' }),
      (key) => rejected.push(key),
    );
    expect(subagents.codex.model).toBe('gpt-6-luna');
    // A full id the Claude catalog need not list is kept.
    expect(subagents.claude.model).toBe('claude-haiku-5-5');
    expect(rejected).toEqual(['subagents.codexModel']);
    const injected = subagentsOf(
      settings({ 'subagents.claudeModel': '--dangerously-skip-permissions' }),
      (key) => rejected.push(key),
    );
    expect(injected.claude.model).toBe('claude-haiku-5-5');
  });

  it('gives a node with a model its CLI must not receive none, the CLI’s own', async () => {
    const node = (id: string, cli: string, model: string) => ({ id, name: id, cli, model });
    const value = [
      node('a', 'claude', '--dangerously-skip-permissions'),
      node('b', 'codex', '-m'),
      node('c', 'claude', 'sonnet'),
      node('d', 'codex', 'gpt-0'),
    ];
    const rejected: string[] = [];
    // Without the catalog, the pattern alone.
    expect(nodesOf(value).map((n) => n.model)).toEqual(['', '', 'sonnet', 'gpt-0']);
    const read = await catalog();
    expect(nodesOf(value, read, (key) => rejected.push(key)).map((n) => n.model)).toEqual([
      '',
      '',
      'sonnet',
      '',
    ]);
    expect(rejected).toEqual(['nodes.a.model', 'nodes.b.model', 'nodes.d.model']);
  });
});

describe('approvals messages (ADR 0050)', () => {
  it('revokes one approval of an owner of a kind, or all, and nothing else', () => {
    expect(parseWebviewMessage({ type: 'revokeApproval' })).toEqual({ type: 'revokeApproval' });
    expect(parseRevoke({ ownerKind: 'node', owner: 'implementer', key: 'Bash\u0000{}' })).toEqual({
      type: 'revokeApproval',
      ownerKind: 'node',
      owner: 'implementer',
      key: 'Bash\u0000{}',
    });
    for (const bad of [
      { owner: 'implementer', key: 'k' },
      { ownerKind: 'agent', owner: 'implementer', key: 'k' },
      { ownerKind: 'role', owner: 'implementer' },
      { ownerKind: 'role', key: 'k' },
      { ownerKind: 'role', owner: '../x', key: 'k' },
      { ownerKind: 'role', owner: 'implementer', key: '' },
      { ownerKind: 'role', owner: 'implementer', key: 'x'.repeat(40_001) },
    ]) {
      expect(parseRevoke(bad)).toBeUndefined();
    }
    const approval = { ownerKind: 'role', owner: 'a', label: 'A', key: 'k', summary: 's' };
    expect(parseApprovals([approval])).toHaveLength(1);
    expect(parseApprovals([{ ...approval, key: 1 }])).toBeUndefined();
    expect(parseApprovals([{ ...approval, ownerKind: 'other' }])).toBeUndefined();
  });

  it('keeps a role’s approval when a node named like it revokes the same key, and the reverse', () => {
    /** An owner's approvals, kept as a bridge keeps them. */
    const holder = (ownerKind: 'role' | 'node', owner: string) => {
      const kept = new Set(['Bash\u0000{"command":"npm test"}']);
      return {
        ownerKind,
        owner,
        kept,
        revoke: (key: string) => kept.delete(key),
        clear: () => {
          kept.clear();
        },
      };
    };
    const role = holder('role', 'implementer');
    const node = holder('node', 'implementer');
    const key = 'Bash\u0000{"command":"npm test"}';
    revokeIn([role, node], {
      type: 'revokeApproval',
      ownerKind: 'node',
      owner: 'implementer',
      key,
    });
    expect([role.kept.size, node.kept.size]).toEqual([1, 0]);
    node.kept.add(key);
    revokeIn([role, node], {
      type: 'revokeApproval',
      ownerKind: 'role',
      owner: 'implementer',
      key,
    });
    expect([role.kept.size, node.kept.size]).toEqual([0, 1]);
    role.kept.add(key);
    revokeIn([role, node], { type: 'revokeApproval' });
    expect([role.kept.size, node.kept.size]).toEqual([0, 0]);
  });
});
