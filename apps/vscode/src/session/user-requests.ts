// What waits for the user during a turn: agents' permission requests (R9) and
// questions (ADR 0019). Each is shown in the dock and resolved by the user's
// answer, or declined when the turn stops. Node only, no `vscode`.

import type { AgentQuestion, QuestionAnswers } from '@only-one-chat/runtime';
import type { PermitDecision, ThreadUpdate, TurnRole } from '../shared/protocol.js';

export class UserRequests {
  /** Agents' permission requests waiting for the user (R9). */
  private readonly permissions = new Map<string, (decision: PermitDecision) => void>();
  /** The leader's questions waiting for the user (ADR 0019), with their secret ids. */
  private readonly questions = new Map<
    string,
    { resolve: (answers: QuestionAnswers) => void; secret: ReadonlySet<string> }
  >();

  constructor(
    private readonly id: (prefix: string) => string,
    private readonly update: (update: ThreadUpdate) => void,
  ) {}

  /** Shows an agent's permission request and waits for the user; stopping declines it. */
  askPermission(
    role: TurnRole,
    agent: string,
    summary: string,
    signal?: AbortSignal,
  ): Promise<PermitDecision> {
    return new Promise((resolve) => {
      const id = this.id('p');
      this.permissions.set(id, resolve);
      signal?.addEventListener('abort', () => {
        this.permit(id, 'decline');
      });
      this.update({ type: 'permission', id, role, agent, summary });
    });
  }

  /**
   * An agent's questions, shown in the dock while its turn waits (ADR 0019);
   * stopping leaves them unanswered.
   */
  ask(
    role: TurnRole,
    agent: string,
    questions: readonly AgentQuestion[],
    signal?: AbortSignal,
  ): Promise<QuestionAnswers> {
    return new Promise((resolve) => {
      const id = this.id('q');
      this.questions.set(id, {
        resolve,
        secret: new Set(questions.filter((q) => q.secret).map((q) => q.id)),
      });
      signal?.addEventListener('abort', () => {
        this.decline(id, 'declined');
      });
      this.update({ type: 'question', id, role, agent, questions });
    });
  }

  /** The user's answers to an agent's questions; a secret answer is never kept. */
  answer(id: string, answers: Readonly<Record<string, readonly string[]>>): void {
    const pending = this.questions.get(id);
    if (!pending) return;
    this.questions.delete(id);
    pending.resolve(answers);
    const shown = Object.fromEntries(
      Object.entries(answers).map(([key, values]) => [
        key,
        pending.secret.has(key) ? values.map(() => '••••') : values,
      ]),
    );
    this.update({ type: 'question_closed', id, outcome: 'answered', answers: shown });
  }

  /** The user's answer to a permission request. */
  permit(id: string, decision: PermitDecision): void {
    const resolve = this.permissions.get(id);
    if (!resolve) return;
    this.permissions.delete(id);
    resolve(decision);
    this.update({ type: 'permission_closed', id, decision });
  }

  /** Whatever is still waiting for the user is declined. */
  declineAll(): void {
    for (const id of [...this.permissions.keys()]) this.permit(id, 'decline');
    for (const id of [...this.questions.keys()]) this.decline(id, 'declined');
  }

  private decline(id: string, outcome: 'declined' | 'interrupted'): void {
    const pending = this.questions.get(id);
    if (!pending) return;
    this.questions.delete(id);
    pending.resolve(null);
    this.update({ type: 'question_closed', id, outcome });
  }
}
