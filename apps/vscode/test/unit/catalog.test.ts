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
    });
    expect(catalog.snapshot().map((c) => c.status)).toEqual(['loading', 'loading']);
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
});
