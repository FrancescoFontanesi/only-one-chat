// The host's security checks as pure functions (ADR 0050), so unit tests reach
// them without an Extension Host: the Workspace Trust gate and the consent
// before agents start (security.md T11), the webview options (T6), and the
// checks before a setting is written (ADR 0013). No `vscode` value import.

import type { SettingItem, SettingsTarget } from '../shared/protocol.js';

/** Whether agents may start in the folder, and whether the user must first agree. */
export type AgentsGate =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly consent: boolean };

/**
 * Agents start only in an open, trusted folder (Workspace Trust), and the user
 * agrees once per folder; the fake CLIs of a development host need no consent.
 */
export function agentsGate(
  cwd: string | null | undefined,
  trusted: boolean,
  fake: boolean,
  confirmed: string | undefined,
): AgentsGate {
  if (!cwd) return { ok: false, reason: 'Open the folder where the agents should work.' };
  if (!trusted) return { ok: false, reason: 'Trust this workspace before starting the agents.' };
  return { ok: true, consent: !fake && confirmed !== cwd };
}

/** The modal's question before agents first work in a folder. */
export const consentQuestion = (cwd: string): string =>
  `Agents will work in ${cwd}. They can modify its files and run allowed commands. Continue?`;

/**
 * A webview's options: scripts for its bundle only (the CSP's nonce), no forms,
 * no command links, and resources from the given folders alone.
 */
export function webviewOptions<Root>(roots: readonly Root[]): {
  enableScripts: true;
  enableForms: false;
  enableCommandUris: false;
  localResourceRoots: Root[];
} {
  return {
    enableScripts: true,
    enableForms: false,
    enableCommandUris: false,
    localResourceRoots: [...roots],
  };
}

/** A setting's kind and limits, as settings.ts defines it. */
export interface SettingKind {
  readonly kind: SettingItem['kind'];
  readonly options?: readonly { readonly value: string }[];
  readonly min?: number;
  readonly max?: number;
}

/** Paths, commands and instructions: never from a folder's settings (security.md T11). */
export const isUserOnly = (scope: string | undefined): boolean =>
  scope === 'machine' || scope === 'application';

/** Why a setting cannot be written there, or undefined. */
export function writeRefusal(
  target: SettingsTarget,
  scope: string | undefined,
  hasFolder: boolean,
): string | undefined {
  if (target === 'workspace' && isUserOnly(scope)) return 'This is a user setting.';
  if (target === 'workspace' && !hasFolder) return 'Open a folder first.';
  return undefined;
}

/** The value checked against the setting's kind; undefined when it does not fit. */
export function checkedValue(definition: SettingKind, value: unknown): unknown {
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
