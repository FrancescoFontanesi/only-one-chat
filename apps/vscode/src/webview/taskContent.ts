import * as vscode from 'vscode';
import { ChatHistory } from '../session/history.js';

export const TASK_SCHEME = 'only-one-chat-task';
const ID = /^[a-z0-9-]{1,64}$/;
const changed = new vscode.EventEmitter<vscode.Uri>();

export function refreshTask(chat: string, id: string): void {
  changed.fire(taskUri(chat, id));
}

export function taskUri(chat: string, task: string): vscode.Uri {
  return vscode.Uri.from({ scheme: TASK_SCHEME, path: `/${chat}/${task}/task.txt` });
}

/** Native recovery context resolved through recorded identifiers only. */
export class TaskContentProvider implements vscode.TextDocumentContentProvider {
  readonly onDidChange = changed.event;
  constructor(private readonly context: vscode.ExtensionContext) {}
  provideTextDocumentContent(uri: vscode.Uri): string {
    const parts = uri.path.split('/');
    const [, chat = '', id = '', file = ''] = parts;
    if (
      parts.length !== 4 ||
      !ID.test(chat) ||
      !ID.test(id) ||
      file !== 'task.txt' ||
      uri.query ||
      uri.fragment
    )
      throw new Error('Invalid task reference');
    const storage = this.context.storageUri ?? this.context.globalStorageUri;
    const record = new ChatHistory(vscode.Uri.joinPath(storage, 'chats').fsPath).load(chat);
    if (id === 'task-invalid')
      return record?.taskInvalid
        ? 'The task record is invalid. Inspect the chat history and cancel the task before starting new work.'
        : 'The malformed task was cancelled. Its chat history remains available.';
    const task =
      record?.task?.id === id
        ? record.task
        : record?.lastCompletedTask?.id === id
          ? record.lastCompletedTask
          : undefined;
    if (!task) throw new Error('Recorded task unavailable');
    return [
      `Task ${task.id}`,
      `Next step: ${task.progress.step}\nOperation without committed outcome: ${String(task.progress.inFlight)}\nCorrections: ${String(task.progress.used)}/${String(task.progress.limit)}`,
      `Approved request\n${task.progress.brief}`,
      `Latest report\n${task.progress.work?.text ?? 'Unavailable'}`,
      `Open findings\n${task.progress.findings ?? 'None recorded'}`,
      task.progress.result?.review ?? task.progress.answer?.text ?? '',
      task.progress.result?.facts ?? '',
      `Workspace checkpoint: ${task.checkpoint ?? 'unavailable'}\nOriginal baseline: ${task.verification?.baseline ?? 'unavailable'}`,
      `Recorded configuration\n${task.configuration}`,
    ].join('\n\n');
  }
}
