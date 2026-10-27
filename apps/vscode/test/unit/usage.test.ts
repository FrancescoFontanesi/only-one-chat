import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { providerOf, readCodexQuota, UsageStore } from '../../src/session/usage.js';

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
  it('shows the configured subscriptions, their windows and what the chat used', () => {
    const store = new UsageStore();
    let changes = 0;
    store.onChange(() => changes++);
    store.setProviders(['codex', 'claude']);
    store.setQuota('claude', { windows: [{ name: '5h', usedPercent: 12.5, resetsAt: 1 }] }, 1000);
    store.addTurn('claude', { context: 30_000, output: 900, costUsd: 0.02, durationMs: 5 });
    store.addTurn('claude', { context: 10_000, output: 100, costUsd: null, durationMs: 5 });
    const [codex, claude] = store.snapshot();
    expect(codex).toMatchObject({ provider: 'codex', windows: [], updatedAt: null });
    expect(claude).toMatchObject({
      provider: 'claude',
      windows: [{ name: '5h', usedPercent: 12.5 }],
      updatedAt: 1000,
      chat: { context: 40_000, output: 1000, costUsd: 0.02 },
    });
    store.resetChat();
    expect(store.snapshot()[1]?.chat).toEqual({ context: 0, output: 0, costUsd: 0 });
    store.setProviders(['claude']);
    expect(store.snapshot().map((p) => p.provider)).toEqual(['claude']);
    expect(changes).toBe(6);
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
