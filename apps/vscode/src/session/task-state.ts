// The chat's durable task (ADR 0043, 0047): the saved record, whether it is
// invalid, the task checkpoint it may reuse, and whether the folder changed
// since its boundary. ChatSession drives the work; this keeps the record.
// Node only, no `vscode`.

import type { TaskJournal, TaskProgress } from '@only-one-chat/runtime';
import type { RoleName, ThreadUpdate } from '../shared/protocol.js';
import type { CheckpointStore } from './checkpoints.js';
import { readSavedTask, taskUnfinished, type SavedTask } from './task.js';

export interface TaskStateOptions {
  /** False when the chat keeps no task: nothing is saved. */
  readonly enabled: boolean;
  readonly store: CheckpointStore | undefined;
  /** The chat's configuration now, as a task records it. */
  readonly configuration: () => string;
  /** The verification's state now, to save with the task. */
  readonly verification: () => SavedTask['verification'];
  /** A role's CLI session now, before the one the task last saved. */
  readonly session: (role: RoleName) => string | undefined;
  readonly id: (prefix: string) => string;
  readonly update: (update: ThreadUpdate) => void;
  readonly saveTask: (task: SavedTask | null) => void;
}

export class TaskState {
  private current: SavedTask | undefined;
  private invalidRecord: boolean;
  private changed = false;
  /**
   * The task checkpoint last taken, and whether something that could write
   * to the folder ran since (an agent turn, a verification command): a clean
   * save reuses it instead of walking the folder again (ADR 0047).
   */
  private checkpoint: { id: string; clean: boolean } | undefined;

  constructor(
    private readonly options: TaskStateOptions,
    saved: SavedTask | undefined,
    invalid: boolean,
  ) {
    this.current = readSavedTask(saved);
    this.invalidRecord = invalid || (saved !== undefined && this.current === undefined);
  }

  get task(): SavedTask | undefined {
    return this.current;
  }

  get invalid(): boolean {
    return this.invalidRecord;
  }

  get unfinished(): boolean {
    return taskUnfinished(this.current);
  }

  /** The folder changed after the task's boundary, as the last recoveryReason found. */
  get recoveryChanged(): boolean {
    return this.changed;
  }

  /** Something that could write to the folder ran: the task checkpoint is no longer clean. */
  markDirty(): void {
    if (this.checkpoint) this.checkpoint.clean = false;
  }

  save(progress: TaskProgress): void {
    if (!this.options.enabled) return;
    const previous = taskUnfinished(this.current) ? this.current : undefined;
    // Reuse only inside a task, for the checkpoint this task last recorded.
    const reused =
      previous?.checkpoint && this.checkpoint?.clean && this.checkpoint.id === previous.checkpoint
        ? this.checkpoint.id
        : undefined;
    const checkpoint =
      progress.step === 'cancelled' || reused
        ? null
        : (this.options.store?.take(this.options.id('task-ckpt')) ?? null);
    if (checkpoint) this.checkpoint = { id: checkpoint.id, clean: true };
    const next: SavedTask = {
      version: 1,
      id: previous?.id ?? this.options.id('task'),
      configuration: previous?.configuration ?? this.options.configuration(),
      progress,
      checkpoint:
        reused ??
        checkpoint?.id ??
        (progress.step === 'cancelled' ? (previous?.checkpoint ?? null) : null),
      verification: this.options.verification() ?? previous?.verification,
      sessions: Object.fromEntries(
        (['leader', 'implementer'] as const).flatMap((role) => {
          const id = this.options.session(role) ?? previous?.sessions?.[role];
          return typeof id === 'string' && id.length <= 512 ? [[role, id]] : [];
        }),
      ),
    };
    if (!readSavedTask(next)) throw new Error('Task state cannot be safely persisted');
    this.options.saveTask(next);
    this.current = next;
    this.invalidRecord = false;
  }

  /** What the runtime loop resumes from and saves to; none when the chat keeps no task. */
  journal(resuming: boolean): TaskJournal | undefined {
    if (!this.options.enabled) return undefined;
    return {
      resume: resuming ? this.current?.progress : undefined,
      save: (progress) => {
        this.save(progress);
      },
    };
  }

