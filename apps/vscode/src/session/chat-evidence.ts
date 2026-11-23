// What the runtime records and checks around a message, apart from the agents'
// words: the folder's checkpoint before it (ADR 0014), the changes card after
// it, and the verified facts after an implementer's turn (ADR 0010, 0030).
// Node only, no `vscode`.

import { DIFF_CHECKS_UNAVAILABLE } from '@only-one-chat/runtime';
import type { ThreadUpdate } from '../shared/protocol.js';
import type { Checkpoint, CheckpointStore } from './checkpoints.js';
import { configuredCommandFact, verifiedFacts, type snapshot } from './facts.js';
import type { Ignored } from './ignore.js';

export interface EvidenceOptions {
  readonly cwd: string;
  readonly store: CheckpointStore | undefined;
  readonly ignored: Ignored;
  readonly verifyCommand: readonly string[];
  /** The folder as it was before the message running now, read when the facts are made. */
  readonly inRequest: () => Checkpoint | null;
  readonly id: (prefix: string) => string;
  readonly update: (update: ThreadUpdate) => void;
}

export class ChatEvidence {
  constructor(private readonly options: EvidenceOptions) {}

  /** The folder recorded before a message (ADR 0014); null without a store or when it cannot be. */
  checkpoint(): Checkpoint | null {
    const { store } = this.options;
    if (!store) return null;
    try {
      const checkpoint = store.take(this.options.id('ckpt'));
      if (!checkpoint) {
        this.options.update({
          type: 'notice',
          level: 'warn',
          text: 'Checkpoint unavailable. The workspace has too many files or could not be read. Changes from this message cannot be reverted here.',
        });
      }
      return checkpoint;
    } catch (error) {
      this.options.update({
        type: 'notice',
        level: 'warn',
        text: `Could not create a checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    }
  }

  /** The changes card of a message; false when it could not be made. */
  review(checkpoint: Checkpoint): boolean {
    try {
      const review = this.options.store?.review(checkpoint);
      if (!review) return false;
      if (review.files.length > 0 || review.uncovered.length > 0) {
        this.options.update({
          type: 'changes',
          id: this.options.id('m'),
          checkpoint: checkpoint.id,
          files: review.files,
          uncovered: review.uncovered,
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * What the runtime verified after an implementer's turn (ADR 0010, 0030): the
   * changed files and the verification command, then the checks on the diff.
   */
  async facts(
    baseline: ReturnType<typeof snapshot>,
    turnBase?: ReturnType<typeof snapshot>,
  ): Promise<string> {
    const { options } = this;
    const facts = await verifiedFacts(options.cwd, baseline, [], options.ignored, turnBase);
    const command = configuredCommandFact(options.verifyCommand);
    return `${facts}

${command}

${this.diffChecks()}`;
  }

  /** The checks on the diff since the request began; said so when they cannot be made. */
  private diffChecks(): string {
    const { store } = this.options;
    const inRequest = this.options.inRequest();
    return (inRequest ? store?.diffChecks(inRequest) : null) ?? DIFF_CHECKS_UNAVAILABLE;
  }
}
