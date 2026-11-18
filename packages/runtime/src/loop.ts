// The loop of a request (ADR 0018, 0020): in `leader` mode the user's request
// goes to the leader, which answers by itself or delegates with a block; the
// implementer works, its report is reviewed (by a reviewer, ADR 0029, and by
// the leader unless the review is deferred) and the leader answers the user.
// A brief pasted from the reasoning chat goes to the implementer at once and
// ends with the result for that chat. In `review` mode (ADR 0033) work the
// leader did not delegate is reviewed before the leader reads it.
// Every event is appended to the event log; each answer carries a label written here from
// what the adapter observed, never from the agent's own text. Approval
// requests from agents are declined unless the caller answers them.

import type {
  AgentFactory,
  AgentQuestion,
  AgentIdentity,
  AgentSession,
  AgentTurn,
  AgentTurnResult,
  ApprovalRequest,
  ApprovalDecision,
  ContextUsage,
  QuotaSnapshot,
  QuestionAnswers,
  SkillRef,
  TurnStep,
  SubagentEvent,
  SubagentPolicy,
  TurnUsage,
} from './agent.js';
import { delegationStart, parseDelegation, type DelegationParse } from './delegation.js';
import { extractResult, parseBrief, type Brief } from './brief.js';
import type { EventLog } from './event-log.js';
import { checkReport, checkReview, contractFacts } from './contract.js';
import {
  parseReviewerTurn,
  reportOutcome,
  type ReviewerTurn,
  type ReviewVerdict,
} from './review.js';
import {
  DEFAULT_REVIEW_ROUNDS,
  EMPTY_REVIEW,
  IMPLEMENTER_ROLE_INSTRUCTIONS,
  MAX_REVIEW_ROUNDS,
  REVIEWER_ROLE_INSTRUCTIONS,
  agentSessionOptions,
  findingsPrompt,
  fixPrompt,
  leaderResultPrompt,
  leaderReviewPrompt,
  lightDelegation,
  resultPrompt,
  reviewFollowUpPrompt,
  reviewRequestPrompt,
} from './prompts.js';
import { checkSubagent, subagentLabel, type SubagentState } from './subagents.js';

/** `reviewer`: when the loop is given one (ADR 0029). */
type Role = 'orchestrator' | 'worker' | 'reviewer';

export const APPROVAL_DENIED_MESSAGE = 'approvazione rifiutata: non supportata in questa versione';

export interface InterceptedMessage {
  readonly kind: 'delegation' | 'review';
  readonly from: string;
  readonly to: string;
  readonly text: string;
  /** 1-based exchange number. */
  readonly exchange: number;
}

export type InterceptDecision =
  | { readonly action: 'approve' }
  | { readonly action: 'edit'; readonly text: string }
  | { readonly action: 'cancel' };

export interface MalformedDelegation {
  readonly answer: string;
  readonly errors: readonly string[];
  readonly exchange: number;
  /** False once the one correction by the leader has been used. */
  readonly canAskOrchestrator: boolean;
}

export type MalformedDecision =
  | { readonly action: 'ask_orchestrator' }
  | { readonly action: 'edit'; readonly text: string }
  | { readonly action: 'cancel' };

