// The settings page (ADR 0013): the extension's settings live in VS Code's own
// (contributes.configuration), so user and folder scopes and Settings Sync
// come with them; the page shows them grouped, says where each value comes
// from, and writes them back. Only the keys listed here can be written, each
// checked against its kind.

import * as vscode from 'vscode';
import type { Cli, SettingItem, SettingsSection, SettingsTarget } from './shared/protocol.js';

interface Definition {
  readonly key: string;
  readonly label: string;
  readonly kind: SettingItem['kind'];
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly min?: number;
  readonly max?: number;
  /** Development host only. */
  readonly development?: boolean;
  /** The path of this CLI's executable: the page offers DETECT and SELECT (ADR 0025). */
  readonly cli?: Cli;
}

const SECTIONS: readonly { title: string; items: readonly Definition[] }[] = [
  {
    title: 'Delegation and workflow',
    items: [
      {
        key: 'approvalMode',
        label: 'Delegation delivery',
        kind: 'enum',
        options: [
          { value: 'manual', label: 'Manual' },
          { value: 'auto', label: 'Automatic' },
        ],
      },
      {
        key: 'leaderReview',
        label: 'Leader review after a delegation',
        kind: 'enum',
        options: [
          { value: 'always', label: 'Immediately' },
          { value: 'deferred', label: 'With the next message' },
        ],
      },
      { key: 'verifyCommand', label: 'Verification command after a delegation', kind: 'list' },
    ],
  },
  {
    // Its provider, model and reasoning are with the roles, at the top of the page (ADR 0029).
    title: 'Reviewer',
    items: [
      { key: 'reviewer.enabled', label: 'Review every change', kind: 'boolean' },
      {
        key: 'reviewer.rounds',
        label: 'Maximum correction rounds',
        kind: 'number',
        min: 0,
        max: 3,
      },
    ],
  },
  {
    title: 'Role instructions',
    items: [
      { key: 'leader.instructions', label: 'Leader', kind: 'text' },
      { key: 'implementer.instructions', label: 'Implementer', kind: 'text' },
      { key: 'reviewer.instructions', label: 'Reviewer', kind: 'text' },
    ],
  },
  {
    title: 'Subagents',
    items: [
      { key: 'subagents.codexModel', label: 'Codex subagent model', kind: 'string' },
      { key: 'subagents.claudeModel', label: 'Claude subagent model', kind: 'string' },
      { key: 'subagents.effort', label: 'Subagent reasoning effort', kind: 'string' },
    ],
  },
  {
    title: 'Permissions and files',
    items: [
      { key: 'allowedCommands', label: 'Commands Claude can run without asking', kind: 'list' },
      {
        key: 'ignoredPaths',
        label: 'Paths excluded from verified facts, checkpoints, and changes (gitignore syntax)',
        kind: 'list',
      },
      {
        key: 'saveBeforeSend',
        label: 'Unsaved files before sending',
        kind: 'enum',
        options: [
          { value: 'ask', label: 'Ask' },
          { value: 'always', label: 'Always save' },
          { value: 'never', label: 'Do not save' },
        ],
      },
    ],
  },
  {
    title: 'Composer',
    items: [{ key: 'composer.enterSends', label: 'Enter sends the message', kind: 'boolean' }],
  },
  {
    title: 'Notifications',
    items: [
      { key: 'notifications.waiting', label: 'An agent is waiting for you', kind: 'boolean' },
      { key: 'notifications.turnEnd', label: 'A message has finished', kind: 'boolean' },
      {
        key: 'notifications.usageThreshold',
        label: 'Usage threshold (%)',
        kind: 'number',
        min: 0,
        max: 100,
      },
    ],
  },
  {
    title: 'Provider',
    items: [
      { key: 'codexPath', label: 'Codex executable', kind: 'string', cli: 'codex' },
      { key: 'claudePath', label: 'Claude Code executable', kind: 'string', cli: 'claude' },
      {
        key: 'antigravityPath',
        label: 'Antigravity executable (agy)',
        kind: 'string',
        cli: 'antigravity',
      },
      {
        key: 'fake',
        label: 'Fake CLIs (development, no quota use)',
        kind: 'boolean',
        development: true,
      },
    ],
  },
];

