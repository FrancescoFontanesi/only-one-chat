// A sub-agent as the runtime observes it: its label in the thread and the
// check of its model, effort, name and number against its role's policy (D13).

import type { SubagentPolicy } from './agent.js';

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
