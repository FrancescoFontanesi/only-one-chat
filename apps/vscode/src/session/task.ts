import { readTaskProgress, type TaskProgress } from '@only-one-chat/runtime';
import type { VerificationCheckpoint } from '../../../../packages/runtime/src/verification.js';

export interface SavedTask {
  readonly sessions?: Readonly<Record<string, string>>;
  readonly version: 1;
  readonly id: string;
  readonly configuration: string;
  readonly progress: TaskProgress;
  readonly checkpoint: string | null;
  readonly verification?: VerificationCheckpoint | undefined;
}
const ID = /^[a-z0-9-]{1,64}$/;

export function readSavedTask(value: unknown): SavedTask | undefined {
  try {
    if (!value || typeof value !== 'object') return undefined;
    const task = value as Record<string, unknown>;
    if (
      task['version'] !== 1 ||
      typeof task['id'] !== 'string' ||
      !ID.test(task['id']) ||
      typeof task['configuration'] !== 'string' ||
      task['configuration'].length > 128000 ||
      (task['checkpoint'] !== null &&
        (typeof task['checkpoint'] !== 'string' || !ID.test(task['checkpoint']))) ||
      !readTaskProgress(task['progress'])
    )
      return undefined;
    if (task['verification'] !== undefined) {
      const v = task['verification'] as Record<string, unknown> | null;
      if (
        !v ||
        typeof v['id'] !== 'string' ||
        !ID.test(v['id']) ||
        (v['baseline'] !== null &&
          (typeof v['baseline'] !== 'string' || !ID.test(v['baseline']))) ||
        !Number.isInteger(v['round']) ||
        Number(v['round']) < 0 ||
        Number(v['round']) > 3 ||
        !Number.isInteger(v['budget']) ||
        Number(v['budget']) < Number(v['round']) ||
        Number(v['budget']) > 3
      )
        return undefined;
    }
    if (task['sessions'] !== undefined) {
      const sessions = task['sessions'];
      if (
        !sessions ||
        typeof sessions !== 'object' ||
        Object.entries(sessions).some(
          ([role, id]) =>
            !['leader', 'implementer'].includes(role) || typeof id !== 'string' || id.length > 512,
        )
      )
        return undefined;
    }
    return value as SavedTask;
  } catch {
    return undefined;
  }
}

export function taskUnfinished(task: SavedTask | undefined): boolean {
  return (
    task !== undefined && task.progress.step !== 'completed' && task.progress.step !== 'cancelled'
  );
}
