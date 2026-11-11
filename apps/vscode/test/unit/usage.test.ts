import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  providerOf,
  readAntigravityUsage,
  readCodexQuota,
  usageAlerts,
  UsageStore,
} from '../../src/session/usage.js';

const FAKE_CODEX = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'adapters',
  'test',
  'fixtures',
  'fake-app-server.mjs',
);

describe('usage store', () => {
  it('shows the subscriptions and the windows their CLIs reported', () => {
    const store = new UsageStore();
    let changes = 0;
    store.onChange(() => changes++);
    store.setProviders(['codex', 'claude']);
    store.setQuota('claude', { windows: [{ name: '5h', usedPercent: 12.5, resetsAt: 1 }] }, 1000);
    const [codex, claude] = store.snapshot();
    expect(codex).toMatchObject({ provider: 'codex', windows: [], updatedAt: null });
    expect(claude).toMatchObject({
      provider: 'claude',
      windows: [{ name: '5h', usedPercent: 12.5 }],
      updatedAt: 1000,
    });
    store.setNote('codex', 'Codex non trovato');
    expect(store.snapshot()[0]?.note).toBe('Codex non trovato');
    store.setProviders(['claude']);
    expect(store.snapshot().map((p) => p.provider)).toEqual(['claude']);
    expect(changes).toBe(4);
  });

  it('names the provider from the identity the adapter reports', () => {
    expect(providerOf('Codex via Headroom persistent proxy')).toBe('codex');
    expect(providerOf('Claude Code')).toBe('claude');
    expect(providerOf('Gemini')).toBeNull();
  });

  it('reads Codex windows through the app-server, without a model turn', async () => {
    const quota = await readCodexQuota(process.execPath, [FAKE_CODEX, '--account=chatgpt']);
    expect(quota?.windows.map((w) => w.name)).toEqual(['5h', 'weekly']);
  });
});

describe('usage warnings (ADR 0013)', () => {
  it('warns once per window and reset past the threshold, never at 0', () => {
    const seen = new Set<string>();
    const providers = [
      {
        provider: 'codex' as const,
        windows: [
          { name: '5h', usedPercent: 85, resetsAt: 100 },
          { name: 'weekly', usedPercent: 40, resetsAt: 900 },
        ],
        updatedAt: 1,
        note: '',
      },
    ];
    expect(usageAlerts(providers, 80, seen)).toEqual([
      'Codex: hai usato il 85% della finestra di 5 ore.',
    ]);
    expect(usageAlerts(providers, 80, seen)).toEqual([]);
    // A new window after the reset warns again.
    const next = providers.map((p) => ({
      ...p,
      windows: [{ name: '5h', usedPercent: 90, resetsAt: 200 }],
    }));
    expect(usageAlerts(next, 80, seen)).toHaveLength(1);
    expect(usageAlerts(next, 0, new Set())).toEqual([]);
  });

  it('reads Antigravity’s usage with agy, the first group on the dial, all of them in the note', async () => {
    const fake = FAKE_CODEX.replace('fake-app-server.mjs', 'fake-agy.mjs');
    const read = await readAntigravityUsage({ executable: process.execPath, launcherArgs: [fake] });
    expect(read?.quota.windows.map((w) => [w.name, Math.round(w.usedPercent)])).toEqual([
      ['weekly', 25],
      ['5h', 10],
    ]);
    expect(read?.note).toBe(
      'Mostra Gemini Models. Gemini Models: 5 ore 10%, settimana 25%. Claude and GPT models: 5 ore 0%, settimana —.',
    );
    expect(providerOf('Antigravity')).toBe('antigravity');
    const store = new UsageStore();
    store.setProviders(['antigravity']);
    if (read) store.setQuota('antigravity', read.quota, 1, read.note);
    expect(store.snapshot()[0]?.note).toContain('senza consumare quota');
    expect(usageAlerts(store.snapshot(), 20, new Set())).toEqual([
      'Antigravity: hai usato il 25% della finestra di settimana.',
    ]);
  });
});