export type ThreadEvent =
  | { readonly type: 'turn_started'; readonly role: Role; readonly agent: string }
  | { readonly type: 'text'; readonly role: Role; readonly text: string }
  | {
      readonly type: 'message';
      readonly role: Role;
      readonly agent: string;
      readonly text: string;
      /** Written by the runtime from `identity`; see agentLabel. */
      readonly label: string;
      readonly identity: AgentIdentity;
      readonly usage?: TurnUsage;
      readonly quota?: QuotaSnapshot | null;
      readonly context?: ContextUsage | null;
    }
  | {
      readonly type: 'approval_denied';
      readonly role: Role;
      readonly agent: string;
      readonly request: ApprovalRequest;
      readonly message: string;
    }
  | {
      /** The user's answer to an agent's approval request (R9). */
      readonly type: 'approval_decided';
      readonly role: Role;
      readonly agent: string;
      readonly request: ApprovalRequest;
      readonly decision: ApprovalDecision;
    }
  | {
      readonly type: 'activity';
      readonly role: Role;
      readonly kind: string;
      readonly detail: string;
    }
  | { readonly type: 'delegation_invalid'; readonly errors: readonly string[] }
  | { readonly type: 'intercepted'; readonly message: InterceptedMessage }
  | {
      readonly type: 'decision';
      readonly kind: 'delegation' | 'review' | 'malformed';
      /** approve, edit, cancel, ask_orchestrator; auto_approve and auto_fix in autoApprove runs. */
      readonly action: string;
      readonly text?: string;
    }
  | {
      /** A sub-agent of the agent running `role`; sent again on every change. */
      readonly type: 'subagent';
      readonly role: Role;
      readonly parent: string;
      readonly subagent: SubagentState;
      /** Written by the runtime; see subagentLabel. */
      readonly label: string;
    }
  | {
      readonly type: 'subagent_text';
      readonly role: Role;
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly type: 'subagent_activity';
      readonly role: Role;
      readonly id: string;
      readonly kind: string;
      readonly detail: string;
    }
  | { readonly type: 'subagent_violation'; readonly role: Role; readonly message: string }
  | {
      /** A review ended (ADR 0029): who reviewed, the verdict, the rounds of findings it took. */
      readonly type: 'reviewed';
      readonly reviewer: string;
      readonly implementer: string;
      readonly verdict: ReviewVerdict | null;
      readonly rounds: number;
    }
  | {
      /** The runtime's checks of a report or a review against the brief (ADR 0031). */
      readonly type: 'contract';
      readonly role: Role;
      readonly message: string;
    }
  | { readonly type: 'error'; readonly message: string }
  /** A step of an agent's turn (ADR 0019); shown, not logged: outputs can be long. */
  | { readonly type: 'step'; readonly role: Role; readonly step: TurnStep }
  | { readonly type: 'finished'; readonly outcome: LoopOutcome };

export type LoopOutcome =
  | { readonly status: 'completed'; readonly conclusion: string; readonly exchanges: number }
  | {
      /** The implementer's work, not yet seen by the leader: a deferred review, or a `review` run. */
      readonly status: 'delegated';
      readonly spec: string;
      readonly report: string;
      readonly facts: string;
      /** The reviewer's report, when the work was reviewed (ADR 0029). */
      readonly review?: string;
    }
  | {
      /** A brief from the reasoning chat: the result for that chat. */
      readonly status: 'result';
      /** The result block, or the leader's whole answer when it wrote none. */
      readonly result: string;
      readonly resultFound: boolean;
      /** What the implementer received. */
      readonly spec: string;
      /** The implementer's report. */
      readonly report: string;
      /** What the runtime verified after the implementer's turn. */
      readonly facts: string;
    }
  | { readonly status: 'cancelled'; readonly at: 'delegation' | 'review' | 'malformed' }
  | { readonly status: 'stopped' }
  | { readonly status: 'failed'; readonly error: string };

