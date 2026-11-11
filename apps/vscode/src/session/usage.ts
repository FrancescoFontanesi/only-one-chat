// What the usage view shows: the subscriptions, with the usage windows their
// CLIs report. Sources that use no
// quota only (docs/ui-primitives.md): Codex's account/rateLimits/read, the
// rate limit Claude reports at each turn, and Antigravity's `agy -p /quota`
// (ADR 0023); never credential or session files.
// Node only, no `vscode`.

import {
  codexQuota,
  connectCodex,
  readAntigravityQuota,
  type AgyOptions,
  type QuotaSnapshot,
} from '@only-one-chat/adapters';
import type { Cli, ProviderUsage } from '../webview/protocol.js';

type Provider = Cli;

const NOTES: Record<Provider, string> = {
  codex: 'Letto da Codex senza consumare quota, ogni 2 minuti e dopo ogni turno.',
  claude:
    'Aggiornato a ogni turno di Claude: non si può leggere senza un turno, quindi è l’ultimo valore visto.',
  antigravity:
    'Letto da agy (/quota) senza consumare quota, ogni 2 minuti e dopo ogni turno di un nodo.',
};

const NAMES: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  antigravity: 'Antigravity',
};

interface Entry {
  windows: QuotaSnapshot['windows'];
  updatedAt: number | null;
  note: string;
}

export class UsageStore {
  private readonly entries = new Map<Provider, Entry>();
  private readonly listeners = new Set<() => void>();

  /** The subscriptions shown. */
  setProviders(providers: readonly Provider[]): void {
    for (const provider of providers) {
      if (!this.entries.has(provider)) {
        this.entries.set(provider, {
          windows: [],
          updatedAt: null,
          note: NOTES[provider],
        });
      }
    }
    for (const provider of [...this.entries.keys()]) {
      if (!providers.includes(provider)) this.entries.delete(provider);
    }
    this.changed();
  }

  /** `note`: what the windows leave out, before where they come from. */
  setQuota(provider: Provider, quota: QuotaSnapshot, at = Date.now(), note?: string): void {
    const entry = this.entries.get(provider);
    if (!entry) return;
    entry.windows = quota.windows;
    entry.updatedAt = at;
    entry.note = note ? `${note} ${NOTES[provider]}` : NOTES[provider];
    this.changed();
  }

  /** Why the windows could not be read, e.g. no Codex executable. */
  setNote(provider: Provider, note: string): void {
    const entry = this.entries.get(provider);
    if (!entry) return;
    entry.note = note;
    this.changed();
  }

  snapshot(): ProviderUsage[] {
    return [...this.entries].map(([provider, entry]) => ({
      provider,
      windows: entry.windows,
      updatedAt: entry.updatedAt,
      note: entry.note,
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
  if (identityProvider.startsWith('Antigravity')) return 'antigravity';
  return null;
}

/**
 * Antigravity's usage windows (ADR 0023), from `agy -p /quota`: no model turn,
 * no quota, the login inside agy. Its models share limits by group; the dial
 * shows the first group's (Gemini), the note every group's.
 */
export async function readAntigravityUsage(
  options: AgyOptions,
): Promise<{ quota: QuotaSnapshot; note: string } | null> {
  const groups = await readAntigravityQuota(options);
  const first = groups[0];
  if (!first) return null;
  const used = (windows: QuotaSnapshot['windows'], name: string) => {
    const window = windows.find((w) => w.name === name);
    return window ? `${String(Math.round(window.usedPercent))}%` : '—';
  };
  const note = groups
    .map(
      (g) => `${g.name}: 5 ore ${used(g.windows, '5h')}, settimana ${used(g.windows, 'weekly')}.`,
    )
    .join(' ');
  return { quota: { windows: first.windows }, note: `Mostra ${first.name}. ${note}` };
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

/**
 * The usage windows past the threshold not warned about yet, once per window
 * and reset: `seen` keeps what was already warned.
 */
export function usageAlerts(
  providers: readonly ProviderUsage[],
  threshold: number,
  seen: Set<string>,
): string[] {
  if (threshold <= 0) return [];
  const alerts: string[] = [];
  for (const provider of providers) {
    for (const window of provider.windows) {
      if (window.usedPercent < threshold) continue;
      const key = `${provider.provider}:${window.name}:${String(window.resetsAt)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = NAMES[provider.provider];
      const span = window.name === '5h' ? '5 ore' : 'settimana';
      alerts.push(
        `${name}: hai usato il ${String(Math.round(window.usedPercent))}% della finestra di ${span}.`,
      );
    }
  }
  return alerts;
}
