// The minimal D6 loop: user request → orchestrator plan and delegation →
// the user approves, edits or cancels it → worker → review message, again
// approved by the user → orchestrator review; at most `maxExchanges`
// delegations. Every event is appended to the event log. Approval requests
// from agents are declined: not supported in this version.

import type {
  AgentFactory,
  AgentSession,
  AgentTurn,
  ApprovalRequest,
  ApprovalDecision,
} from './agent.js';
import { delegationTemplate, parseDelegation, DELEGATION_SECTIONS } from './delegation.js';
import type { EventLog } from './event-log.js';

export type Role = 'orchestrator' | 'worker';

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
}

export type MalformedDecision =
  | { readonly action: 'ask_orchestrator' }
  | { readonly action: 'edit'; readonly text: string }
  | { readonly action: 'cancel' };

export type ThreadEvent =
  | { readonly type: 'turn_started'; readonly role: Role; readonly agent: string }
  | { readonly type: 'text'; readonly role: Role; readonly text: string }
  | { readonly type: 'message'; readonly role: Role; readonly agent: string; readonly text: string }
  | {
      readonly type: 'approval_denied';
      readonly role: Role;
      readonly agent: string;
      readonly request: ApprovalRequest;
      readonly message: string;
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
      readonly action: string;
      readonly text?: string;
    }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'finished'; readonly outcome: LoopOutcome };

export type LoopOutcome =
  | { readonly status: 'completed'; readonly conclusion: string; readonly exchanges: number }
  | { readonly status: 'limit_reached'; readonly conclusion: string; readonly exchanges: number }
  | { readonly status: 'cancelled'; readonly at: 'delegation' | 'review' | 'malformed' }
  | { readonly status: 'stopped' }
  | { readonly status: 'failed'; readonly error: string };

export interface LoopOptions {
  readonly request: string;
  readonly orchestrator: AgentFactory;
  readonly worker: AgentFactory;
  readonly log: EventLog;
  /** Shows a message before it reaches an agent; nothing is sent without approval. */
  intercept(message: InterceptedMessage, signal: AbortSignal): Promise<InterceptDecision>;
  /** The orchestrator's delegation does not follow the format: the user decides. */
  onMalformedDelegation(
    problem: MalformedDelegation,
    signal: AbortSignal,
  ): Promise<MalformedDecision>;
  onEvent?(event: ThreadEvent): void;
  /** Default and maximum 3. */
  readonly maxExchanges?: number;
}

export interface Loop {
  readonly done: Promise<LoopOutcome>;
  /** Interrupts the running turn, ends the loop with `stopped`. Idempotent. */
  stop(): Promise<void>;
}

export const MAX_EXCHANGES = 3;

export const ORCHESTRATOR_INSTRUCTIONS = [
  "Sei l'orchestratore di Only One Chat e coordini un altro agente, il worker.",
  'Lavori in sola lettura nel workspace: non modifichi file e non esegui comandi che scrivono.',
  "Per la richiesta dell'utente scrivi prima un breve piano, poi delega al worker il lavoro",
  'con UN SOLO blocco di delega, esattamente in questo formato:',
  '',
  delegationTemplate(),
  '',
  'Regole del blocco: le righe <<<DELEGA e DELEGA>>> stanno da sole sulla propria riga; le sezioni',
  `sono esattamente ${DELEGATION_SECTIONS.join(', ')}, in quest'ordine, ciascuna con un titolo "## "`,
  'e nessuna vuota (scrivi "Nessuna" se non ci sono domande aperte); nessun altro testo dentro il',
  'blocco. Quando ricevi il risultato del worker valutalo: se serve un altro passaggio scrivi un',
  'nuovo blocco nello stesso formato, altrimenti scrivi la conclusione per l’utente senza blocchi.',
].join('\n');

export const WORKER_INSTRUCTIONS = [
  'Sei un agente worker di Only One Chat. Ricevi una delega con le sezioni',
  `${DELEGATION_SECTIONS.join(', ')}.`,
  'Lavori in sola lettura: puoi leggere e cercare nei file del workspace, non modificarli.',
  "Rispondi seguendo l'Output atteso, rispondi alle Domande aperte e indica le assunzioni che non",
  'hai potuto verificare.',
].join('\n');

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

export function requestPrompt(request: string): string {
  return `Richiesta dell'utente:\n\n${request}`;
}

