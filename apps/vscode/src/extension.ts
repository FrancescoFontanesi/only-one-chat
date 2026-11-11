import * as os from 'node:os';
import * as vscode from 'vscode';
import {
  checkClaudeBilling,
  listAntigravityModels,
  listClaudeModels,
  listClaudeSkills,
  listCodexModels,
  listCodexSkills,
} from '@only-one-chat/adapters';
import { cliLaunch } from './clis.js';
import { registerCommands } from './commands/index.js';
import { RoleSettings } from './roles.js';
import { ModelCatalog } from './session/catalog.js';
import { SkillCatalog } from './session/skills.js';
import { MonitorStore } from './session/monitor.js';
import { UsageStore } from './session/usage.js';
import { usageWarnings } from './notifications.js';
import { CheckpointContentProvider, CHECKPOINT_SCHEME } from './webview/checkpointContent.js';
import { OnlyOneChatPanel } from './webview/panel.js';
import { UsageReader } from './usageReader.js';

/**
 * Value returned by `activate`. Only the integration tests use it; it is not
 * a supported API for other extensions.
 */
export interface OnlyOneChatExports {
  /** Resolves the next time a panel completes the host/webview handshake. */
  whenPanelReady(): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): OnlyOneChatExports {
  const usage = new UsageStore();
  usage.setProviders(['codex', 'claude', 'antigravity']);
  const monitor = new MonitorStore();
  // The models are read from the CLIs themselves: no model turn, no quota.
  // Claude starts in a temporary folder, away from the project's own settings.
  const catalog = new ModelCatalog({
    codex: async () => {
      const launch = await cliLaunch(context, 'codex');
      return listCodexModels(launch);
    },
    claude: async () => {
      const launch = await cliLaunch(context, 'claude');
      // Signed in with a subscription, as before a turn: `claude auth status`, no quota.
      await checkClaudeBilling({ ...launch, cwd: os.tmpdir(), prompt: '' });
      return listClaudeModels({ ...launch, cwd: os.tmpdir() });
    },
    // `agy models`: the list only, no turn (ADR 0023).
    antigravity: async () => listAntigravityModels(await cliLaunch(context, 'antigravity')),
  });
  // The skills of the open folder, from the CLIs as well (ADR 0019): no turn, no quota.
  const skills = new SkillCatalog({
    codex: async (cwd) => listCodexSkills({ ...(await cliLaunch(context, 'codex')), cwd }),
    claude: async (cwd) => listClaudeSkills({ ...(await cliLaunch(context, 'claude')), cwd }),
    // TODO(nodes): Antigravity's skills are not read; a node takes none (ADR 0023).
    antigravity: () => Promise.reject(new Error('Le skill di Antigravity non sono lette.')),
  });
  const roles = new RoleSettings(catalog);
  const usageReader = new UsageReader(context, usage, () =>
    roles.nodes().some((node) => node.cli === 'antigravity'),
  );
  context.subscriptions.push(
    roles,
    vscode.workspace.registerTextDocumentContentProvider(
      CHECKPOINT_SCHEME,
      new CheckpointContentProvider(context),
    ),
  );
  const services = {
    usage,
    monitor,
    roles,
    catalog,
    skills,
    refreshUsage: () => usageReader.refresh(),
  };
  registerCommands(context, services);
  context.subscriptions.push(
    usageWarnings(usage, () => {
      OnlyOneChatPanel.show(context, services);
    }),
  );
  return {
    whenPanelReady: () =>
      new Promise<void>((resolve) => {
        const subscription = OnlyOneChatPanel.onDidBecomeReady(() => {
          subscription.dispose();
          resolve();
        });
      }),
  };
}

export function deactivate(): void {
  // Nothing to release yet: all disposables are owned by the extension context.
}
