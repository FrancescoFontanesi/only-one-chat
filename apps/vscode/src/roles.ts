// The roles as the user assigns them in the roles view (ADR 0012): kept in the
// settings (onlyOneChat.<role>.cli/model/effort, and the implementer's
// permission: the leader is read-only, ADR 0018), checked against
// the models the CLIs offer, and announced once a change is written in full.

import * as vscode from 'vscode';
import type { AgentChoice } from './session/chat.js';
import type { ModelCatalog } from './session/catalog.js';
import { nodesOf, type NodeChoice } from './session/node.js';
import { PROVIDERS, type ProviderChoice } from './session/providers.js';
import {
  EFFORTS,
  type NodeInfo,
  type PermissionLevel,
  type RoleInfo,
  type RoleName,
  type RolesState,
} from './shared/protocol.js';

export interface Roles {
  readonly leader: AgentChoice;
  readonly implementer: AgentChoice;
}

/** The roles of the chat shown, if its agents have started, and when they change. */
export interface ChatRoles {
  current(): Roles | null;
  readonly onDidChange: vscode.Event<void>;
}

const KEYS = ['cli', 'model', 'effort', 'permission'] as const;

function choiceOf(settings: vscode.WorkspaceConfiguration, role: RoleName): AgentChoice {
  const cli = settings.get<string>(`${role}.cli`);
  const permission = settings.get<string>(`${role}.permission`);
  return {
    cli: cli === 'claude' ? 'claude' : 'codex',
    model: settings.get<string>(`${role}.model`) ?? '',
    effort: settings.get<string>(`${role}.effort`) ?? 'low',
    // The leader never writes (ADR 0018): read-only, not a setting.
    permission: (role === 'leader'
      ? 'read-only'
      : permission === 'read-only' || permission === 'ask'
        ? permission
        : 'auto') satisfies PermissionLevel,
  };
}

