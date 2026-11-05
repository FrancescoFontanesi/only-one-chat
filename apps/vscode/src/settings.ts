// The settings page (ADR 0013): the extension's settings live in VS Code's own
// (contributes.configuration), so user and folder scopes and Settings Sync
// come with them; the page shows them grouped, says where each value comes
// from, and writes them back. Only the keys listed here can be written, each
// checked against its kind.

import * as vscode from 'vscode';
import type { SettingItem, SettingsSection, SettingsTarget } from './webview/protocol.js';

interface Definition {
  readonly key: string;
  readonly label: string;
  readonly kind: SettingItem['kind'];
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly min?: number;
  readonly max?: number;
  /** Development host only. */
  readonly development?: boolean;
}

const SECTIONS: readonly { title: string; items: readonly Definition[] }[] = [
  {
    title: 'Deleghe e flusso',
    items: [
      {
        key: 'approvalMode',
        label: 'Consegna delle deleghe',
        kind: 'enum',
        options: [
          { value: 'manual', label: 'manuale' },
          { value: 'auto', label: 'automatica' },
        ],
      },
      {
        key: 'leaderReview',
        label: 'Revisione del leader dopo una delega',
        kind: 'enum',
        options: [
          { value: 'always', label: 'subito' },
          { value: 'deferred', label: 'con il messaggio successivo' },
        ],
      },
      { key: 'verifyCommand', label: 'Comando di verifica dopo una delega', kind: 'list' },
    ],
  },
  {
    title: 'Istruzioni per ruolo',
    items: [
      { key: 'leader.instructions', label: 'Leader', kind: 'text' },
      { key: 'implementer.instructions', label: 'Implementatore', kind: 'text' },
    ],
  },
  {
    title: 'Sotto-agenti',
    items: [
      { key: 'subagents.codexModel', label: 'Modello dei sotto-agenti di Codex', kind: 'string' },
      { key: 'subagents.claudeModel', label: 'Modello dei sotto-agenti di Claude', kind: 'string' },
      { key: 'subagents.effort', label: 'Reasoning dei sotto-agenti', kind: 'string' },
    ],
  },
  {
    title: 'Permessi e file',
    items: [
      { key: 'allowedCommands', label: 'Programmi che Claude esegue senza chiedere', kind: 'list' },
      {
        key: 'saveBeforeSend',
        label: 'File non salvati prima di un messaggio',
        kind: 'enum',
        options: [
          { value: 'ask', label: 'chiedi' },
          { value: 'always', label: 'salva sempre' },
          { value: 'never', label: 'non salvare' },
        ],
      },
    ],
  },
  {
    title: 'Composer',
    items: [{ key: 'composer.enterSends', label: 'Invio invia il messaggio', kind: 'boolean' }],
  },
  {
    title: 'Notifiche',
    items: [
      { key: 'notifications.waiting', label: 'Un agente aspetta te', kind: 'boolean' },
      { key: 'notifications.turnEnd', label: 'Un messaggio è concluso', kind: 'boolean' },
      {
        key: 'notifications.usageThreshold',
        label: 'Soglia di utilizzo (%)',
        kind: 'number',
        min: 0,
        max: 100,
      },
    ],
  },
  {
    title: 'Provider',
    items: [
      { key: 'codexPath', label: 'Eseguibile di Codex', kind: 'string' },
      { key: 'claudePath', label: 'Eseguibile di Claude Code', kind: 'string' },
      {
        key: 'fake',
        label: 'CLI finti (sviluppo, nessuna quota)',
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
  if (!definition) return `Impostazione sconosciuta: ${key}`;
  const property = contributed(context)[`onlyOneChat.${key}`];
  const userOnly = property?.scope === 'machine' || property?.scope === 'application';
  if (target === 'workspace' && userOnly) {
    return 'Questa impostazione vale solo per l’utente, mai per una cartella.';
  }
  if (target === 'workspace' && !vscode.workspace.workspaceFolders?.length) {
    return 'Nessuna cartella aperta.';
  }
  const next = value === undefined ? undefined : checked(definition, value);
  if (value !== undefined && next === undefined)
    return `Valore non valido per ${definition.label}.`;
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
