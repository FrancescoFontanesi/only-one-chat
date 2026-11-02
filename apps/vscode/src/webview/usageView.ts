import type * as vscode from 'vscode';
import { cliLaunch } from '../clis.js';
import { readCodexQuota, type UsageStore } from '../session/usage.js';
import { SidebarView } from './sidebarView.js';
import type { WebviewToHostMessage } from './protocol.js';

/** How often Codex's usage windows are read while the view is visible. */
const CODEX_INTERVAL_MS = 120_000;

/** The usage view (ADR 0012): one table, the 5-hour and weekly windows of each subscription. */
export class UsageViewProvider extends SidebarView {
  static readonly viewType = 'onlyOneChat.usage';

  private timer: NodeJS.Timeout | undefined;
  private reading = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly usage: UsageStore,
  ) {
    super(context, 'usage', 'Utilizzo');
    const unsubscribe = usage.onChange(() => {
      this.show();
    });
    this.own({ dispose: unsubscribe });
  }

  protected onMessage(message: WebviewToHostMessage): void {
    if (message.type === 'ready') {
      this.show();
      void this.refreshCodex();
    } else if (message.type === 'refreshUsage') {
      void this.refreshCodex();
    }
  }

  /** Codex is read on a timer only while the view is visible. */
  protected override onVisibility(visible: boolean): void {
    clearInterval(this.timer);
    this.timer = visible
      ? setInterval(() => void this.refreshCodex(), CODEX_INTERVAL_MS)
      : undefined;
  }

  /** Reads Codex's usage windows: no model turn, no quota. */
  async refreshCodex(): Promise<void> {
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

  private show(): void {
    this.post({ type: 'usage', providers: this.usage.snapshot() });
  }

  override dispose(): void {
    clearInterval(this.timer);
    super.dispose();
  }
}