export class RoleSettings implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when the roles changed: from the roles view or in the settings. */
  readonly onDidChange = this.emitter.event;
  /** A change is being written key by key: its partial states are not announced. */
  private writing = 0;
  private readonly subscription: vscode.Disposable;
  private readonly unsubscribeCatalog: () => void;

  constructor(private readonly catalog: ModelCatalog) {
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      const touched = (['leader', 'implementer', 'reviewer', 'nodes', 'team'] as const).some(
        (role) => event.affectsConfiguration(`onlyOneChat.${role}`),
      );
      if (touched && this.writing === 0) this.emitter.fire();
    });
    // The models' names arrive with the catalog.
    this.unsubscribeCatalog = catalog.onChange(() => {
      this.emitter.fire();
    });
  }

  get(): Roles {
    const settings = vscode.workspace.getConfiguration('onlyOneChat');
    return { leader: choiceOf(settings, 'leader'), implementer: choiceOf(settings, 'implementer') };
  }

  /** A role as the views show it, with its model's name when the catalog is read. */
  info(choice: ProviderChoice): RoleInfo {
    return {
      ...choice,
      modelName: this.catalog.find(choice.cli, choice.model)?.name ?? choice.model,
    };
  }

  /** Why a choice cannot be taken, or undefined. */
  problem(choice: ProviderChoice): string | undefined {
    if (this.catalog.rejects(choice.cli, choice.model)) {
      return `${PROVIDERS[choice.cli].name}  does not offer the model ${choice.model}.`;
    }
    const model = this.catalog.find(choice.cli, choice.model);
    const efforts: readonly string[] = model ? model.efforts : EFFORTS;
    if (choice.effort === '' ? efforts.length > 0 : !efforts.includes(choice.effort)) {
      return `The model ${choice.model} does not support the ${choice.effort || 'empty'} reasoning effort.`;
    }
    return undefined;
  }

  /** What the roles view and the settings page show: the next chats' roles, the chat's, the models. */
  state(chat: Roles | null, fake: boolean): RolesState {
    const next = this.get();
    return {
      roles: { leader: this.info(next.leader), implementer: this.info(next.implementer) },
      chat: chat
        ? { leader: this.info(chat.leader), implementer: this.info(chat.implementer) }
        : null,
      catalog: this.catalog.snapshot(),
      nodes: this.nodes().map((node): NodeInfo => ({
        ...this.info(node),
        id: node.id,
        name: node.name,
      })),
      team: this.team((chat ?? next).leader.cli),
      reviewer: (({ enabled, choice }) => ({ ...this.info(choice), enabled }))(this.reviewer()),
      fake,
    };
  }

  /**
   * The reviewer (ADR 0029, 0033): any provider; it writes tests, never the
   * code, whatever `permission` says. `rounds` is how many times its findings
   * may go back to the implementer.
   */
  reviewer(): {
    enabled: boolean;
    choice: ProviderChoice;
    rounds: number;
  } {
    const settings = vscode.workspace.getConfiguration('onlyOneChat');
    const cli = settings.get<string>('reviewer.cli');
    const rounds = settings.get<number>('reviewer.rounds') ?? 2;
    return {
      enabled: settings.get<boolean>('reviewer.enabled') === true,
      choice: {
        cli: cli === 'codex' || cli === 'antigravity' ? cli : 'claude',
        model: settings.get<string>('reviewer.model') ?? '',
        effort: settings.get<string>('reviewer.effort') ?? 'low',
        permission: 'read-only',
      },
      rounds: Number.isFinite(rounds) ? Math.max(0, Math.min(3, Math.trunc(rounds))) : 2,
    };
  }

  /** The reviewer switched on or off from Squad (ADR 0033): where it is set, else the user's. */
  async setReviewerOn(enabled: boolean): Promise<void> {
    const settings = vscode.workspace.getConfiguration('onlyOneChat');
    const where = settings.inspect('reviewer.enabled');
    const target =
      where?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : where?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await settings.update('reviewer.enabled', enabled, target);
  }

  /** The reviewer chosen in the settings page: written if its CLI offers it, else the user is told. */
  async setReviewer(choice: Pick<ProviderChoice, 'cli' | 'model' | 'effort'>): Promise<boolean> {
    const problem = this.problem({ ...choice, permission: 'read-only' });
    if (problem) {
      void vscode.window.showWarningMessage(problem);
      return false;
    }
    const settings = vscode.workspace.getConfiguration('onlyOneChat');
    this.writing++;
    try {
      for (const key of ['cli', 'model', 'effort'] as const) {
        const name = `reviewer.${key}`;
        const where = settings.inspect(name);
        const target =
          where?.workspaceFolderValue !== undefined
            ? vscode.ConfigurationTarget.WorkspaceFolder
            : where?.workspaceValue !== undefined
              ? vscode.ConfigurationTarget.Workspace
              : vscode.ConfigurationTarget.Global;
        if (settings.get(name) !== choice[key]) await settings.update(name, choice[key], target);
      }
    } finally {
      this.writing--;
    }
    this.emitter.fire();
    return true;
  }

  /** The group of the leader and the implementer (ADR 0028): its alias, else the leader's provider. */
  team(leader: AgentChoice['cli']): { name: string; alias: string } {
    const alias = (
      vscode.workspace.getConfiguration('onlyOneChat').get<string>('team.name') ?? ''
    ).trim();
    return { name: alias || PROVIDERS[leader].name, alias };
  }

  /** Writes the alias where nodes are written: the folder's settings, else the user's. */
  async setTeamName(name: string): Promise<void> {
    const settings = vscode.workspace.getConfiguration('onlyOneChat');
    const where = settings.inspect('team.name');
    const target =
      where?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : where?.workspaceValue !== undefined || vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await settings.update('team.name', name === '' ? undefined : name, target);
    this.emitter.fire();
  }

  /** The nodes on Squad's board, from the settings (ADR 0023). */
  nodes(): NodeChoice[] {
    return nodesOf(vscode.workspace.getConfiguration('onlyOneChat').get('nodes'));
  }

  /**
   * Writes the nodes where they are defined, else in the folder's settings
   * (ADR 0023), then announces it once. A node whose model its CLI does not
   * offer is not written, and the user is told why.
   */
  async setNodes(nodes: readonly NodeChoice[]): Promise<boolean> {
    for (const node of nodes) {
      const problem = this.problem(node);
      if (problem) {
        void vscode.window.showWarningMessage(problem);
        return false;
      }
    }
    const settings = vscode.workspace.getConfiguration('onlyOneChat');
    const where = settings.inspect('nodes');
    const target =
      where?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : where?.workspaceValue !== undefined || vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    this.writing++;
    try {
      await settings.update(
        'nodes',
        nodes.map((node) => ({ ...node })),
        target,
      );
    } finally {
      this.writing--;
    }
    this.emitter.fire();
    return true;
  }

  /** A role chosen in a view: written if the CLI offers it, else the user is told why not. */
  async choose(role: RoleName, choice: AgentChoice): Promise<boolean> {
    const problem = this.problem(choice);
    if (problem) {
      void vscode.window.showWarningMessage(problem);
      return false;
    }
    await this.set(role, choice);
    return true;
  }

  /** Writes a role, where each setting is defined (folder or user), then announces it once. */
  async set(role: RoleName, choice: AgentChoice): Promise<void> {
    const settings = vscode.workspace.getConfiguration('onlyOneChat');
    this.writing++;
    try {
      for (const key of KEYS) {
        if (role === 'leader' && key === 'permission') continue;
        const name = `${role}.${key}`;
        const where = settings.inspect(name);
        const target =
          where?.workspaceFolderValue !== undefined
            ? vscode.ConfigurationTarget.WorkspaceFolder
            : where?.workspaceValue !== undefined
              ? vscode.ConfigurationTarget.Workspace
              : vscode.ConfigurationTarget.Global;
        if (settings.get(name) !== choice[key]) await settings.update(name, choice[key], target);
      }
    } finally {
      this.writing--;
    }
    this.emitter.fire();
  }

  dispose(): void {
    this.subscription.dispose();
    this.unsubscribeCatalog();
    this.emitter.dispose();
  }
}
