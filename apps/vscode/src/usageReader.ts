// The usage windows read with no model turn and no quota (ADR 0012, 0023):
// Codex's through its app-server, Antigravity's with `agy -p /quota` when a
// node runs on it; when the chat opens, every two minutes while it is in
// view, and on request. Claude's come with its turns.

import type * as vscode from 'vscode';
import { cliLaunch } from './clis.js';
import { readAntigravityUsage, readCodexQuota, type UsageStore } from './session/usage.js';

/** How often the usage windows are read while the chat is in view. */
export const CODEX_INTERVAL_MS = 120_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class UsageReader {
  private reading = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly usage: UsageStore,
    /** Whether a node runs on Antigravity: otherwise agy is not asked. */
    private readonly usesAntigravity: () => boolean,
  ) {}

  async refresh(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      await Promise.all([this.codex(), this.antigravity()]);
    } finally {
      this.reading = false;
    }
  }

  private async codex(): Promise<void> {
    try {
      const launch = await cliLaunch(this.context, 'codex');
      const quota = await readCodexQuota(launch.executable, launch.launcherArgs);
      if (quota) this.usage.setQuota('codex', quota);
      else this.usage.setNote('codex', 'Codex non ha riportato limiti di utilizzo.');
    } catch (error) {
      this.usage.setNote('codex', `Lettura non riuscita: ${message(error)}`);
    }
  }

  private async antigravity(): Promise<void> {
    if (!this.usesAntigravity()) {
      this.usage.setNote('antigravity', 'Letto quando un nodo usa Antigravity.');
      return;
    }
    try {
      const launch = await cliLaunch(this.context, 'antigravity');
      const read = await readAntigravityUsage(launch);
      if (read) this.usage.setQuota('antigravity', read.quota, Date.now(), read.note);
      else this.usage.setNote('antigravity', 'Antigravity non ha riportato limiti di utilizzo.');
    } catch (error) {
      this.usage.setNote('antigravity', `Lettura non riuscita: ${message(error)}`);
    }
  }
}
