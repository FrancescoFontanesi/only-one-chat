// Codex's usage windows, read through its app-server with no model turn and
// no quota (ADR 0012): when the chat opens, every two minutes while it is in
// view, and on request. Claude's come with its turns.

import type * as vscode from 'vscode';
import { cliLaunch } from './clis.js';
import { readCodexQuota, type UsageStore } from './session/usage.js';

/** How often Codex's usage windows are read while the chat is in view. */
export const CODEX_INTERVAL_MS = 120_000;

export class CodexUsageReader {
  private reading = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly usage: UsageStore,
  ) {}

  async refresh(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const launch = await cliLaunch(this.context, 'codex');
      const quota = await readCodexQuota(launch.executable, launch.launcherArgs);
      if (quota) this.usage.setQuota('codex', quota);
      else this.usage.setNote('codex', 'Codex non ha riportato limiti di utilizzo.');
    } catch (error) {
      this.usage.setNote(
        'codex',
        `Lettura non riuscita: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.reading = false;
    }
  }
}
