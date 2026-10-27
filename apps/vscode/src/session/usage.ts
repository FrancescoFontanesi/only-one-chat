// What the usage view shows: the subscriptions in use, with the usage windows
// their CLIs report and what the current chat has used. Sources that use no
// quota only (docs/ui-primitives.md): Codex's account/rateLimits/read, and the
// rate limit Claude reports at each turn; never credential or session files.
// Node only, no `vscode`.

import { codexQuota, connectCodex, type QuotaSnapshot } from '@only-one-chat/adapters';
import type { ProviderUsage, TurnUsageSummary } from '../webview/protocol.js';

type Provider = 'codex' | 'claude';

const NOTES: Record<Provider, string> = {
  codex: 'Letto da Codex senza consumare quota, ogni 2 minuti e dopo ogni turno.',
  claude:
    'Aggiornato a ogni turno di Claude: non si può leggere senza un turno, quindi è l’ultimo valore visto.',
};

interface Entry {
  windows: QuotaSnapshot['windows'];
  updatedAt: number | null;
  note: string;
  chat: { context: number; output: number; costUsd: number };
}

export class UsageStore {
  private readonly entries = new Map<Provider, Entry>();
  private readonly listeners = new Set<() => void>();

  /** The subscriptions shown: the CLIs of the configured roles. */
  setProviders(providers: readonly Provider[]): void {
    for (const provider of providers) {
      if (!this.entries.has(provider)) {
        this.entries.set(provider, {
          windows: [],
          updatedAt: null,
          note: NOTES[provider],
          chat: { context: 0, output: 0, costUsd: 0 },
        });
      }
    }
    for (const provider of [...this.entries.keys()]) {
      if (!providers.includes(provider)) this.entries.delete(provider);
    }
    this.changed();
  }

  setQuota(provider: Provider, quota: QuotaSnapshot, at = Date.now()): void {
    const entry = this.entries.get(provider);
    if (!entry) return;
    entry.windows = quota.windows;
    entry.updatedAt = at;
    entry.note = NOTES[provider];
    this.changed();
  }

  /** Why the windows could not be read, e.g. no Codex executable. */
  setNote(provider: Provider, note: string): void {
    const entry = this.entries.get(provider);
    if (!entry) return;
    entry.note = note;
    this.changed();
  }

  addTurn(provider: Provider, usage: TurnUsageSummary): void {
    const entry = this.entries.get(provider);
    if (!entry) return;
    entry.chat.context += usage.context;
    entry.chat.output += usage.output;
    entry.chat.costUsd += usage.costUsd ?? 0;
    this.changed();
  }

  resetChat(): void {
    for (const entry of this.entries.values()) {
      entry.chat = { context: 0, output: 0, costUsd: 0 };
    }
    this.changed();
  }

  snapshot(): ProviderUsage[] {
    return [...this.entries].map(([provider, entry]) => ({
      provider,
      windows: entry.windows,
      updatedAt: entry.updatedAt,
      note: entry.note,
      chat: { ...entry.chat },
    }));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The provider of a turn, from the identity the adapter reported ("Codex via …", "Claude Code"). */
export function providerOf(identityProvider: string): Provider | null {
  if (identityProvider.startsWith('Codex')) return 'codex';
  if (identityProvider.startsWith('Claude')) return 'claude';
  return null;
}

/** Codex's usage windows, read through the app-server: no model turn, no quota. */
export async function readCodexQuota(
  executable: string,
  launcherArgs: readonly string[] = [],
): Promise<QuotaSnapshot | null> {
  const session = await connectCodex({
    executable,
    launcherArgs,
    clientInfo: { name: 'only-one-chat', version: '0.0.1' },
  });
  try {
    const result = (await session.request('account/rateLimits/read', {})) as {
      rateLimits?: unknown;
    };
    return codexQuota(result.rateLimits);
  } finally {
    await session.close();
  }
}