export interface LoopOptions {
  readonly request: string;
  readonly worker: AgentFactory;
  readonly log: EventLog;
  /** Shows a message before it reaches an agent; nothing is sent without approval. */
  intercept(message: InterceptedMessage, signal: AbortSignal): Promise<InterceptDecision>;
  /** The leader's delegation does not follow the format: the user decides. */
  onMalformedDelegation(
    problem: MalformedDelegation,
    signal: AbortSignal,
  ): Promise<MalformedDecision>;
  onEvent?(event: ThreadEvent): void;
  /**
   * `leader`: the request goes to the leader (`leaderSession`), which answers
   * or delegates to the implementer. `review` (ADR 0033): work the leader did
   * not delegate, reviewed before the leader reads it, see `reviewOf`.
   */
  readonly mode: 'leader' | 'review';
  /**
   * `review` mode (ADR 0033): work the leader did not delegate, reviewed
   * before the leader reads it: a message the user sent the implementer
   * (`direct`), or a review the user asked the reviewer for (`asked`), of the
   * last work when there is one. Needs `workerSession` and `reviewer`; no
   * leader turn; ends `delegated`, for the leader to read with the user's
   * next message. `request` is ignored.
   */
  readonly reviewOf?: {
    /** What the implementer was asked: a brief, or the user's own message. */
    readonly brief: string;
    readonly report: string;
    /** The brief is the user's message to the implementer, not the leader's brief. */
    readonly direct?: boolean;
    /** The user's own request to the reviewer. */
    readonly asked?: string;
  };
  /**
   * `leader` mode: the leader's session, kept across the user's requests and
   * never closed by the loop. A request that is a structured brief goes to the
   * implementer with the leader's notes only.
   */
  readonly leaderSession?: AgentSession;
  /**
   * An implementer session to continue (same line of work, ADR 0011), never
   * closed by the loop; `worker` is not called. Without it each delegation
   * starts a new implementer session.
   */
  readonly workerSession?: AgentSession;
  /**
   * `leader` mode: text put before the request in the leader's first prompt,
   * such as reports of work it has not seen yet (pendingReportsPreface).
   */
  readonly preface?: string;
  /**
   * `leader` mode, after a delegation: `always` (default) asks the leader to
   * review the report at once; `deferred` ends with the report, which the
   * caller hands to the leader with the user's next message.
   */
  readonly review?: 'always' | 'deferred';
  /**
   * An agent asks for an approval (a command, a file change outside what it
   * may do alone): the user answers (R9). Absent: every request is declined,
   * as before. The promise may reject when the loop stops: that declines.
   */
  onApproval?(
    request: { readonly role: Role; readonly agent: string; readonly request: ApprovalRequest },
    signal: AbortSignal,
  ): Promise<ApprovalDecision>;
  /**
   * What the runtime verifies after the implementer's turn, such as changed
   * files and the verification commands run again, as text for the leader.
   * Without it the leader judges the report alone.
   */
  facts?(): Promise<string>;
  /**
   * Benchmark runs only (ADR 0008): messages between agents are approved
   * without asking; each is still intercepted, logged and shown as an
   * `auto_approve` decision, and a malformed block gets one automatic
   * correction. `intercept` and `onMalformedDelegation` are not called.
   */
  readonly autoApprove?: boolean;
  /**
   * `leader` mode: a delegation the user already approved (a draft kept with
   * the chat, ADR 0018): it goes to the implementer without a leader turn
   * first, then the report is reviewed as usual. `request` is ignored.
   */
  readonly delegation?: string;
  /**
   * What a message between agents becomes on its way (ADR 0018): the
   * delegation before the implementer reads it, the report before the leader
   * does, e.g. `@path` mentions as plain paths. Default: unchanged.
   */
  relay?(text: string): string;
  /**
   * An agent asks the user while its turn waits (ADR 0019); only agents whose
   * session allows it ask. A stopped loop answers null.
   */
  onQuestion?(
    request: {
      readonly role: Role;
      readonly agent: string;
      readonly questions: readonly AgentQuestion[];
    },
    signal: AbortSignal,
  ): Promise<QuestionAnswers>;
  /** `leader` mode: a skill the user named for the leader's first turn (ADR 0019). */
  readonly skill?: SkillRef;
  /**
   * `leader` mode: a reviewer (ADR 0029). After the implementer's report it
   * checks the work against the brief, in a session of its own opened for
   * that delegation and closed with the loop; its findings go back to the
   * implementer for `reviewRounds` rounds at most, then its report reaches
   * the leader in place of the implementer's. A report that ends `bloccato`
   * is not reviewed. The reviewer may write tests, never the code: the
   * caller guards its turns (`guardReviewer`) or opens it read-only.
   */
  readonly reviewer?: AgentFactory;
  /** Rounds of findings the reviewer may open: default 2, maximum 3. */
  readonly reviewRounds?: number;
  /**
   * Called before each reviewer turn (ADR 0029): the function it returns runs
   * after the turn, puts back what the reviewer changed outside the tests and
   * says what, or ''. The runtime tells the leader and the implementer.
   */
  guardReviewer?(): (() => string) | null;
  /** A note on the reviewer's session, in its first prompt (see NO_COMMANDS_NOTE). */
  readonly reviewerNote?: string;
  /** Policies for the agents' own sub-agents (D13), per role. */
  readonly subagents?: {
    readonly orchestrator?: SubagentPolicy;
    readonly worker?: SubagentPolicy;
    readonly reviewer?: SubagentPolicy;
  };
}

interface Loop {
  readonly done: Promise<LoopOutcome>;
  /** Interrupts the running turn, ends the loop with `stopped`. Idempotent. */
  stop(): Promise<void>;
}

