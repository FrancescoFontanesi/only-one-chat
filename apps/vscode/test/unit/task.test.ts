import * as fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTaskProgress } from '@only-one-chat/runtime';
import { readSavedTask, type SavedTask } from '../../src/session/task.js';
import { ChatHistory, type ChatRecord } from '../../src/session/history.js';
import { CheckpointStore } from '../../src/session/checkpoints.js';

vi.mock(import('node:fs'), async (original) => {
  const actual = await original();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ooc-task-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const task = (): SavedTask => ({
  version: 1,
  id: 'task-1',
  configuration: '{}',
  checkpoint: null,
  progress: {
    brief: 'Approved work',
    direct: true,
    step: 'implementation',
    inFlight: false,
    limit: 2,
    used: 0,
  },
});
const record = (): ChatRecord => ({
  version: 1,
  id: 'chat-1',
  title: 'Task',
  createdAt: 1,
  updatedAt: 1,
  sessions: {},
  updates: [{ type: 'user', id: 'u-1', text: 'Approved work' }],
});

describe('durable task records', () => {
  it('keeps disk and memory at the committed boundary when rename fails', () => {
    const history = new ChatHistory(root);
    const active = record();
    const first = task();
    history.saveTask(active, first);
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error('synthetic rename failure');
    });
    expect(() => {
      history.saveTask(active, { ...first, progress: { ...first.progress, inFlight: true } });
    }).toThrow('synthetic rename failure');
    expect(active.task).toBe(first);
    expect(history.load(active.id)?.task?.progress.inFlight).toBe(false);
  });

  it('retains the latest completed task when another task starts', () => {
    const history = new ChatHistory(root);
    const active = record();
    const completed: SavedTask = {
      ...task(),
      progress: {
        ...task().progress,
        step: 'completed',
        work: { text: 'Completed', data: null },
        result: { facts: 'Recorded' },
      },
    };
    history.saveTask(active, completed);
    history.saveTask(active, { ...task(), id: 'task-2' });
    expect(history.load(active.id)?.lastCompletedTask).toEqual(completed);
  });

  it.each([
    { ...task(), version: 2 },
    { ...task(), id: '../outside' },
    { ...task(), checkpoint: '../outside' },
    { ...task(), progress: { ...task().progress, used: 3 } },
    { ...task(), progress: { ...task().progress, step: 'shell' } },
    { ...task(), progress: { ...task().progress, step: ['implementation'] } },
    { ...task(), progress: { ...task().progress, step: 'review' } },
    { ...task(), verification: { id: 'v-1', baseline: '../secret', round: 0, budget: 1 } },
    { ...task(), sessions: { reviewer: 'unsupported-session' } },
    { ...task(), progress: { ...task().progress, step: 'completed', inFlight: true } },
    {
      ...task(),
      progress: {
        ...task().progress,
        step: 'delivery',
        work: { text: 'Partial record', data: null },
      },
    },
    { ...task(), progress: { ...task().progress, leaderDelivered: true } },
  ])('rejects malformed task data while preserving readable history', (malformed) => {
    expect(readSavedTask(malformed)).toBeUndefined();
    writeFileSync(join(root, 'chat-1.json'), JSON.stringify({ ...record(), task: malformed }));
    const loaded = new ChatHistory(root).load('chat-1');
    expect(loaded?.updates).toEqual(record().updates);
    expect(loaded?.taskInvalid).toBe(true);
    expect(loaded?.task).toBeUndefined();
  });

  it('bounds repeated hostile records and rejects cycles and oversized task context', () => {
    for (let index = 0; index < 100; index++) {
      expect(readTaskProgress({ ...task().progress, used: -index - 1 })).toBeUndefined();
      expect(readSavedTask({ ...task(), checkpoint: '../'.repeat(index + 1) })).toBeUndefined();
    }
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(readTaskProgress(cyclic)).toBeUndefined();
    expect(readTaskProgress({ ...task().progress, brief: 'x'.repeat(512001) })).toBeUndefined();
  });

  it('rejects corrupted checkpoint manifests before recovery can use them', () => {
    const store = new CheckpointStore(join(root, 'storage'), root);
    const checkpoint = store.take('snapshot-1');
    expect(checkpoint).not.toBeNull();
    writeFileSync(
      join(root, 'storage', 'checkpoints', 'snapshot-1.json'),
      JSON.stringify({ ...checkpoint, files: { '../outside': 'a'.repeat(64) } }),
    );
    expect(store.load('snapshot-1')).toBeUndefined();
  });
});
