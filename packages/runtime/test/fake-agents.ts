// Deterministic in-process agents for the loop tests. Each turn plays the next
// scripted step: an answer (streamed in two chunks), an approval request
// followed by an answer, or a hang that only stop() ends.

import type {
  AgentFactory,
  AgentSession,
  AgentSessionOptions,
  AgentTurn,
  AgentTurnHandlers,
  ApprovalDecision,
} from '../src/index.js';

export type Step =
  | { readonly answer: string }
  | { readonly approval: string; readonly answer: string }
  | { readonly hang: true };

export interface FakeAgent {
  readonly factory: AgentFactory;
  /** Prompts received, in order. */
  readonly prompts: string[];
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
  const instructions: string[] = [];
  const options: AgentSessionOptions[] = [];
  const decisions: ApprovalDecision[] = [];
  let stops = 0;
  let closed = false;
  let next = 0;
  let started: () => void = () => undefined;
  let startedPromise = new Promise<void>((resolve) => (started = resolve));

  function runTurn(prompt: string, handlers: AgentTurnHandlers): AgentTurn {
    prompts.push(prompt);
    const step = steps[next++];
    let stop: () => void = () => undefined;
    const done = (async () => {
      started();
      startedPromise = new Promise<void>((resolve) => (started = resolve));
      if (step === undefined) throw new Error(`${name}: no scripted step for turn ${String(next)}`);
      if ('hang' in step) {
        await new Promise<void>((_resolve, reject) => {
          stop = () => {
            reject(new Error(`${name} turn interrupted`));
          };
        });
        throw new Error('unreachable');
      }
      if ('approval' in step) {
        decisions.push(
          await handlers.onApprovalRequest({ kind: 'command', summary: step.approval }),
        );
      }
      const half = Math.ceil(step.answer.length / 2);
      handlers.onText(step.answer.slice(0, half));
      handlers.onText(step.answer.slice(half));
      return {
        text: step.answer,
        identity: { provider: name, model: 'fake-model', effort: 'low', sessionId: `${id}-1` },
      };
    })();
    return {
      done,
      stop() {
        stops++;
        stop();
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

export function delegationBlock(
  goal = 'Verifica le proposte su executable.ts',
  recipient?: string,
): string {
  return [
    'Piano: analizzo il file e chiedo una verifica.',
    '',
    recipient ? `<<<DELEGA @${recipient}` : '<<<DELEGA',
    '## Obiettivo',
    goal,
    '## Contesto',
    'packages/adapters/src/codex/executable.ts',
    '## Vincoli',
    'Sola lettura.',
    '## Assunzioni',
    'Il file compila.',
    '## Domande aperte',
    'Nessuna',
    '## Output atteso',
    'Elenco delle proposte confermate o respinte.',
    'DELEGA>>>',
  ].join('\n');
}