  configurationMatches(): boolean {
    return !this.invalidRecord && this.current?.configuration === this.options.configuration();
  }

  recoveryReason(showChanges = true): string | undefined {
    this.changed = false;
    if (this.invalidRecord)
      return 'The saved task record is invalid. Inspect the history and cancel the task to continue.';
    if (!taskUnfinished(this.current) || !this.current) return undefined;
    if (this.current.configuration !== this.options.configuration())
      return 'The task configuration changed. Restore its recorded roles, providers, and verification settings before resuming.';
    const { store } = this.options;
    const checkpoint = this.current.checkpoint ? store?.load(this.current.checkpoint) : undefined;
    if (!checkpoint || checkpoint.incomplete || Object.keys(checkpoint.large).length > 0) {
      this.changed = true;
      return 'The workspace checkpoint is incomplete or unavailable. Review the current files before continuing.';
    }
    try {
      const current = store?.take(this.options.id('recovery-ckpt'));
      const review = store?.review(checkpoint);
      if (!current || current.incomplete || !review) {
        this.changed = true;
        return 'The current workspace cannot be fully compared. Review the files before continuing.';
      }
      if (review.files.length > 0 || review.uncovered.length > 0) {
        this.changed = true;
        if (showChanges)
          this.options.update({
            type: 'changes',
            id: this.options.id('changes'),
            checkpoint: checkpoint.id,
            ...review,
          });
        return 'Files changed after the recorded task boundary. Review the changes before continuing.';
      }
    } catch {
      this.changed = true;
      return 'The recorded workspace cannot be read. Review the files before continuing.';
    }
    const baseline = this.current.verification?.baseline;
    if (baseline && !store?.load(baseline))
      return 'The original verification baseline is unavailable. Inspect the recorded evidence before continuing.';
    return this.current.progress.inFlight
      ? 'The last operation has no committed outcome. Review the current files before continuing.'
      : undefined;
  }

  /** Cancels an unfinished task, or forgets an invalid record. */
  cancel(): void {
    if (!this.invalidRecord && !taskUnfinished(this.current)) return;
    if (this.current) this.save({ ...this.current.progress, step: 'cancelled', inFlight: false });
    else {
      this.options.saveTask(null);
      this.invalidRecord = false;
    }
  }
}

/**
 * The progress a resumed task goes on from, as the states to save in order:
 * first an operation with no committed outcome is settled, then a folder that
 * changed after the task's boundary makes the prior results stale. Empty when
 * neither applies.
 */
export function recoveredProgress(
  progress: TaskProgress,
  { reviewer, changed }: { readonly reviewer: boolean; readonly changed: boolean },
): TaskProgress[] {
  const states: TaskProgress[] = [];
  if (progress.inFlight) {
    const step =
      progress.step === 'verification' && progress.answer
        ? 'verification'
        : progress.step === 'delivery'
          ? 'delivery'
          : reviewer
            ? 'review'
            : 'verification';
    progress = {
      ...progress,
      step,
      inFlight: false,
      findings: [
        progress.findings,
        'Recovery note: the last operation has an uncertain outcome. Inspect current files and treat the prior report as historical context.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      work:
        !progress.work && progress.step === 'implementation'
          ? {
              text: 'The implementer was interrupted. Inspect the current files against the approved request and saved findings.',
              data: null,
            }
          : (progress.work ?? {
              text: 'Interrupted work requires review of the current files.',
              data: null,
            }),
    };
    states.push(progress);
  }
  if (changed) {
    progress = {
      ...progress,
      step: reviewer && progress.work?.data?.outcome !== 'blocked' ? 'review' : 'verification',
      inFlight: false,
      answer: undefined,
      result: undefined,
      leaderDelivered: false,
      work: progress.work ?? {
        text: 'Inspect the current files against the approved request.',
        data: null,
      },
      findings: [
        progress.findings,
        'Recovery note: workspace inputs changed. Prior verification and review results are stale; review and verify the current files.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    };
    states.push(progress);
  }
  return states;
}
