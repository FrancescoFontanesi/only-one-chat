// The manifest's security settings (ADR 0050, security.md T3, T11): what a
// repository's own settings can never set, and what an untrusted folder keeps
// from the workspace. Read statically from package.json and settings.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = join(import.meta.dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as {
  capabilities: {
    untrustedWorkspaces: { supported: unknown; restrictedConfigurations: string[] };
  };
  contributes: { configuration: { properties: Record<string, { scope?: string }> } };
};
const properties = manifest.contributes.configuration.properties;
const trust = manifest.capabilities.untrustedWorkspaces;

/** Executables, their arguments, commands, and instructions to the agents. */
const MACHINE = [
  'onlyOneChat.codexPath',
  'onlyOneChat.claudePath',
  'onlyOneChat.antigravityPath',
  'onlyOneChat.allowedCommands',
  'onlyOneChat.verifyCommand',
  'onlyOneChat.leader.instructions',
  'onlyOneChat.implementer.instructions',
  'onlyOneChat.reviewer.instructions',
];

describe('extension manifest', () => {
  it('keeps paths, commands and instructions to the user’s settings (machine scope)', () => {
    for (const key of MACHINE) expect([key, properties[key]?.scope]).toEqual([key, 'machine']);
    // Any other path or command setting added later must be machine-scoped too.
    const named = Object.keys(properties).filter((key) => /Path$|Command|instructions$/.test(key));
    for (const key of named) expect([key, properties[key]?.scope]).toEqual([key, 'machine']);
  });

  it('opens limited in an untrusted folder, restricting what could run or hide changes', () => {
    expect(trust.supported).toBe('limited');
    const restricted = new Set(trust.restrictedConfigurations);
    for (const key of [
      'onlyOneChat.codexPath',
      'onlyOneChat.claudePath',
      'onlyOneChat.antigravityPath',
      'onlyOneChat.allowedCommands',
      'onlyOneChat.verifyCommand',
      'onlyOneChat.nodes',
      'onlyOneChat.ignoredPaths',
    ]) {
      expect(restricted.has(key), key).toBe(true);
    }
    for (const key of restricted) expect(properties[key], key).toBeDefined();
  });

  it('lists on the settings page only settings the manifest declares', () => {
    const source = readFileSync(join(app, 'src', 'settings.ts'), 'utf8');
    const keys = [...source.matchAll(/\bkey: '([\w.]+)'/g)].map((m) => m[1] ?? '');
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(properties[`onlyOneChat.${key}`], key).toBeDefined();
  });
});
