// Deterministic in-process agents for the loop tests. Each turn plays the next
// scripted step: an answer (streamed in two chunks) that may carry the calls to
// the handoff tools the adapter would report (ADR 0035), an approval request
// followed by an answer, or a hang that only stop() ends.

import type {
  AgentFactory,
  AgentQuestion,
  AgentSession,
  AgentSessionOptions,
  AgentTurn,
  AgentTurnHandlers,
  ApprovalDecision,
  HandoffCall,
  HandoffServer,
  SubagentEvent,
  TurnOptions,
} from '../src/index.js';

export type Step =
  | {
      readonly answer: string;
      readonly subagents?: readonly SubagentEvent[];
      /** The handoff calls of the turn, as the adapter reports them. */
      readonly handoffs?: readonly HandoffCall[];
    }
  | {
      readonly approval: string;
      readonly answer: string;
      readonly handoffs?: readonly HandoffCall[];
    }
  /** Asks the user (ADR 0019); `answer` then carries the answers given, as JSON, after it. */
  | { readonly ask: readonly AgentQuestion[]; readonly answer: string }
  | { readonly hang: true; readonly subagents?: readonly SubagentEvent[] };

export interface FakeAgent {
  readonly factory: AgentFactory;
  /** Prompts received, in order. */
  readonly prompts: string[];
  /** The skill each turn was given, in order (ADR 0019). */
  readonly skills: (string | undefined)[];
  readonly instructions: string[];
  /** Session options received by the factory, in order. */
  readonly options: AgentSessionOptions[];
  readonly decisions: ApprovalDecision[];
  readonly stops: number;
  readonly closed: boolean;
  /** Resolves when a turn is running (for stop tests). */
  turnStarted(): Promise<void>;
}

export function fakeAgent(
  name: string,
  steps: readonly Step[],
  id = name.toLowerCase(),
): FakeAgent {
  const prompts: string[] = [];
  const skills: (string | undefined)[] = [];
  const instructions: string[] = [];
  const options: AgentSessionOptions[] = [];
  const decisions: ApprovalDecision[] = [];
  let stops = 0;
  let closed = false;
  let next = 0;
  let started: () => void = () => undefined;
  let startedPromise = new Promise<void>((resolve) => (started = resolve));

  function runTurn(
    prompt: string,
    handlers: AgentTurnHandlers,
    turnOptions?: TurnOptions,
  ): AgentTurn {
    prompts.push(prompt);
    skills.push(turnOptions?.skill?.name);
    const step = steps[next++];
    let stop: () => void = () => undefined;
    const stopsAtStart = stops;
    const done = (async () => {
      started();
      startedPromise = new Promise<void>((resolve) => (started = resolve));
      if (step === undefined) throw new Error(`${name}: no scripted step for turn ${String(next)}`);
      // Sub-agent events arrive after the turn has started, as from a CLI.
      await Promise.resolve();
      for (const event of 'subagents' in step ? (step.subagents ?? []) : []) {
        handlers.onSubagent?.(event);
      }
      if ('hang' in step) {
        await new Promise<void>((_resolve, reject) => {
          stop = () => {
            reject(new Error(`${name} turn interrupted`));
          };
        });
        throw new Error('unreachable');
      }
      if (stops > stopsAtStart) throw new Error(`${name} turn interrupted`);
      if ('approval' in step) {
        decisions.push(
          await handlers.onApprovalRequest({ kind: 'command', summary: step.approval }),
        );
      }
      const answer =
        'ask' in step
          ? `${step.answer} ${JSON.stringify((await handlers.onQuestion?.(step.ask)) ?? 'no-handler')}`
          : step.answer;
      const half = Math.ceil(answer.length / 2);
      handlers.onText(answer.slice(0, half));
      handlers.onText(answer.slice(half));
      return {
        text: answer,
        identity: { provider: name, model: 'fake-model', effort: 'low', sessionId: `${id}-1` },
        ...('handoffs' in step ? { handoffs: step.handoffs } : {}),
      };
    })();
    return {
      done,
      stop() {
        stops++;
        stop();
        stop = () => undefined;
        return Promise.resolve();
      },
    };
  }

  const session: AgentSession = {
    name,
    id,
    runTurn,
    close() {
      closed = true;
      return Promise.resolve();
    },
  };
  return {
    factory: (sessionOptions) => {
      instructions.push(sessionOptions.instructions);
      options.push(sessionOptions);
      return Promise.resolve(session);
    },
    prompts,
    skills,
    instructions,
    options,
    decisions,
    get stops() {
      return stops;
    },
    get closed() {
      return closed;
    },
    turnStarted: () => startedPromise,
  };
}

export const SERVER: HandoffServer = { command: 'node', args: ['handoff-main.js'] };

export const call = (tool: string, args: unknown): HandoffCall => ({ tool, arguments: args });

type Args = Record<string, unknown>;

/** Valid arguments of each tool, with the fields a test changes. */
export const delegateArgs = (over: Args = {}): Args => ({
  goal: 'ans reuses the last result.',
  context: 'calc.py',
  acceptance_criteria: ['1 + 2, then ans * 10 → 30.', '1/0, then ans → an error, ans unchanged.'],
  verification: '`python -m unittest`',
  ...over,
});
export const reportArgs = (over: Args = {}): Args => ({
  outcome: 'done',
  summary: 'ans added.',
  changes: [{ path: 'calc.py', change: 'ans, for C1' }],
  criteria: [
    { id: 'C1', status: 'verified', evidence: 'test_ans' },
    { id: 'C2', status: 'verified', evidence: 'python -m unittest: exit 0' },
  ],
  ...over,
});
export const findingsArgs = (over: Args = {}): Args => ({
  items: [
    {
      id: 'R1',
      severity: 'blocking',
      issue: 'ans is 0 after an error.',
      evidence: 'python calc.py "1/0" "ans" → expected an error, got 0.',
      criterion: 'C1',
    },
  ],
  ...over,
});
export const reviewArgs = (over: Args = {}): Args => ({
  verdict: 'approved',
  summary: 'One round.',
  criteria: [
    { id: 'C1', status: 'verified', evidence: 'python calc.py: 30' },
    { id: 'C2', status: 'verified', evidence: 'unittest: ok' },
  ],
  axes: { honesty: 'clean', security: 'clean', currency: 'clean' },
  ...over,
});

export const delegate = (over: Args = {}) => call('delegate', delegateArgs(over));
export const report = (over: Args = {}) => call('report', reportArgs(over));
export const findings = (over: Args = {}) => call('findings', findingsArgs(over));
export const review = (over: Args = {}) => call('review', reviewArgs(over));
