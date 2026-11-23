// Where each CLI is installed, for the settings page's DETECT and SELECT
// (ADR 0025): the same search the extension makes before a turn
// (resolveNativeExecutable), over the PATH and the places the provider's own
// VS Code extension keeps its CLI; or over a folder the user picks, and its
// `bin`. Nothing is run: a path is taken only if an executable is there.

import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getEnv, resolveNativeExecutable } from '@only-one-chat/adapters';
import type { Cli } from './shared/protocol.js';

/** Each CLI's command, its name for the messages, the extension that may bundle it. */
const CLIS: Readonly<Record<Cli, { command: string; label: string; bundled: () => string[] }>> = {
  codex: {
    command: 'codex',
    label: 'Codex',
    // openai.chatgpt: bin/<platform>/codex(.exe)
    bundled: () => subfolders(extensionPath('openai.chatgpt'), 'bin'),
  },
  claude: {
    command: 'claude',
    label: 'Claude Code',
    // anthropic.claude-code: resources/native-binary/claude(.exe)
    bundled: () => {
      const root = extensionPath('anthropic.claude-code');
      return root ? [path.join(root, 'resources', 'native-binary')] : [];
    },
  },
  antigravity: {
    command: 'agy',
    label: 'Antigravity',
    // Its installer's own folder, when it is not on the PATH.
    bundled: () => {
      const local = getEnv(process.env, 'LOCALAPPDATA');
      return local ? [path.join(local, 'agy', 'bin')] : [];
    },
  },
};

function extensionPath(id: string): string | undefined {
  return vscode.extensions.getExtension(id)?.extensionPath;
}

/** The folders under `root/sub`, e.g. one per platform. */
function subfolders(root: string | undefined, sub: string): string[] {
  if (!root) return [];
  const base = path.join(root, sub);
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name));
  } catch {
    return [];
  }
}

/** The executable of `cli` in these folders, in order; undefined when none has it. */
async function findIn(cli: Cli, folders: readonly string[]): Promise<string | undefined> {
  const { command, label } = CLIS[cli];
  try {
    return await resolveNativeExecutable(command, label, {
      env: { PATH: folders.join(path.delimiter) },
    });
  } catch {
    return undefined;
  }
}

/** DETECT: the PATH first, then where the provider's extension or installer keeps it. */
export function detectCli(cli: Cli): Promise<string | undefined> {
  const onPath = (getEnv(process.env, 'PATH') ?? '').split(path.delimiter).filter(Boolean);
  return findIn(cli, [...onPath, ...CLIS[cli].bundled()]);
}

/** SELECT: the executable in a folder the user picked, or in its `bin`. */
export function findInFolder(cli: Cli, folder: string): Promise<string | undefined> {
  return findIn(cli, [folder, path.join(folder, 'bin')]);
}

export function cliLabel(cli: Cli): string {
  return CLIS[cli].label;
}
