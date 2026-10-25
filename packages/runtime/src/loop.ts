// The minimal D6 loop: user request → orchestrator plan and delegation →
// the user approves, edits or cancels it → worker → review message, again
// approved by the user → orchestrator review; at most `maxExchanges`
// delegations. In `question` mode the orchestrator only asks the worker one
// question and the loop ends with the worker's answer. Every event is
// appended to the event log; each answer carries a label written here from
// what the adapter observed, never from the agent's own text. Approval
// requests from agents are declined: not supported in this version.

import type {
  AgentFactory,
  AgentIdentity,
  AgentSession,
  AgentTurn,
  AgentTurnResult,
  ApprovalRequest,
  ApprovalDecision,
  SubagentEvent,
  SubagentPolicy,
} from './agent.js';
import {
  delegationTemplate,
  parseDelegation,
  DELEGATION_SECTIONS,
  DELEGATION_START,
  type DelegationParse,
} from './delegation.js';
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
  /** False once the correction allowed in `question` mode has been used. */
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
    }
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
      /** The orchestrator attributes work to an external agent that did not run. */
      readonly type: 'attribution_warning';
      readonly agent: string;
      readonly message: string;
    }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'finished'; readonly outcome: LoopOutcome };

export type LoopOutcome =
  | { readonly status: 'completed'; readonly conclusion: string; readonly exchanges: number }
  | { readonly status: 'limit_reached'; readonly conclusion: string; readonly exchanges: number }
  | {
      /** `question` mode: the worker answered the orchestrator's question. */
      readonly status: 'answered';
      readonly question: string;
      readonly answer: string;
      readonly label: string;
    }
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
  /**
   * `loop` (default): the D6 loop above. `question`: one delegation addressed
   * to the worker by id, one answer, one correction of a malformed block at most.
   */
  readonly mode?: 'loop' | 'question';
  /** Policies for the agents' own sub-agents (D13), per role. */
  readonly subagents?: {
    readonly orchestrator?: SubagentPolicy;
    readonly worker?: SubagentPolicy;
  };
}

export interface Loop {
  readonly done: Promise<LoopOutcome>;
  /** Interrupts the running turn, ends the loop with `stopped`. Idempotent. */
  stop(): Promise<void>;
}

export const MAX_EXCHANGES = 3;

/**
 * Sub-agent and attribution rules shared by every role (D13). The policy
 * values (model, effort, number) go in subagentRules, passed to the adapter.
 */
const AGENT_RULES = [
  'Sotto-agenti: puoi creare sotto-agenti solo se l’utente lo chiede esplicitamente. Sono istanze',
  'interne del tuo stesso CLI, non altri agenti. Gli altri agenti di Only One Chat sono esterni:',
  'li raggiungi solo con il blocco di delega, mai con un sotto-agente. Un sotto-agente non deve mai',
  'chiamarsi come un agente esterno o come un suo modello (per esempio claude, haiku, gemini, opus)',
  'né presentarsi come tale.',
  'Attribuzione: attribuisci a un agente esterno solo ciò che il runtime ti ha restituito come sua',
  'risposta; il lavoro tuo o dei tuoi sotto-agenti è tuo.',
];

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
  '',
  ...AGENT_RULES,
].join('\n');

export const WORKER_INSTRUCTIONS = [
  'Sei un agente worker di Only One Chat. Ricevi una delega con le sezioni',
  `${DELEGATION_SECTIONS.join(', ')}.`,
  'Lavori in sola lettura: puoi leggere e cercare nei file del workspace, non modificarli.',
  "Rispondi seguendo l'Output atteso, rispondi alle Domande aperte e indica le assunzioni che non",
  'hai potuto verificare.',
  'L’orchestratore è un agente esterno: ti scrive solo tramite il runtime. I tuoi sotto-agenti',
  'sono interni e vanno creati solo se servono al compito.',
  '',
  ...AGENT_RULES.slice(2),
].join('\n');