interface Contributed {
  readonly description?: string;
  readonly scope?: string;
}

function contributed(context: vscode.ExtensionContext): Record<string, Contributed> {
  const json = context.extension.packageJSON as {
    contributes: { configuration: { properties: Record<string, Contributed> } };
  };
  return json.contributes.configuration.properties;
}

function definitions(context: vscode.ExtensionContext): Definition[] {
  const development = context.extensionMode === vscode.ExtensionMode.Development;
  return SECTIONS.flatMap((s) => s.items).filter((d) => development || d.development !== true);
}

/** The settings as the page shows them, with where each value comes from. */
export function settingsSections(context: vscode.ExtensionContext): SettingsSection[] {
  const settings = vscode.workspace.getConfiguration('onlyOneChat');
  const properties = contributed(context);
  const development = context.extensionMode === vscode.ExtensionMode.Development;
  return SECTIONS.map((section) => ({
    title: section.title,
    items: section.items
      .filter((d) => development || d.development !== true)
      .map((d): SettingItem => {
        const where = settings.inspect(d.key);
        const property = properties[`onlyOneChat.${d.key}`];
        return {
          key: d.key,
          label: d.label,
          description: property?.description ?? '',
          kind: d.kind,
          ...(d.options ? { options: d.options } : {}),
          ...(d.min !== undefined ? { min: d.min } : {}),
          ...(d.max !== undefined ? { max: d.max } : {}),
          ...(d.cli ? { cli: d.cli } : {}),
          value: settings.get(d.key) as SettingItem['value'],
          scope:
            where?.workspaceFolderValue !== undefined || where?.workspaceValue !== undefined
              ? 'workspace'
              : where?.globalValue !== undefined
                ? 'user'
                : 'default',
          // Paths, commands and instructions: never from a folder's settings (security.md).
          userOnly: property?.scope === 'machine' || property?.scope === 'application',
        };
      }),
  }));
}

/** The value checked against the setting's kind; undefined when it does not fit. */
function checked(definition: Definition, value: unknown): unknown {
  switch (definition.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'enum':
      return definition.options?.some((o) => o.value === value) ? value : undefined;
    case 'number':
      return typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= (definition.min ?? -Infinity) &&
        value <= (definition.max ?? Infinity)
        ? value
        : undefined;
    case 'string':
      return typeof value === 'string' && value.length <= 500 && !/[\r\n]/.test(value)
        ? value.trim()
        : undefined;
    case 'text':
      return typeof value === 'string' && value.length <= 20_000 ? value : undefined;
    case 'list':
      return Array.isArray(value) &&
        value.length <= 50 &&
        value.every((v) => typeof v === 'string' && v.trim() !== '' && v.length <= 200)
        ? value.map((v: string) => v.trim())
        : undefined;
  }
}

/**
 * Writes a setting, or removes it from the target with `undefined`. Returns
 * why it was not written, or undefined.
 */
export async function writeSetting(
  context: vscode.ExtensionContext,
  key: string,
  value: unknown,
  target: SettingsTarget,
): Promise<string | undefined> {
  const definition = definitions(context).find((d) => d.key === key);
  if (!definition) return `Unknown setting: ${key}`;
  const property = contributed(context)[`onlyOneChat.${key}`];
  const userOnly = property?.scope === 'machine' || property?.scope === 'application';
  if (target === 'workspace' && userOnly) {
    return 'This is a user setting.';
  }
  if (target === 'workspace' && !vscode.workspace.workspaceFolders?.length) {
    return 'Open a folder first.';
  }
  const next = value === undefined ? undefined : checked(definition, value);
  if (value !== undefined && next === undefined) return `Invalid value for ${definition.label}.`;
  await vscode.workspace
    .getConfiguration('onlyOneChat')
    .update(
      key,
      next,
      target === 'workspace'
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global,
    );
  return undefined;
}
