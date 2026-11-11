// What changes from one provider to another (ADR 0022), in one place: the chat
// asks for a role's sessions by what the role needs (its permission level,
// whether it is the leader) and each provider maps that onto its own harness.
// A new provider is one more entry here, plus its adapter.

import {
  CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
  CODEX_SUBAGENT_FORBIDDEN_NAMES,
  createClaudeAgentFactory,
  createCodexAgentFactory,
  type PermissionBridge,
} from '@only-one-chat/adapters';
import type { AgentFactory } from '@only-one-chat/runtime';
import type { AgentChoice, ChatConfig } from './chat.js';

/** A role as the chat needs it, without naming a provider. */
export interface RoleSpec {
  readonly choice: AgentChoice;
  /**
   * The leader (ADR 0018, 0019): read-only, it still runs commands to search
   * and check, and asks the user while it works.
   */
  readonly leader: boolean;
}

export interface Provider {
  readonly name: string;
  /**
   * Asks the user through the extension's permission bridge (Claude's hook);
   * without it, through its own protocol (Codex's server requests).
   */
  readonly bridged: boolean;
  readonly subagentForbiddenNames: readonly string[];
  factory(config: ChatConfig, role: RoleSpec, bridge: PermissionBridge | undefined): AgentFactory;
}

/** Said to a read-only role whose action would need a permission: the role's rule, not the user's answer. */
export const READ_ONLY_DENIAL =
  'Negato dal ruolo: in Only One Chat questo ruolo è in sola lettura e non modifica nulla; l’utente non è stato interpellato.';

export const PROVIDERS: Readonly<Record<AgentChoice['cli'], Provider>> = {
  /**
   * `read-only` in its read-only sandbox; `ask` asks before any command it does
   * not know to be safe; `auto` writes in the folder and asks to go beyond it.
   * The leader never asks to leave its sandbox.
   */
  codex: {
    name: 'Codex',
    bridged: false,
    subagentForbiddenNames: CODEX_SUBAGENT_FORBIDDEN_NAMES,
    factory: (config, { choice, leader }) =>
      createCodexAgentFactory({
        executable: config.codexExecutable,
        ...(config.codexLauncherArgs ? { launcherArgs: config.codexLauncherArgs } : {}),
        cwd: config.cwd,
        model: choice.model,
        effort: choice.effort,
        requestTimeoutMs: 120_000,
        writable: !leader && choice.permission !== 'read-only',
        questions: leader,
        approvalPolicy: leader ? 'never' : choice.permission === 'ask' ? 'untrusted' : 'on-request',
        persistent: config.persistent === true,
      }),
  },
  /**
   * `read-only` with its read tools; `ask` asks every edit and command through
   * the hook; `auto` is Claude Code's own auto mode (ADR 0021). The leader runs
   * only the commands Claude Code counts as read-only and asks its questions
   * in its turn (AskUserQuestion); what else would ask is denied as its role's rule.
   */
  claude: {
    name: 'Claude',
    bridged: true,
    subagentForbiddenNames: CLAUDE_SUBAGENT_FORBIDDEN_NAMES,
    factory: (config, { choice, leader }, bridge) => {
      const writable = !leader && choice.permission !== 'read-only';
      return createClaudeAgentFactory({
        executable: config.claudeExecutable,
        ...(config.claudeLauncherArgs ? { launcherArgs: config.claudeLauncherArgs } : {}),
        cwd: config.cwd,
        model: choice.model,
        effort: choice.effort,
        ...(writable
          ? { sandbox: { commands: config.allowedCommands, auto: choice.permission === 'auto' } }
          : {}),
        ...(leader ? { readOnlyShell: true, questions: { denyMessage: READ_ONLY_DENIAL } } : {}),
        // The model loads a skill by itself, as Codex does (ADR 0019).
        skills: true,
        ...(bridge
          ? {
              permissionHook: {
                settings: bridge.settings,
                env: bridge.env,
                askAll: choice.permission === 'ask',
              },
            }
          : {}),
      });
    },
  },
};