/** Role instructions for `question` mode: ask, do not answer. */
export function questionInstructions(workerId: string): string {
  return [
    "Sei l'orchestratore di Only One Chat. In questa conversazione non rispondi tu: formuli UNA",
    `domanda per l'agente "${workerId}" e la invii con UN SOLO blocco di delega, esattamente in`,
    'questo formato, con il destinatario sulla prima riga:',
    '',
    delegationTemplate(workerId),
    '',
    'Regole: le righe di apertura e di chiusura del blocco stanno da sole sulla propria riga; le',
    `sezioni sono esattamente ${DELEGATION_SECTIONS.join(', ')}, in quest'ordine, ciascuna con un`,
    'titolo "## " e nessuna vuota (scrivi "Nessuna" se non ci sono domande aperte); la domanda va in',
    'Obiettivo. Non leggere file e non eseguire comandi: la risposta la dà l’altro agente. Fuori dal',
    'blocco scrivi al massimo una riga.',
    '',
    ...AGENT_RULES,
  ].join('\n');
}

/** The policy values in words, for the adapter's sub-agent hints. */
export function subagentRules(policy: SubagentPolicy): string {
  return [
    `I sotto-agenti usano sempre il modello ${policy.model} con effort ${policy.effort}: non`,
    `sceglierne altri. Al massimo ${String(policy.maxConcurrent)} sotto-agenti alla volta. Nomi`,
    `vietati per un sotto-agente: ${policy.forbiddenNames.join(', ')}.`,
    '',
    ...AGENT_RULES,
  ].join('\n');
}

export interface SubagentState {
  readonly id: string;
  readonly name: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly status: 'running' | 'completed' | 'interrupted' | 'failed';
}

const SUBAGENT_STATUS: Readonly<Record<SubagentState['status'], string>> = {
  running: 'in corso',
  completed: 'completato',
  interrupted: 'interrotto',
  failed: 'fallito',
};

/** Label of a sub-agent: parent agent, name, model, effort and status, as observed. */
export function subagentLabel(parent: string, subagent: SubagentState): string {
  return [
    `${parent} › ${subagent.name}`,
    subagent.model ?? 'modello non riportato',
    `effort ${subagent.effort ?? 'non riportato'}`,
    SUBAGENT_STATUS[subagent.status],
  ].join(' · ');
}

/** True when `name` contains `word` as a whole word, any case ("/root/claude_review", "claude"). */
function hasWord(name: string, word: string): boolean {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .includes(word.toLowerCase());
}

/**
 * Checks a sub-agent against its role's policy, after the fact (D13): a model or
 * effort other than the imposed one, an external agent's name, too many at once.
 * Values the CLI did not report are not violations. Returns the reason, if any.
 */
export function checkSubagent(
  policy: SubagentPolicy,
  subagent: Pick<SubagentState, 'name' | 'model' | 'effort'>,
  running: number,
): string | undefined {
  const forbidden = policy.forbiddenNames.find((name) => hasWord(subagent.name, name));
  if (forbidden !== undefined) {
    return `il nome "${subagent.name}" coincide con l'agente esterno "${forbidden}"`;
  }
  if (subagent.model !== null && subagent.model.toLowerCase() !== policy.model.toLowerCase()) {
    return `modello ${subagent.model} invece di ${policy.model}`;
  }
  if (subagent.effort !== null && subagent.effort.toLowerCase() !== policy.effort.toLowerCase()) {
    return `effort ${subagent.effort} invece di ${policy.effort}`;
  }
  if (running > policy.maxConcurrent) {
    return `${String(running)} sotto-agenti contemporanei, al massimo ${String(policy.maxConcurrent)}`;
  }
  return undefined;
}

