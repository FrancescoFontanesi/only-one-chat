import { readHandoff, type Findings, type Report, type Review } from './handoff.js';
import type { TestSelection } from './verification.js';
import type { ThreadHandoff } from './loop.js';

export interface TaskWork {
  readonly text: string;
  readonly data: Report | null | undefined;
  readonly commandEvidence?: string | undefined;
}

export interface TaskReview {
  readonly text: string;
  readonly review: Review | null;
  readonly findings: Findings | null;
  readonly restored: string;
  readonly handoff: ThreadHandoff | undefined;
}

/** An intent is persisted before execution, its outcome before advancing. */
export interface TaskProgress {
  readonly delivery?: 'leader' | 'deferred';
  readonly source?: 'direct' | 'delegation' | 'review';
  readonly sourceRequest?: string;
  readonly leaderDelivered?: boolean;
  readonly brief: string;
  readonly direct: boolean;
  readonly step:
    'implementation' | 'review' | 'verification' | 'delivery' | 'completed' | 'cancelled';
  readonly inFlight: boolean;
  readonly limit: number;
  readonly used: number;
  readonly work?: TaskWork | undefined;
  readonly findings?: string | undefined;
  readonly answer?: TaskReview | undefined;
  readonly selection?: TestSelection | undefined;
  readonly result?: { readonly facts: string; readonly review?: string | undefined } | undefined;
}

export interface TaskJournal {
  readonly resume?: TaskProgress | undefined;
  save(progress: TaskProgress): void;
}

/** Bounded persisted data is validated before it can select a continuation. */
export function readTaskProgress(value: unknown): TaskProgress | undefined {
  try {
    if (!value || typeof value !== 'object' || JSON.stringify(value).length > 512000)
      return undefined;
    const p = value as Record<string, unknown>;
    if (
      typeof p['brief'] !== 'string' ||
      typeof p['direct'] !== 'boolean' ||
      typeof p['step'] !== 'string' ||
      !['implementation', 'review', 'verification', 'delivery', 'completed', 'cancelled'].includes(
        p['step'],
      ) ||
      typeof p['inFlight'] !== 'boolean' ||
      (p['delivery'] !== undefined && p['delivery'] !== 'leader' && p['delivery'] !== 'deferred') ||
      (p['source'] !== undefined &&
        p['source'] !== 'direct' &&
        p['source'] !== 'delegation' &&
        p['source'] !== 'review') ||
      (p['sourceRequest'] !== undefined && typeof p['sourceRequest'] !== 'string') ||
      (p['leaderDelivered'] !== undefined && typeof p['leaderDelivered'] !== 'boolean') ||
      !Number.isInteger(p['limit']) ||
      Number(p['limit']) < 0 ||
      Number(p['limit']) > 3 ||
      !Number.isInteger(p['used']) ||
      Number(p['used']) < 0 ||
      Number(p['used']) > Number(p['limit']) ||
      (p['findings'] !== undefined && typeof p['findings'] !== 'string')
    )
      return undefined;
    const work = p['work'] as TaskWork | null | undefined;
    if (
      work !== undefined &&
      (!work ||
        typeof work.text !== 'string' ||
        (work.commandEvidence !== undefined && typeof work.commandEvidence !== 'string') ||
        (work.data != null &&
          !readHandoff([{ tool: 'report', arguments: work.data }], 'report').value))
    )
      return undefined;
    const answer = p['answer'] as TaskReview | null | undefined;
    const handoff = answer?.handoff as ThreadHandoff | null | undefined;
    if (
      answer !== undefined &&
      (!answer ||
        typeof answer.text !== 'string' ||
        typeof answer.restored !== 'string' ||
        (answer.review !== null &&
          !readHandoff([{ tool: 'review', arguments: answer.review }], 'review').value) ||
        (answer.findings !== null &&
          !readHandoff([{ tool: 'findings', arguments: answer.findings }], 'findings').value) ||
        (handoff !== undefined &&
          (!handoff ||
            typeof handoff.text !== 'string' ||
            typeof handoff.tool !== 'string' ||
            (handoff.commandEvidence !== undefined &&
              typeof handoff.commandEvidence !== 'string'))))
    )
      return undefined;
    if (p['selection'] !== undefined) {
      const test = readHandoff(
        [
          {
            tool: 'report',
            arguments: {
              outcome: 'done',
              summary: 'validation',
              changes: [],
              criteria: [],
              test: p['selection'],
            },
          },
        ],
        'report',
      ).value?.test;
      if (!test) return undefined;
    }
    const result = p['result'] as TaskProgress['result'] | null;
    if (
      result !== undefined &&
      (!result ||
        typeof result.facts !== 'string' ||
        (result.review !== undefined && typeof result.review !== 'string'))
    )
      return undefined;
    if (['review', 'verification', 'delivery'].includes(p['step']) && !work) return undefined;
    if (p['step'] === 'completed' && !work) return undefined;
    if (['delivery', 'completed'].includes(p['step']) && !result) return undefined;
    if (['completed', 'cancelled'].includes(p['step']) && p['inFlight']) return undefined;
    if (p['leaderDelivered'] && !['delivery', 'completed'].includes(p['step'])) return undefined;
    return value as TaskProgress;
  } catch {
    return undefined;
  }
}