export function reviewPrompt(
  worker: string,
  answer: string,
  exchange: number,
  max: number,
): string {
  const next =
    exchange < max
      ? 'Se serve un altro passaggio scrivi un nuovo blocco di delega, altrimenti scrivi la conclusione per l’utente.'
      : 'Questo era l’ultimo scambio possibile: non delegare più e scrivi la conclusione per l’utente.';
  return `Risultato di ${worker} (scambio ${String(exchange)} di ${String(max)}):\n\n${answer}\n\nValuta il risultato rispetto alla delega. ${next}`;
}

export function fixPrompt(errors: readonly string[]): string {
  return `Il blocco di delega non rispetta il formato: ${errors.join('; ')}. Riscrivi il blocco esattamente nel formato richiesto.`;
}

export function runLoop(options: LoopOptions): Loop {
  const max = Math.min(options.maxExchanges ?? MAX_EXCHANGES, MAX_EXCHANGES);
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

  function checkStopped(): void {
    if (stopped) throw new Stopped();
  }

  async function turn(session: AgentSession, role: Role, prompt: string): Promise<string> {
    checkStopped();
    await emit({ type: 'turn_started', role, agent: session.name });
    const running = session.runTurn(prompt, {
      onText: (text) => {
        options.onEvent?.({ type: 'text', role, text });
      },
      onApprovalRequest: async (request): Promise<ApprovalDecision> => {
        await emit({
          type: 'approval_denied',
          role,
          agent: session.name,
          request,
          message: APPROVAL_DENIED_MESSAGE,
        });
        return 'decline';
      },
      onActivity: (activity) => {
        void emit({ type: 'activity', role, ...activity });
      },
    });
    current = running;
    try {
      const { text } = await running.done;
      checkStopped();
      await emit({ type: 'message', role, agent: session.name, text });
      return text;
    } catch (error) {
      checkStopped();
      throw error;
    } finally {
      current = undefined;
    }
  }

  async function intercept(message: InterceptedMessage): Promise<string | undefined> {
    checkStopped();
    await emit({ type: 'intercepted', message });
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

  async function run(): Promise<LoopOutcome> {
    await options.log.append('loop_started', { request: options.request, maxExchanges: max });
    const orchestrator = await options.orchestrator({ instructions: ORCHESTRATOR_INSTRUCTIONS });
    sessions.push(orchestrator);
    let worker: AgentSession | undefined;

    let answer = await turn(orchestrator, 'orchestrator', requestPrompt(options.request));
    let exchange = 0;
    for (;;) {
      const parsed = parseDelegation(answer);
      if (parsed.status === 'absent') {
        return { status: 'completed', conclusion: answer, exchanges: exchange };
      }
      if (exchange >= max) {
        return { status: 'limit_reached', conclusion: answer, exchanges: exchange };
      }
      let delegation: string;
      if (parsed.status === 'malformed') {
        await emit({ type: 'delegation_invalid', errors: parsed.errors });
        const decision = await abortable(
          options.onMalformedDelegation(
            { answer, errors: parsed.errors, exchange: exchange + 1 },
            controller.signal,
          ),
          controller.signal,
        );
        checkStopped();
        await emit({
          type: 'decision',
          kind: 'malformed',
          action: decision.action,
          ...(decision.action === 'edit' ? { text: decision.text } : {}),
        });
        if (decision.action === 'cancel') return { status: 'cancelled', at: 'malformed' };
        if (decision.action === 'ask_orchestrator') {
          answer = await turn(orchestrator, 'orchestrator', fixPrompt(parsed.errors));
          continue;
        }
        delegation = decision.text;
      } else {
        delegation = parsed.delegation.text;
      }

      exchange++;
      worker ??= await options.worker({ instructions: WORKER_INSTRUCTIONS });
      if (!sessions.includes(worker)) sessions.push(worker);
      const approved = await intercept({
        kind: 'delegation',
        from: orchestrator.name,
        to: worker.name,
        text: delegation,
        exchange,
      });
      if (approved === undefined) return { status: 'cancelled', at: 'delegation' };

      const result = await turn(worker, 'worker', approved);
      const review = await intercept({
        kind: 'review',
        from: worker.name,
        to: orchestrator.name,
        text: reviewPrompt(worker.name, result, exchange, max),
        exchange,
      });
      if (review === undefined) return { status: 'cancelled', at: 'review' };
      answer = await turn(orchestrator, 'orchestrator', review);
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
