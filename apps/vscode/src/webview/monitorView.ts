import type * as vscode from 'vscode';
import type { MonitorStore } from '../session/monitor.js';
import { SidebarView } from './sidebarView.js';
import type { WebviewToHostMessage } from './protocol.js';

/** The activity view (ADR 0012): who works now and what passed between the agents. */
export class MonitorViewProvider extends SidebarView {
  static readonly viewType = 'onlyOneChat.monitor';

  constructor(
    context: vscode.ExtensionContext,
    private readonly monitor: MonitorStore,
  ) {
    super(context, 'monitor', 'Attività');
    const unsubscribe = monitor.onChange(() => {
      this.show();
    });
    this.own({ dispose: unsubscribe });
  }

  protected onMessage(message: WebviewToHostMessage): void {
    if (message.type === 'ready') this.show();
  }

  private show(): void {
    this.post({ type: 'monitor', monitor: this.monitor.snapshot() });
  }
}
