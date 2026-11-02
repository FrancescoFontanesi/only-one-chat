import * as path from 'node:path';
import * as vscode from 'vscode';
import { CheckpointStore } from '../session/checkpoints.js';

/** Read-only documents with a recorded content, for VS Code's diff (ADR 0014). */
export const CHECKPOINT_SCHEME = 'only-one-chat-checkpoint';

const ID = /^[a-z0-9-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;

/** The folder of a chat's checkpoints in the extension's storage. */
export function checkpointsRoot(context: vscode.ExtensionContext, chatId: string): string {
  const storage = context.storageUri ?? context.globalStorageUri;
  return vscode.Uri.joinPath(storage, 'checkpoints', chatId).fsPath;
}

/**
 * A recorded content as a document: `<scheme>:/<chat>/<hash>/<file path>`, the
 * file's own name last so the editor picks its language. `empty` stands for a
 * file that did not exist.
 */
export function checkpointUri(chatId: string, content: string | null, file: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: CHECKPOINT_SCHEME,
    path: `/${chatId}/${content ?? 'empty'}/${file}`,
  });
}

export class CheckpointContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const [, chatId = '', content = ''] = uri.path.split('/');
    if (content === 'empty') return '';
    if (!ID.test(chatId) || !HASH.test(content)) throw new Error('not a recorded content');
    // The store reads its own content folder only; the folder it works on plays no part here.
    const store = new CheckpointStore(checkpointsRoot(this.context, chatId), path.sep);
    return store.content(content).toString('utf8');
  }
}
