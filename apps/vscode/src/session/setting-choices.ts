// The reviewer and the sub-agents as the settings choose them, each model
// checked before it reaches a CLI (security.md T13, ADR 0050): the views'
// pattern, and the CLI's catalog once read. Pure, no `vscode`: roles.ts reads
// the settings and says what was set aside.

import { isModel, type Cli } from '../shared/protocol.js';
import type { ModelCatalog } from './catalog.js';
import type { ProviderChoice } from './providers.js';

/** A setting's value and its declared default. */
export type Setting = (key: string) => { readonly value: unknown; readonly fallback: unknown };
/** Told once per value set aside. */
export type Rejected = (key: string, value: unknown) => void;

/**
 * A model setting, settled; an empty one is kept where the CLI picks its own.
 * Without a catalog, the pattern alone: the sub-agents' models are full ids the
 * catalogs, made of the main models' aliases, need not list.
 */
function model(
  catalog: ModelCatalog | null,
  cli: Cli,
  setting: Setting,
  key: string,
  rejected: Rejected,
  emptyOk = false,
): string {
  const { value, fallback } = setting(key);
  if (emptyOk && value === '') return '';
  const settled = catalog
    ? catalog.settled(cli, value, fallback)
    : isModel(value)
      ? { model: value, rejected: false }
      : { model: isModel(fallback) ? fallback : '', rejected: true };
  if (settled.rejected) rejected(key, value);
  return settled.model;
}

/**
 * The reviewer (ADR 0029, 0033): any provider; it writes tests, never the
 * code, whatever `permission` says. `rounds` is how many times its findings
 * may go back to the implementer.
 */
export function reviewerOf(
  catalog: ModelCatalog,
  setting: Setting,
  rejected: Rejected,
): { enabled: boolean; choice: ProviderChoice; rounds: number } {
  const given = setting('reviewer.cli').value;
  const cli = given === 'codex' || given === 'antigravity' ? given : 'claude';
  const rounds = setting('reviewer.rounds').value;
  const effort = setting('reviewer.effort').value;
  return {
    enabled: setting('reviewer.enabled').value === true,
    choice: {
      cli,
      // Antigravity runs its default model with none (reviewerFor).
      model: model(catalog, cli, setting, 'reviewer.model', rejected, cli === 'antigravity'),
      effort: typeof effort === 'string' ? effort : 'low',
      permission: 'read-only',
    },
    rounds:
      typeof rounds === 'number' && Number.isFinite(rounds)
        ? Math.max(0, Math.min(3, Math.trunc(rounds)))
        : 2,
  };
}

/** The models and effort of each CLI's own sub-agents (D13), on the pattern alone. */
export function subagentsOf(
  setting: Setting,
  rejected: Rejected,
): {
  codex: { model: string; effort: string };
  claude: { model: string; effort: string };
} {
  const given = setting('subagents.effort').value;
  const effort = typeof given === 'string' ? given : 'low';
  return {
    codex: { model: model(null, 'codex', setting, 'subagents.codexModel', rejected), effort },
    claude: { model: model(null, 'claude', setting, 'subagents.claudeModel', rejected), effort },
  };
}
