// VS Code notifications (ADR 0013), each behind its setting: a usage window
// past the threshold; an agent waiting for the user, or a message done, while
// the chat is not in view.

import * as vscode from 'vscode';
import { usageAlerts, type UsageStore } from './session/usage.js';

function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('onlyOneChat').get<T>(key) ?? fallback;
}

/** Warns once per window and reset when a subscription's usage passes the threshold. */
export function usageWarnings(usage: UsageStore, openChat: () => void): vscode.Disposable {
  const seen = new Set<string>();
  const unsubscribe = usage.onChange(() => {
    const threshold = setting('notifications.usageThreshold', 80);
    for (const alert of usageAlerts(usage.snapshot(), threshold, seen)) {
      void vscode.window.showWarningMessage(alert, 'Apri la chat').then((answer) => {
        if (answer) openChat();
      });
    }
  });
  return { dispose: unsubscribe };
}

/** Tells the user, if they want it, about the chat while it is not in view. */
export function notifyChat(kind: 'waiting' | 'turnEnd', text: string, reveal: () => void): void {
  if (!setting(`notifications.${kind}`, kind === 'waiting')) return;
  const show =
    kind === 'waiting' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  void show(text, 'Apri la chat').then((answer) => {
    if (answer) reveal();
  });
}