/** External agents named in `text` although none of them ran in this loop. */
export function falseAttributions(text: string, externalNames: readonly string[]): string[] {
  return externalNames.filter((name) =>
    new RegExp(
      `(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`,
      'iu',
    ).test(text),
  );
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

function sessionOptions(instructions: string, policy: SubagentPolicy | undefined) {
  return policy
    ? { instructions, subagents: { ...policy, rules: subagentRules(policy) } }
    : { instructions };
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

  async function turn(session: AgentSession, role: Role, prompt: string): Promise<AgentTurnResult> {
    checkStopped();
    await emit({ type: 'turn_started', role, agent: session.name });
    const policy =
      role === 'orchestrator' ? options.subagents?.orchestrator : options.subagents?.worker;
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
      onSubagent,
    });
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
      });
      return result;
    } catch (error) {
      if (violation === undefined) checkStopped();
      throw error;
    } finally {
      current = undefined;
    }
  }

  /** Names of external agents, for the attribution check: the worker and the policy's list. */
  function externalNames(worker: AgentSession | undefined): string[] {
    const names = new Set(options.subagents?.orchestrator?.forbiddenNames ?? []);
    if (worker) names.add(worker.id);
    return [...names];
  }

  async function concluded(
    orchestrator: AgentSession,
    worker: AgentSession | undefined,
    conclusion: string,
    workerTurns: number,
  ): Promise<void> {
    if (workerTurns > 0) return;
    for (const agent of falseAttributions(conclusion, externalNames(worker))) {
      await emit({
        type: 'attribution_warning',
        agent,
        message: `${orchestrator.name} attribuisce lavoro a "${agent}", che in questo ciclo non è stato eseguito.`,
      });
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

  const question = options.mode === 'question';

  /** Format errors, plus recipient errors once the worker is known. */
  function check(answer: string, workerId: string | undefined): DelegationParse {
    const parsed = parseDelegation(answer);
    if (parsed.status !== 'valid' || workerId === undefined) return parsed;
    const { recipient } = parsed.delegation;
    if (recipient === null && question) {
      return {
        status: 'malformed',
        errors: [`the start line must name the recipient: "${DELEGATION_START} @${workerId}"`],
      };
    }
    if (recipient !== null && recipient !== workerId.toLowerCase()) {
      return {
        status: 'malformed',
        errors: [`unknown recipient "@${recipient}": the only agent is "@${workerId}"`],
      };
    }
    return parsed;
  }

  async function run(): Promise<LoopOutcome> {
    await options.log.append('loop_started', {
      request: options.request,
      maxExchanges: max,
      mode: question ? 'question' : 'loop',
    });
    // A question names its recipient, so the worker session exists first.
    let worker: AgentSession | undefined = question
      ? await options.worker(sessionOptions(WORKER_INSTRUCTIONS, options.subagents?.worker))
      : undefined;
    if (worker) sessions.push(worker);
    const orchestrator = await options.orchestrator(
      sessionOptions(
        worker ? questionInstructions(worker.id) : ORCHESTRATOR_INSTRUCTIONS,
        options.subagents?.orchestrator,
      ),
    );
    sessions.push(orchestrator);

    let answer = (await turn(orchestrator, 'orchestrator', requestPrompt(options.request))).text;
    let exchange = 0;
    let fixes = 0;
    for (;;) {
      const parsed = check(answer, worker?.id);
      if (parsed.status === 'absent' && question) {
        throw new Error('The orchestrator answered without asking the worker a question');
      }
      if (parsed.status === 'absent') {
        await concluded(orchestrator, worker, answer, exchange);
        return { status: 'completed', conclusion: answer, exchanges: exchange };
      }
      if (exchange >= max) {
        await concluded(orchestrator, worker, answer, exchange);
        return { status: 'limit_reached', conclusion: answer, exchanges: exchange };
      }
      let delegation: string;
      if (parsed.status === 'malformed') {
        await emit({ type: 'delegation_invalid', errors: parsed.errors });
        const canAskOrchestrator = !question || fixes < 1;
        const decision = await abortable(
          options.onMalformedDelegation(
            { answer, errors: parsed.errors, exchange: exchange + 1, canAskOrchestrator },
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
          if (!canAskOrchestrator) {
            throw new Error('The delegation block is still malformed after the one correction');
          }
          fixes++;
          answer = (await turn(orchestrator, 'orchestrator', fixPrompt(parsed.errors))).text;
          continue;
        }
        delegation = decision.text;
      } else {
        delegation = parsed.delegation.text;
      }

      exchange++;
      worker ??= await options.worker(
        sessionOptions(WORKER_INSTRUCTIONS, options.subagents?.worker),
      );
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
      if (question) {
        return {
          status: 'answered',
          question: approved,
          answer: result.text,
          label: agentLabel(result.identity),
        };
      }
      const review = await intercept({
        kind: 'review',
        from: worker.name,
        to: orchestrator.name,
        text: reviewPrompt(worker.name, result.text, exchange, max),
        exchange,
      });
      if (review === undefined) return { status: 'cancelled', at: 'review' };
      answer = (await turn(orchestrator, 'orchestrator', review)).text;
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
