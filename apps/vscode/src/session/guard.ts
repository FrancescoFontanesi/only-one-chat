// The reviewer runs commands and writes tests in the folder, but never changes
// the code it judges (ADR 0029): the implementer owns the code, the reviewer
// suggests. The runtime holds it to that whatever the provider's permissions:
// the folder is recorded before each reviewer turn and, after it, every file
// the turn changed that is not a test is put back as it was. Node only, no
// `vscode`.

import type { CheckpointStore } from './checkpoints.js';
import { isTestFile } from './shortcuts.js';

/**
 * Records the folder before a reviewer turn; the function it returns puts back
 * what the turn changed outside the tests, and says what, or '' for nothing.
 * Null when the folder cannot be recorded: the reviewer must then not write.
 */
export function guardReviewerTurn(store: CheckpointStore, id: string): (() => string) | null {
  const before = store.take(id);
  if (!before) return null;
  return () => {
    const review = store.review(before);
    if (!review) return 'The runtime could not read the workspace after the reviewer’s turn.';
    const restored: string[] = [];
    const kept: string[] = [];
    for (const file of review.files) {
      if (isTestFile(file.path)) {
        kept.push(file.path);
        continue;
      }
      store.put(file.path, file.before);
      restored.push(file.path);
    }
    const lines = [
      ...(restored.length > 0
        ? [`The runtime restored non-test files changed by the reviewer: ${restored.join(', ')}.`]
        : []),
      ...(kept.length > 0 ? [`The reviewer kept test files: ${kept.join(', ')}.`] : []),
      ...(review.uncovered.length > 0
        ? [
            `Files changed by the reviewer that were too large to restore: ${review.uncovered.join(', ')}.`,
          ]
        : []),
    ];
    return lines.join('\n');
  };
}
