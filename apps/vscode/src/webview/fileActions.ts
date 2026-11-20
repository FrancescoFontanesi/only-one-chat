// The file actions of the chat: a path the thread links, a changes card, the
// checkpoints and the save before a message. Plain functions: what they need of
// the panel comes in as arguments.

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CheckpointStore } from '../session/checkpoints.js';
import { insideFolder } from '../session/mentions.js';
import { checkpointUri } from './checkpointContent.js';
import type { ThreadUpdate } from './protocol.js';

/** What reviewing and restoring need of the panel: the chat shown, and ways to answer in it. */
export interface FileHost {
  readonly recordId: string;
  readonly updates: readonly ThreadUpdate[];
  /** The checkpoints of the chat shown; undefined without an open folder. */
  readonly store: CheckpointStore | undefined;
  /** A message is running. */
  readonly busy: boolean;
  notice(level: 'info' | 'warn' | 'error', text: string): void;
  emit(update: ThreadUpdate): void;
  noteFiles(note: string): void;
}

/**
 * A path the thread links (ADR 0018), at its lines: only inside the folder,
 * after its links are resolved; a folder is shown in the explorer.
 */
export async function openFile(
  cwd: string | null,
  file: string,
  from: number | undefined,
  to: number | undefined,
  warn: (text: string) => void,
): Promise<void> {
  // An absolute path too, if it is in the folder: the agents' links use them.
  const found = cwd ? insideFolder(cwd, file.replace(/\/+$/, '')) : undefined;
  if (!found) {
    warn(`${file} is outside the open folder.`);
    return;
  }
  const uri = vscode.Uri.file(found.full);
  if (found.folder) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }
  const start = from !== undefined ? from - 1 : undefined;
  const end = to !== undefined ? to - 1 : start;
  await vscode.window.showTextDocument(uri, {
    preview: true,
    ...(start !== undefined && end !== undefined
      ? { selection: new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER) }
      : {}),
  });
}

/**
 * A file of a changes card (ADR 0014). The file is looked up in the card the
 * chat recorded: the webview names it, but only a recorded path is touched.
 */
export async function reviewFile(
  host: FileHost,
  id: string,
  file: string,
  action: 'diff' | 'accept' | 'reject',
): Promise<void> {
  const card = host.updates.find(
    (u): u is Extract<ThreadUpdate, { type: 'changes' }> => u.type === 'changes' && u.id === id,
  );
  const change = card?.files.find((f) => f.path === file);
  const store = host.store;
  if (!change || !store) return;
  if (action === 'diff') {
    await vscode.commands.executeCommand(
      'vscode.diff',
      checkpointUri(host.recordId, change.before, change.path),
      checkpointUri(host.recordId, change.after, change.path),
      `${change.path} · before ↔ after the message`,
      { preview: true },
    );
    return;
  }
  if (action === 'accept') {
    host.emit({ type: 'change_decided', id, path: file, decision: 'accepted' });
    return;
  }
  if (host.busy) {
    host.notice('warn', 'Wait for the current message to finish before reverting the file.');
    return;
  }
  try {
    if (store.current(change.path) !== change.after) {
      const answer = await vscode.window.showWarningMessage(
        `${change.path} changed again after the message. Revert it to its earlier version and discard those later changes?`,
        { modal: true },
        'Revert File',
      );
      if (!answer) return;
    }
    store.put(change.path, change.before);
  } catch (error) {
    host.notice(
      'error',
      `Could not revert the file: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  host.emit({ type: 'change_decided', id, path: file, decision: 'rejected' });
  host.noteFiles(
    `${change.path}: ${change.kind === 'added' ? 'removed (new file)' : 'restored to its state before the message'}`,
  );
}

/** Brings the folder back to before a message; the conversation stays as it is. */
export async function restoreCheckpoint(host: FileHost, id: string): Promise<void> {
  const store = host.store;
  const checkpoint = store?.load(id);
  if (!store || !checkpoint) {
    host.notice('error', 'This message’s checkpoint is no longer available.');
    return;
  }
  if (host.busy) {
    host.notice('warn', 'Wait for the current message to finish before restoring the checkpoint.');
    return;
  }
  const answer = await vscode.window.showWarningMessage(
    'Restore the workspace files to their state before this message? This discards all later file changes, including manual edits. The conversation stays intact. Changes outside the workspace are unaffected.',
    { modal: true },
    'Restore',
  );
  if (!answer) return;
  let paths: string[];
  try {
    paths = store.restore(checkpoint);
  } catch (error) {
    host.notice(
      'error',
      `Could not restore the checkpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  host.emit({
    type: 'notice',
    level: 'info',
    text:
      paths.length === 0
        ? 'The workspace already matches the checkpoint for this message.'
        : [
            'Workspace files restored to their state before the message:',
            ...paths.map((p) => `- ${p}`),
          ].join('\n'),
  });
  if (paths.length > 0) {
    host.noteFiles(
      `workspace files were restored to their state before an earlier message (${paths.join(', ')})`,
    );
  }
}

/**
 * The agents read and change the files on disk: the folder's unsaved files
 * are saved first, or not, as onlyOneChat.saveBeforeSend says. False: the
 * user cancelled the message.
 */
export async function saveBeforeSend(cwd: string | null): Promise<boolean> {
  if (!cwd) return true;
  const policy = vscode.workspace.getConfiguration('onlyOneChat').get<string>('saveBeforeSend');
  if (policy === 'never') return true;
  const inside = (file: string) => {
    const relative = path.relative(cwd, file);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const dirty = vscode.workspace.textDocuments.filter(
    (document) => document.isDirty && document.uri.scheme === 'file' && inside(document.uri.fsPath),
  );
  if (dirty.length === 0) return true;
  if (policy !== 'always') {
    const answer = await vscode.window.showWarningMessage(
      `${String(dirty.length)} unsaved files in the workspace. Agents read the versions on disk.`,
      { modal: true },
      'Save and Send',
      'Send Without Saving',
    );
    if (answer === undefined) return false;
    if (answer === 'Send Without Saving') return true;
  }
  await Promise.all(dirty.map((document) => document.save()));
  return true;
}
