// The models each CLI offers, read from the fake CLIs: no model turn, no quota.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeModels, listClaudeModels, listCodexModels } from '../src/index.js';
import { testEnv } from './env.js';

const FAKE_CODEX = join(import.meta.dirname, 'fixtures', 'fake-app-server.mjs');
const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');

describe('model catalogs', () => {
  it('reads Codex’s visible models over every page of model/list', async () => {
    const models = await listCodexModels({
      executable: process.execPath,
      launcherArgs: [FAKE_CODEX, '--account=chatgpt'],
      baseEnv: testEnv(),
    });
    expect(models).toEqual([
      {
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1-Sol',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultEffort: 'low',
        isDefault: true,
      },
      {
        id: 'gpt-6-luna',
        name: 'GPT-6-Luna',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
        isDefault: false,
      },
    ]);
  });

  it('reads Claude’s models from its initialize response, before any turn', async () => {
    const models = await listClaudeModels({
      executable: process.execPath,
      launcherArgs: [FAKE_CLAUDE],
      baseEnv: testEnv(),
    });
    // `default` only names another model; a model without effort has no levels.
    expect(models.map((m) => [m.id, m.name, m.efforts.length])).toEqual([
      ['sonnet', 'Sonnet 5.5', 5],
      ['haiku', 'Haiku 5.5', 5],
      ['claude-haiku-4-5-20251001', 'Haiku 4.5', 0],
    ]);
  });

  it('keeps only the model fields of Claude’s response', () => {
    const models = claudeModels({
      models: [{ value: 'opus', displayName: 'Opus', extra: 'x' }],
      account: { email: 'user@example.com' },
    });
    expect(models).toEqual([
      { id: 'opus', name: 'Opus', efforts: [], defaultEffort: null, isDefault: false },
    ]);
    expect(JSON.stringify(models)).not.toContain('example.com');
  });
});
