// The models each CLI offers, read from the fake CLIs: no model turn, no quota.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeModels,
  claudeSkills,
  codexSkills,
  listClaudeModels,
  listClaudeSkills,
  listCodexModels,
  listCodexSkills,
} from '../src/index.js';
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

describe('skill catalogs (ADR 0019)', () => {
  it('reads Codex’s enabled skills for a folder over skills/list', async () => {
    const skills = await listCodexSkills({
      executable: process.execPath,
      launcherArgs: [FAKE_CODEX, '--account=chatgpt'],
      baseEnv: testEnv(),
      cwd: 'F:/x',
    });
    expect(skills).toEqual([
      { name: 'tdd', description: 'Tests first', path: '/home/u/.codex/skills/tdd/SKILL.md' },
    ]);
  });

  it('reads Claude’s skills from its initialize response, leaving out its own commands', async () => {
    const skills = await listClaudeSkills({
      executable: process.execPath,
      launcherArgs: [FAKE_CLAUDE],
      baseEnv: testEnv(),
    });
    expect(skills).toEqual([
      { name: 'tdd', description: 'Test-driven development.' },
      { name: 'probe', description: 'A probe skill.' },
    ]);
  });

  it('tells skills by the tag of where they come from', () => {
    expect(
      claudeSkills({
        commands: [
          { name: 'a', description: 'From a plugin. (plugin:tools)' },
          { name: 'b', description: 'Synced. (claude.ai sync)' },
          { name: 'clear', description: 'Clear history (stays on disk, resumable with /resume)' },
          { name: 'c', description: 3 },
        ],
      }),
    ).toEqual([
      { name: 'a', description: 'From a plugin.' },
      { name: 'b', description: 'Synced.' },
    ]);
    expect(codexSkills({ data: [] })).toEqual([]);
    expect(codexSkills({ data: [{ skills: [{ name: 'x', description: 'd' }] }] })).toEqual([]);
  });
});
