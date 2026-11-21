import * as vscode from 'vscode';
import { ChatHistory } from '../session/history.js';
import type { VerificationEvidence } from '../../../../packages/runtime/src/verification.js';
import { checkpointUri } from './checkpointContent.js';

export const VERIFICATION_SCHEME = 'only-one-chat-verification';
const ID = /^[a-z0-9-]{1,64}$/;
const changed = new vscode.EventEmitter<vscode.Uri>();

export function refreshVerification(chat: string, id: string): void {
  changed.fire(verificationUri(chat, id));
}

export function verificationUri(chat: string, id: string): vscode.Uri {
  return vscode.Uri.from({ scheme: VERIFICATION_SCHEME, path: `/${chat}/${id}/verification.txt` });
}

/** Read-only evidence resolved solely through recorded chat and work IDs. */
export class VerificationContentProvider
  implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider
{
  readonly onDidChange = changed.event;
  constructor(private readonly context: vscode.ExtensionContext) {}

  private read(uri: vscode.Uri): { chat: string; evidence: VerificationEvidence } {
    const [, chat = '', id = '', filename = ''] = uri.path.split('/');
    if (
      uri.path.split('/').length !== 4 ||
      !ID.test(chat) ||
      !ID.test(id) ||
      filename !== 'verification.txt' ||
      uri.query ||
      uri.fragment
    ) {
      throw new Error('Invalid verification reference');
    }
    const storage = this.context.storageUri ?? this.context.globalStorageUri;
    const record = new ChatHistory(vscode.Uri.joinPath(storage, 'chats').fsPath).load(chat);
    const update = record?.updates.findLast(
      (item) => item.type === 'verification' && item.evidence.id === id,
    );
    if (update?.type !== 'verification') throw new Error('Verification evidence unavailable');
    const evidence = update.evidence;
    return { chat, evidence };
  }

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const { chat, evidence } = this.read(document.uri);
    return [
      { hash: evidence.reportHash, file: 'junit.xml' },
      { hash: evidence.baselineReportHash, file: 'baseline-junit.xml' },
    ].flatMap(({ hash, file }) => {
      if (!hash) return [];
      const target = checkpointUri(chat, hash, file);
      const text = target.toString();
      const start = document.getText().indexOf(text);
      if (start < 0) return [];
      return [
        new vscode.DocumentLink(
          new vscode.Range(document.positionAt(start), document.positionAt(start + text.length)),
          target,
        ),
      ];
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const { chat, evidence } = this.read(uri);
    return [
      `Verification: ${evidence.status}`,
      `Red-green: ${evidence.comparison}`,
      `Selected by: ${evidence.origin}`,
      `Reviewer verdict: ${evidence.reviewVerdict ?? 'unavailable'}`,
      `Corrections: ${String(evidence.round ?? 0)}/${String(evidence.budget ?? 0)}`,
      evidence.selection
        ? `Criterion: ${evidence.selection.criterion}\nTest: ${evidence.selection.className} / ${evidence.selection.name}\nFiles: ${evidence.selection.files.join(', ')}`
        : '',
      evidence.summary,
      evidence.reportHash
        ? `Final JUnit report: ${checkpointUri(chat, evidence.reportHash, 'junit.xml').toString()}`
        : '',
      evidence.baselineReportHash
        ? `Baseline JUnit report: ${checkpointUri(chat, evidence.baselineReportHash, 'baseline-junit.xml').toString()}`
        : '',
      evidence.detail,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}