/** The label shown above an answer: provider, model, effort and session, as observed. */
export function agentLabel(identity: AgentIdentity): string {
  return [
    identity.provider,
    identity.model,
    `effort ${identity.effort ?? 'predefinito'}`,
    `sessione ${identity.sessionId}`,
  ].join(' · ');
}

class Stopped extends Error {}

/** Settles with `promise`, or rejects with Stopped as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Stopped());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Stopped());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function runLoop(options: LoopOptions): Loop {
  const controller = new AbortController();
  let stopped = false;
  const stopRequested = () => stopped;
  let current: AgentTurn | undefined;
  const sessions: AgentSession[] = [];

  async function emit(event: ThreadEvent): Promise<void> {
    options.onEvent?.(event);
    const { type, ...fields } = event;
    await options.log.append(type, fields);
  }

  const relay = (text: string) => options.relay?.(text) ?? text;

  function checkStopped(): void {
    if (stopped) throw new Stopped();
  }

  async function turn(
    session: AgentSession,
    role: Role,
    prompt: string,
    skill?: SkillRef,
  ): Promise<AgentTurnResult> {
    checkStopped();
    await emit({ type: 'turn_started', role, agent: session.name });
    const policy = options.subagents?.[role];
    const subagents = new Map<string, SubagentState>();
    let violation: string | undefined;
    /** The running turn, once runTurn has returned it. */
    const started: { turn?: AgentTurn } = {};

    function update(next: SubagentState): void {
      subagents.set(next.id, next);
      void emit({
        type: 'subagent',
        role,
        parent: session.name,
        subagent: next,
        label: subagentLabel(session.name, next),
      });
      if (!policy || violation !== undefined || next.status !== 'running') return;
      const runningNow = [...subagents.values()].filter((s) => s.status === 'running').length;
      const reason = checkSubagent(policy, next, runningNow);
      if (reason === undefined) return;
      violation = `Sotto-agente non conforme di ${session.name}: ${reason}. Turno interrotto.`;
      void emit({ type: 'subagent_violation', role, message: violation });
      void started.turn?.stop();
    }

    function onSubagent(event: SubagentEvent): void {
      const known = subagents.get(event.id);
      if (event.type === 'started') {
        update({
          id: event.id,
          name: event.name,
          model: event.model,
          effort: event.effort,
          status: 'running',
        });
      } else if (event.type === 'identified' && known) {
        update({
          ...known,
          model: event.model ?? known.model,
          effort: event.effort ?? known.effort,
        });
      } else if (event.type === 'finished' && known) {
        update({ ...known, status: event.status });
      } else if (event.type === 'text') {
        options.onEvent?.({ type: 'subagent_text', role, id: event.id, text: event.text });
      } else if (event.type === 'activity') {
        void emit({
          type: 'subagent_activity',
          role,
          id: event.id,
          kind: event.kind,
          detail: event.detail,
        });
      }
    }

    const running = session.runTurn(
      prompt,
      {
        onText: (text) => {
          options.onEvent?.({ type: 'text', role, text });
        },
        onApprovalRequest: async (request): Promise<ApprovalDecision> => {
          if (!options.onApproval) {
            await emit({
              type: 'approval_denied',
              role,
              agent: session.name,
              request,
              message: APPROVAL_DENIED_MESSAGE,
            });
            return 'decline';
          }
          // The user decides (R9); stopping the loop declines what is still waiting.
          const decision = await options
            .onApproval({ role, agent: session.name, request }, controller.signal)
            .catch((): ApprovalDecision => 'decline');
          await emit({ type: 'approval_decided', role, agent: session.name, request, decision });
          return decision;
        },
        onActivity: (activity) => {
          void emit({ type: 'activity', role, ...activity });
        },
        onSubagent,
        onStep: (step: TurnStep) => {
          options.onEvent?.({ type: 'step', role, step });
        },
        ...(options.onQuestion
          ? {
              onQuestion: async (questions: readonly AgentQuestion[]) => {
                if (!options.onQuestion || stopped) return null;
                await options.log.append('question', { role, count: questions.length });
                return abortable(
                  options.onQuestion({ role, agent: session.name, questions }, controller.signal),
                  controller.signal,
                ).catch(() => null);
              },
            }
          : {}),
      },
      skill ? { skill } : undefined,
    );
    started.turn = running;
    // A violation reported while runTurn was still starting the turn.
    if (violation !== undefined) void running.stop();
    current = running;
    try {
      const result = await running.done.catch((error: unknown) => {
        if (violation !== undefined) throw new Error(violation);
        throw error;
      });
      if (violation !== undefined) throw new Error(violation);
      checkStopped();
      await emit({
        type: 'message',
        role,
        agent: session.name,
        text: result.text,
        label: agentLabel(result.identity),
        identity: result.identity,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.quota !== undefined ? { quota: result.quota } : {}),
        ...(result.context ? { context: result.context } : {}),
      });
      return result;
    } catch (error) {
      if (violation === undefined) checkStopped();
      throw error;
    } finally {
      current = undefined;
    }
  }

  /**
   * A message between agents. `pass`: it goes on without the user, logged and
   * shown as `auto_approve` like the autoApprove runs (a leader's reports, a
   * brief the user already reviewed in the web app, ADR 0018).
   */
  async function intercept(message: InterceptedMessage, pass = false): Promise<string | undefined> {
    checkStopped();
    await emit({ type: 'intercepted', message });
    if (options.autoApprove || pass) {
      await emit({ type: 'decision', kind: message.kind, action: 'auto_approve' });
      return message.text;
    }
    const decision = await abortable(
      options.intercept(message, controller.signal),
      controller.signal,
    );
    checkStopped();
    await emit({
      type: 'decision',
      kind: message.kind,
      action: decision.action,
      ...(decision.action === 'edit' ? { text: decision.text } : {}),
    });
    if (decision.action === 'cancel') return undefined;
    return decision.action === 'edit' ? decision.text : message.text;
  }

  /** Format errors, plus recipient errors: the block must name the implementer. */
  function check(answer: string, workerId: string): DelegationParse {
    const parsed = parseDelegation(answer);
    if (parsed.status !== 'valid') return parsed;
    const { recipient } = parsed.delegation;
    if (recipient === null) {
      return {
        status: 'malformed',
        errors: [`the start line must name the recipient: "${delegationStart(workerId)}"`],
      };
    }
    if (recipient !== workerId.toLowerCase()) {
      return {
        status: 'malformed',
        errors: [`unknown recipient "#${recipient}": the only agent is "#${workerId}"`],
      };
    }
    return parsed;
  }

  const reviewOnly = options.mode === 'review';
  /** A report is held to a brief: the leader's, or the one a review is asked of (ADR 0031). */
  const held = !reviewOnly || options.reviewOf?.direct !== true;

  /**
   * The facts after an implementer's turn, with the runtime's checks of its
   * report against the brief (ADR 0031), shown in the thread as well.
   */
  async function factsFor(brief: string, report: string): Promise<string> {
    const facts = (await options.facts?.()) ?? '';
    const note =
      held && (brief.trim() !== '' || report.trim() !== '')
        ? contractFacts('Controlli sul rapporto', checkReport(brief, report, facts))
        : '';
    if (note === '') return facts;
    await emit({ type: 'contract', role: 'worker', message: note });
    return `${facts}\n\n${note}`;
  }

  /**
   * The review of a delegation (ADR 0029): the reviewer reads the brief, the
   * report and the facts; while it answers with findings and rounds are left,
   * the implementer answers them and the reviewer looks again. Anything else
   * it writes ends the review and is what the leader reads. These messages go
   * on without the user, like the reports (ADR 0018), each shown and logged.
   */
  async function reviewed(
    worker: AgentSession,
    brief: string,
    firstReport: string,
    exchange: number,
    of: { readonly direct?: boolean; readonly asked?: string } = {},
  ): Promise<{ reviewer: string; review: string; report: string; facts: string }> {
    if (!options.reviewer) throw new Error('reviewed() needs a reviewer');
    const rounds = Math.max(
      0,
      Math.min(options.reviewRounds ?? DEFAULT_REVIEW_ROUNDS, MAX_REVIEW_ROUNDS),
    );
    const reviewer = await options.reviewer(
      agentSessionOptions(REVIEWER_ROLE_INSTRUCTIONS, options.subagents?.reviewer),
    );
    sessions.push(reviewer);
    let report = firstReport;
    let facts = await factsFor(brief, report);
    let prompt = reviewRequestPrompt(
      worker.name,
      brief,
      report,
      facts,
      rounds,
      options.reviewerNote,
      of,
    );
    for (let round = 0; ; round++) {
      const sent = await intercept(
        { kind: 'review', from: worker.name, to: reviewer.name, text: prompt, exchange },
        true,
      );
      const undo = options.guardReviewer?.() ?? null;
      const written = (await turn(reviewer, 'reviewer', sent ?? prompt)).text;
      const restored = undo ? undo() : '';
      if (restored !== '') await emit({ type: 'contract', role: 'reviewer', message: restored });
      const withRestored = (text: string) => (restored === '' ? text : `${text}\n\n${restored}`);
      const answer: ReviewerTurn =
        written.trim() === ''
          ? { kind: 'review', text: EMPTY_REVIEW, verdict: null }
          : parseReviewerTurn(written);
      if (answer.kind === 'review' || round >= rounds) {
        // An empty answer has nothing to check: EMPTY_REVIEW already says so.
        const checked =
          answer.kind === 'review' && written.trim() !== ''
            ? checkReview(brief, answer.text)
            : null;
        const note = checked ? contractFacts('Controlli sulla revisione', checked.issues) : '';
        if (note !== '') await emit({ type: 'contract', role: 'reviewer', message: note });
        await emit({
          type: 'reviewed',
          reviewer: reviewer.name,
          implementer: worker.name,
          verdict: checked ? checked.verdict : null,
          rounds: round,
        });
        const review = withRestored(note === '' ? answer.text : `${answer.text}\n\n${note}`);
        return { reviewer: reviewer.name, review, report, facts };
      }
      const findings = withRestored(findingsPrompt(reviewer.name, answer.text));
      const passed = await intercept(
        { kind: 'review', from: reviewer.name, to: worker.name, text: findings, exchange },
        true,
      );
      report = (await turn(worker, 'worker', relay(passed ?? findings))).text;
      facts = await factsFor(brief, report);
      prompt = reviewFollowUpPrompt(worker.name, report, facts, rounds - round - 1);
    }
  }

  async function run(): Promise<LoopOutcome> {
    await options.log.append('loop_started', {
      request: options.request,
      mode: options.mode,
      autoApprove: options.autoApprove === true,
    });
    if (reviewOnly) {
      const of = options.reviewOf;
      const worker = options.workerSession;
      if (!of || !worker || !options.reviewer) {
        throw new Error('review mode needs reviewOf, workerSession and reviewer');
      }
      const judged = await reviewed(worker, relay(of.brief), of.report, 1, of);
      return {
        status: 'delegated',
        spec: of.brief,
        report: judged.report,
        facts: judged.facts,
        review: judged.review,
      };
    }
    // The leader also takes free requests: only a valid brief is a structured one.
    const parsedBrief = parseBrief(options.request);
    const brief: Brief | undefined = parsedBrief.status === 'valid' ? parsedBrief.brief : undefined;
    // The leader's session outlives this request: whoever created it closes it.
    const leader = options.leaderSession;
    if (!leader) throw new Error('leader mode needs leaderSession');
    const worker =
      options.workerSession ??
      (await options.worker(
        agentSessionOptions(IMPLEMENTER_ROLE_INSTRUCTIONS, options.subagents?.worker),
      ));
    // A continued implementer session outlives this request, like the leader's.
    if (worker !== options.workerSession) sessions.push(worker);

    // The leader reads a web-app brief as it came, with its markers (ADR 0020).
    const first = options.preface ? `${options.preface}\n\n${options.request}` : options.request;
    /** A draft the user approved: the implementer starts from it, with no leader turn first. */
    const draft = options.delegation;
    let answer =
      draft === undefined ? (await turn(leader, 'orchestrator', first, options.skill)).text : '';
    // One delegation per request.
    const exchange = 1;
    let fixes = 0;
    for (;;) {
      let delegation: string;
      const fromDraft = draft !== undefined;
      if (draft !== undefined) {
        delegation = draft;
      } else {
        const parsed = check(answer, worker.id);
        // The leader answered by itself: a question, or a request for clarification.
        if (parsed.status === 'absent') {
          return { status: 'completed', conclusion: answer, exchanges: 0 };
        }
        if (parsed.status === 'malformed') {
          await emit({ type: 'delegation_invalid', errors: parsed.errors });
          const canAskOrchestrator = fixes < 1;
          const decision: MalformedDecision = options.autoApprove
            ? canAskOrchestrator
              ? { action: 'ask_orchestrator' }
              : { action: 'cancel' }
            : await abortable(
                options.onMalformedDelegation(
                  { answer, errors: parsed.errors, exchange, canAskOrchestrator },
                  controller.signal,
                ),
                controller.signal,
              );
          if (options.autoApprove && decision.action === 'cancel') {
            throw new Error(
              'The delegation block is still malformed after the one automatic correction',
            );
          }
          checkStopped();
          await emit({
            type: 'decision',
            kind: 'malformed',
            action: options.autoApprove ? 'auto_fix' : decision.action,
            ...(decision.action === 'edit' ? { text: decision.text } : {}),
          });
          if (decision.action === 'cancel') return { status: 'cancelled', at: 'malformed' };
          if (decision.action === 'ask_orchestrator') {
            if (!canAskOrchestrator) {
              throw new Error('The delegation block is still malformed after the one correction');
            }
            fixes++;
            answer = (await turn(leader, 'orchestrator', fixPrompt(parsed.errors))).text;
            continue;
          }
          delegation = decision.text;
        } else if (brief) {
          delegation = lightDelegation(brief, parsed.delegation.text);
        } else {
          delegation = parsed.delegation.text;
        }
      }

      // A brief from the web app is reviewed there already: it goes on (ADR 0018).
      const approved = fromDraft
        ? delegation
        : await intercept(
            { kind: 'delegation', from: leader.name, to: worker.name, text: delegation, exchange },
            brief !== undefined,
          );
      if (fromDraft) await options.log.append('draft_delegation', { text: delegation });
      if (approved === undefined) return { status: 'cancelled', at: 'delegation' };

      const result = await turn(worker, 'worker', relay(approved));
      // A report that stopped on a missing decision goes to the leader as it is.
      const judged =
        options.reviewer && reportOutcome(result.text) !== 'bloccato'
          ? await reviewed(worker, relay(approved), result.text, exchange)
          : undefined;
      const facts = judged?.facts ?? (await factsFor(relay(approved), result.text));
      if (options.review === 'deferred') {
        return {
          status: 'delegated',
          spec: approved,
          report: judged?.report ?? result.text,
          facts,
          ...(judged ? { review: judged.review } : {}),
        };
      }
      const from = judged?.reviewer ?? worker.name;
      if (!brief) {
        const review = await intercept(
          {
            kind: 'review',
            from,
            to: leader.name,
            text: judged
              ? leaderReviewPrompt(judged.reviewer, judged.review, facts)
              : leaderResultPrompt(worker.name, result.text, facts),
            exchange,
          },
          true,
        );
        if (review === undefined) return { status: 'cancelled', at: 'review' };
        const final = (await turn(leader, 'orchestrator', relay(review))).text;
        return { status: 'completed', conclusion: final, exchanges: exchange };
      }
      const review = await intercept(
        {
          kind: 'review',
          from,
          to: leader.name,
          // A brief from the web app: the result is written on the review, when there is one.
          text: resultPrompt(from, judged?.review ?? result.text, facts, brief),
          exchange,
        },
        true,
      );
      if (review === undefined) return { status: 'cancelled', at: 'review' };
      const final = (await turn(leader, 'orchestrator', relay(review))).text;
      const block = extractResult(final);
      return {
        status: 'result',
        result: block ?? final,
        resultFound: block !== null,
        spec: approved,
        report: judged?.report ?? result.text,
        facts,
      };
    }
  }

  const done = (async (): Promise<LoopOutcome> => {
    let outcome: LoopOutcome;
    try {
      outcome = await run();
    } catch (error) {
      if (error instanceof Stopped || stopRequested()) outcome = { status: 'stopped' };
      else {
        const message = error instanceof Error ? error.message : String(error);
        await emit({ type: 'error', message });
        outcome = { status: 'failed', error: message };
      }
    }
    await Promise.allSettled(sessions.map((session) => session.close()));
    await emit({ type: 'finished', outcome });
    return outcome;
  })();

  let stopping: Promise<void> | undefined;
  return {
    done,
    stop() {
      stopping ??= (async () => {
        stopped = true;
        controller.abort();
        await options.log.append('stop_requested');
        await current?.stop();
        await done;
      })();
      return stopping;
    },
  };
}
