// The steps of a turn as the adapters report them (ADR 0019): each is sent
// whole and replaced by id. A step that streams (a command's output, a
// summary, a message) is sent at most every `everyMs`, and at once when it
// ends, so a long output does not flood the webview.

import type { AgentTurnStep } from './agent.js';

/** The last `max` characters of a text, marked as cut. */
export function tail(text: string, max = 8000): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

/** Lines added and removed in a unified diff. */
export function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

export class StepStream {
  private readonly pending = new Map<string, AgentTurnStep>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly emit: (step: AgentTurnStep) => void,
    private readonly everyMs = 250,
  ) {}

  /** A step changed; `now` sends it at once (it started or ended). */
  put(step: AgentTurnStep, now = false): void {
    if (now) {
      this.pending.delete(step.id);
      this.emit(step);
      return;
    }
    this.pending.set(step.id, step);
    this.timer ??= setTimeout(() => {
      this.flush();
    }, this.everyMs);
  }

  /** Sends what is waiting: at the end of the turn. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const steps = [...this.pending.values()];
    this.pending.clear();
    for (const step of steps) this.emit(step);
  }
}
