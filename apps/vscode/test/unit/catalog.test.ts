import { describe, expect, it } from 'vitest';
import { ModelCatalog } from '../../src/session/catalog.js';

const SOL = {
  id: 'gpt-6.1-sol',
  name: 'GPT-6.1-Sol',
  efforts: ['low', 'ultra'],
  defaultEffort: 'low',
  isDefault: true,
};

describe('model catalog (ADR 0012)', () => {
  it('reads each CLI once, and tells a missing CLI from a model it does not offer', async () => {
    let reads = 0;
    const catalog = new ModelCatalog({
      codex: () => {
        reads++;
        return Promise.resolve([SOL]);
      },
      claude: () => Promise.reject(new Error('Claude non trovato')),
      antigravity: () => Promise.resolve([]),
    });
    expect(catalog.snapshot().map((c) => c.status)).toEqual(['loading', 'loading', 'loading']);
    await catalog.load();
    await catalog.load();
    expect(reads).toBe(1);
    const [codex, claude] = catalog.snapshot();
    expect(codex).toEqual({
      cli: 'codex',
      status: 'ready',
      models: [
        { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'ultra'], defaultEffort: 'low' },
      ],
    });
    expect(claude).toMatchObject({ status: 'unavailable', note: 'Claude non trovato' });
    expect(catalog.find('codex', 'gpt-6.1-sol')?.name).toBe('GPT-6.1-Sol');
    expect(catalog.rejects('codex', 'gpt-0')).toBe(true);
    // Claude's models are unknown, so nothing is rejected for it.
    expect(catalog.rejects('claude', 'sonnet')).toBe(false);
    await catalog.load(true);
    expect(reads).toBe(2);
  });

  it('sets aside a role’s model setting a CLI must not receive, for its default or none (security.md T13)', async () => {
    const catalog = new ModelCatalog({
      codex: () => Promise.resolve([SOL]),
      claude: () => Promise.reject(new Error('not read')),
      antigravity: () => Promise.resolve([]),
    });
    // Before the catalog is read, the pattern alone, and no default it cannot vouch for.
    expect(catalog.settled('codex', '--dangerously-skip-permissions', 'gpt-6.1-sol')).toEqual({
      model: '',
      rejected: true,
    });
    await catalog.load();
    expect(catalog.settled('codex', 'gpt-6.1-sol', 'x')).toEqual({
      model: 'gpt-6.1-sol',
      rejected: false,
    });
    for (const bad of [
      '--dangerously-skip-permissions',
      '-m',
      'model with spaces',
      'a\u0007b',
      '',
      42,
    ]) {
      expect(catalog.settled('codex', bad, 'gpt-6.1-sol')).toEqual({
        model: 'gpt-6.1-sol',
        rejected: true,
      });
    }
    // Not offered by the CLI, and a default it does not offer either: none, the CLI's own.
    expect(catalog.settled('codex', 'gpt-0', 'sonnet')).toEqual({ model: '', rejected: true });
    // Claude's catalog is unavailable: its names pass on the pattern alone.
    expect(catalog.settled('claude', 'sonnet', 'haiku')).toEqual({
      model: 'sonnet',
      rejected: false,
    });
    expect(catalog.settled('claude', '-p', 'haiku')).toEqual({ model: '', rejected: true });
  });
});
