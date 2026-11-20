import type { TurnStep } from './agent.js';
import type { CriterionResult, Report } from './handoff.js';

type CommandStep = Extract<TurnStep, { kind: 'command' }>;

/** Only the fields needed for the assessment. The existing activity owns command output. */
type Observation = Pick<
  CommandStep,
  'command' | 'commandInput' | 'status' | 'exitCode' | 'evidence'
>;

/** One role's command observations for one work round, possibly spanning a handoff retry. */
export class CommandEvidence {
  private readonly turns: Map<string, Observation>[] = [];

  nextTurn(): (step: TurnStep) => void {
    const steps = new Map<string, Observation>();
    this.turns.push(steps);
    return (step) => {
      if (step.kind !== 'command') return;
      const { id, command, commandInput, status, exitCode, evidence } = step;
      steps.set(id, {
        command,
        status,
        exitCode,
        ...(commandInput === undefined ? {} : { commandInput }),
        ...(evidence === undefined ? {} : { evidence }),
      });
    };
  }

  render(criteria: readonly CriterionResult[], role: 'Implementer' | 'Reviewer'): string {
    const outcomes = new Map<string, string[]>();
    for (const turn of this.turns) {
      for (const { command, commandInput, status, exitCode, evidence } of turn.values()) {
        if (evidence === 'title' || evidence === 'denied' || !command.trim()) continue;
        const detail =
          exitCode === null
            ? status === 'failed'
              ? 'tool error'
              : 'tool success'
            : `exit ${String(exitCode)}`;
        const outcome =
          status === 'running' || evidence === 'incomplete'
            ? 'observed with incomplete outcome'
            : `observed with outcome (${detail})`;
        for (const key of new Set([command.trim(), commandInput?.trim()])) {
          if (!key) continue;
          const entries = outcomes.get(key) ?? [];
          entries.push(outcome);
          outcomes.set(key, entries);
        }
      }
    }
    const lines = criteria.flatMap(({ id, commands = [] }) =>
      commands.map(
        (command, index) =>
          `- ${id}, command ${String(index + 1)}: ${outcomes.get(command.trim())?.join(', ') ?? 'no matching command observed'}`,
      ),
    );
    return lines.length === 0
      ? ''
      : [`## ${role} command evidence (runtime)`, '', ...lines].join('\n');
  }
}

/** The assessed report leaves the command references in memory, out of the loop outcome and log. */
export function reportWithoutCommandReferences(report: Report): Report {
  const criteria = report.criteria.map(({ id, status, evidence }) => ({ id, status, evidence }));
  return { ...report, criteria };
}
