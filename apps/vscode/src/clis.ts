// How the extension launches each CLI: the user's own executable, or in fake
// mode (development host only) the adapters' fake CLIs from the repository,
// which use no model and no quota.

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  resolveClaudeExecutable,
  resolveCodexExecutable,
  resolveNativeExecutable,
} from '@only-one-chat/adapters';
import type { Cli } from './webview/protocol.js';

export interface CliLaunch {
  readonly executable: string;
  /** Arguments before the CLI's own: the fake CLI's script and flags. */
  readonly launcherArgs: readonly string[];
}

/** Fake CLIs instead of the real ones: development host only, no quota. */
export function isFake(context: vscode.ExtensionContext): boolean {
  return (
    context.extensionMode === vscode.ExtensionMode.Development &&
    vscode.workspace.getConfiguration('onlyOneChat').get<boolean>('fake') === true
  );
}

/** Resolves a CLI; throws when the executable is not found. */
export async function cliLaunch(context: vscode.ExtensionContext, cli: Cli): Promise<CliLaunch> {
  if (isFake(context)) {
    const fixtures = path.join(
      context.extensionPath,
      '..',
      '..',
      'packages',
      'adapters',
      'test',
      'fixtures',
    );
    const script = {
      codex: [path.join(fixtures, 'fake-app-server.mjs'), '--account=chatgpt'],
      claude: [path.join(fixtures, 'fake-claude.mjs'), '--echo'],
      antigravity: [path.join(fixtures, 'fake-agy.mjs')],
    }[cli];
    return { executable: 'node', launcherArgs: script };
  }
  const settings = vscode.workspace.getConfiguration('onlyOneChat');
  const configuredPath = settings.get<string>(`${cli}Path`) ?? '';
  const executable =
    cli === 'codex'
      ? await resolveCodexExecutable({ configuredPath })
      : cli === 'claude'
        ? await resolveClaudeExecutable({ configuredPath })
        : await resolveNativeExecutable('agy', 'Antigravity', { configuredPath });
  return { executable, launcherArgs: [] };
}
