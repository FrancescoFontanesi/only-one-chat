// The models each CLI offers, for the roles view (ADR 0012): read from the
// CLIs themselves (adapters: listCodexModels, listClaudeModels), with no model
// turn and no quota, once per window and again on request. Node only, no
// `vscode`: the sources are passed in.

import type { ModelInfo } from '@only-one-chat/adapters';
import type { Cli, ModelOption, ProviderCatalog } from '../webview/protocol.js';

export type ModelSource = () => Promise<readonly ModelInfo[]>;

const CLIS: readonly Cli[] = ['codex', 'claude', 'antigravity'];

export class ModelCatalog {
  private readonly entries = new Map<Cli, ProviderCatalog>(
    CLIS.map((cli) => [cli, { cli, status: 'loading', models: [] }]),
  );
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | undefined;
  private loaded = false;

  constructor(private readonly sources: Readonly<Record<Cli, ModelSource>>) {}

  /** Reads both CLIs; once, unless `again`. */
  load(again = false): Promise<void> {
    if (this.loading) return this.loading;
    if (this.loaded && !again) return Promise.resolve();
    for (const cli of CLIS) {
      this.entries.set(cli, { cli, status: 'loading', models: [] });
    }
    this.changed();
    this.loading = Promise.all(CLIS.map((cli) => this.read(cli))).then(() => {
      this.loading = undefined;
      this.loaded = true;
    });
    return this.loading;
  }

  private async read(cli: Cli): Promise<void> {
    try {
      const models: ModelOption[] = (await this.sources[cli]()).map((m) => ({
        id: m.id,
        name: m.name,
        efforts: [...m.efforts],
        defaultEffort: m.defaultEffort,
      }));
      this.entries.set(cli, { cli, status: 'ready', models });
    } catch (error) {
      this.entries.set(cli, {
        cli,
        status: 'unavailable',
        models: [],
        note: error instanceof Error ? error.message : String(error),
      });
    }
    this.changed();
  }

  snapshot(): ProviderCatalog[] {
    return CLIS.map((cli) => this.entries.get(cli) ?? { cli, status: 'loading', models: [] });
  }

  /** The model, once its CLI's catalog is read; undefined while unknown or missing. */
  find(cli: Cli, model: string): ModelOption | undefined {
    return this.entries.get(cli)?.models.find((m) => m.id === model);
  }

  /** True when the CLI's catalog is read and does not offer this model. */
  rejects(cli: Cli, model: string): boolean {
    const entry = this.entries.get(cli);
    return entry?.status === 'ready' && !entry.models.some((m) => m.id === model);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
