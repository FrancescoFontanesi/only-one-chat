// Messages exchanged between the extension host and the webviews: the chat
// panel and the side views (roles, activity, usage). Imported by both sides:
// it must not import `vscode` or DOM-only APIs.

export interface ExtensionStatus {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly runtime: { readonly name: string; readonly version: string };
  readonly workspaceTrusted: boolean;
}

export type ApprovalMode = 'auto' | 'manual';

/** Reasoning levels offered when a model's own are not known. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type RoleName = 'leader' | 'implementer';
export type Cli = 'codex' | 'claude';

/** What a role may do without asking: nothing, ask first, or act inside the folder. */
export type PermissionLevel = 'read-only' | 'ask' | 'auto';

/** A role: its CLI, model, reasoning and permission level (ADR 0012). */
export interface RoleInfo {
  readonly cli: Cli;
  readonly model: string;
  /** The model's name as its CLI shows it; the id when the catalog is not read yet. */
  readonly modelName: string;
  /** Empty for a model with no reasoning levels. */
  readonly effort: string;
  readonly permission: PermissionLevel;
}

export interface ModelOption {
  readonly id: string;
  readonly name: string;
  readonly efforts: readonly string[];
  readonly defaultEffort: string | null;
}

/**
 * The reasoning level a model keeps when it is chosen: the current one if the
 * model supports it, else its default, else `medium`, else its first; empty
 * for a model with no levels.
 */
export function effortFor(model: ModelOption | undefined, current: string): string {
  if (!model) return current;
  const { efforts } = model;
  if (efforts.length === 0) return '';
  if (efforts.includes(current)) return current;
  if (model.defaultEffort && efforts.includes(model.defaultEffort)) return model.defaultEffort;
  return efforts.includes('medium') ? 'medium' : (efforts[0] ?? '');
}

/** The models one CLI offers, read from the CLI itself. */
export interface ProviderCatalog {
  readonly cli: Cli;
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly models: readonly ModelOption[];
  /** Why the models are missing. */
  readonly note?: string;
}

/** The roles view: the roles of the next chats, and those of the chat shown. */
export interface RolesState {
  readonly roles: { readonly leader: RoleInfo; readonly implementer: RoleInfo };
  /** The chat shown, if its agents have started: its providers stay its own. */
  readonly chat: { readonly leader: RoleInfo; readonly implementer: RoleInfo } | null;
  readonly catalog: readonly ProviderCatalog[];
  /** The models come from the fake CLIs (development host). */
  readonly fake: boolean;
}

/** Where the settings page writes: the user's settings or the folder's. */
export type SettingsTarget = 'user' | 'workspace';

export type SettingValue = boolean | number | string | readonly string[];

/** One setting of the settings page (ADR 0013). */
export interface SettingItem {
  /** Under `onlyOneChat.`. */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly kind: 'boolean' | 'enum' | 'number' | 'string' | 'text' | 'list';
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly min?: number;
  readonly max?: number;
  readonly value: SettingValue;
  /** Where the value in effect comes from. */
  readonly scope: 'default' | 'user' | 'workspace';
  /** Never from a folder's settings: paths, commands, instructions. */
  readonly userOnly: boolean;
}

export interface SettingsSection {
  readonly title: string;
  readonly items: readonly SettingItem[];
}

export interface SettingsState {
  readonly roles: RolesState;
  readonly sections: readonly SettingsSection[];
  readonly hasWorkspace: boolean;
}

/** The chat as the panel shows it in its header and composer. */
export interface SessionInfo {
  /** Folder the agents work in; null without an open folder. */
  readonly workspace: string | null;
  readonly trusted: boolean;
  readonly leader: RoleInfo;
  readonly implementer: RoleInfo;
  readonly mode: ApprovalMode;
  /** Fake CLIs: no model turn, no quota (development only). */
  readonly fake: boolean;
  readonly busy: boolean;
  /** Title of the chat shown; empty until its first message. */
  readonly title: string;
  /** The chats kept for this folder, most recent first, and the one shown. */
  readonly chats: readonly {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
  }[];
  readonly chatId: string | null;
  /** Enter sends (Shift+Enter: new line); false: Ctrl+Enter sends. */
  readonly enterSends: boolean;
  /** How full each role's session is, after its latest turn. */
  readonly context: Partial<Record<TurnRole, ContextInfo>>;
  /** Usage windows past this percentage are flagged; 0: never. */
  readonly usageThreshold: number;
}

/** A session's context: the tokens of its latest request, and the model's window if known. */
export interface ContextInfo {
  readonly used: number;
  readonly window: number | null;
}

export type TurnRole = 'leader' | 'implementer';

export interface TurnUsageSummary {
  /** Context read in the turn: input, cached input and cache writes. */
  readonly context: number;
  readonly output: number;
  readonly costUsd: number | null;
  readonly durationMs: number;
}

/** One question of an agent (ADR 0019); `options` null: a free answer only. */
export interface QuestionItem {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description: string }[] | null;
  /** A free answer besides the choices. */
  readonly other: boolean;
  /** The answer is not shown in clear nor kept. */
  readonly secret: boolean;
}

/** One entry of the chat thread, or a change to one. */
export type ThreadUpdate =
  | {
      readonly type: 'user';
      readonly id: string;
      readonly text: string;
      /** Who it is for; older chats wrote `@impl` at the start of the text instead. */
      readonly to?: RoleName;
      /** The folder as it was before this message (ADR 0014). */
      readonly checkpoint?: string;
      /** Files and folders named with `@`, as the agents received them (ADR 0015). */
      readonly attachments?: readonly string[];
      /** The `@` paths of the text that exist in the folder, as written (ADR 0018). */
      readonly refs?: readonly string[];
      /** The skill the user named with `$` (ADR 0019). */
      readonly skill?: string;
    }
  | {
      readonly type: 'turn';
      readonly id: string;
      readonly role: TurnRole;
      readonly agent: string;
      readonly status: 'running' | 'done' | 'failed';
      /** Written by the runtime from what the CLI reported, once the turn is done. */
      readonly label?: string;
      readonly text?: string;
      readonly usage?: TurnUsageSummary;
      /** The `@` paths of the text that exist in the folder, once the turn is done. */
      readonly refs?: readonly string[];
    }
  | { readonly type: 'chunk'; readonly turnId: string; readonly text: string }
  | { readonly type: 'activity'; readonly turnId: string; readonly text: string }
  | {
      readonly type: 'subagent';
      readonly turnId: string;
      readonly id: string;
      readonly label: string;
      readonly status: string;
    }
  | {
      /**
       * A message between agents: waiting for the user (manual delivery), or,
       * closed at once with `sent`, a delegation that went on by itself (ADR 0018).
       */
      readonly type: 'approval';
      readonly id: string;
      readonly kind: 'delegation' | 'review';
      readonly from: string;
      readonly to: string;
      readonly text: string;
      readonly refs?: readonly string[];
      /** `@` paths that look like files and do not exist: pointed out, not blocking. */
      readonly missing?: readonly string[];
    }
  /** approve, edit, cancel; `sent`, without the user; `interrupted`, a chat closed before. */
  | { readonly type: 'approval_closed'; readonly id: string; readonly action: string }
  | {
      /** The leader asks while its turn waits (ADR 0019): the dock shows the questions. */
      readonly type: 'question';
      readonly id: string;
      readonly role: TurnRole;
      readonly agent: string;
      readonly questions: readonly QuestionItem[];
    }
  | {
      /** `answered`, with the answers (a secret one masked); `declined`; `interrupted`. */
      readonly type: 'question_closed';
      readonly id: string;
      readonly outcome: 'answered' | 'declined' | 'interrupted';
      readonly answers?: Readonly<Record<string, readonly string[]>>;
    }
  | {
      /** An agent asks before acting (a command, a file change): the user answers (R9). */
      readonly type: 'permission';
      readonly id: string;
      readonly role: TurnRole;
      readonly agent: string;
      readonly summary: string;
    }
  | { readonly type: 'permission_closed'; readonly id: string; readonly decision: string }
  | { readonly type: 'notice'; readonly level: 'info' | 'warn' | 'error'; readonly text: string }
  | {
      /** What a message changed in the folder, to review file by file (ADR 0014). */
      readonly type: 'changes';
      readonly id: string;
      readonly checkpoint: string;
      readonly files: readonly ChangedFile[];
      /** Changed but not recorded, so not revertible: too large. */
      readonly uncovered: readonly string[];
    }
  | {
      readonly type: 'change_decided';
      readonly id: string;
      readonly path: string;
      readonly decision: 'accepted' | 'rejected';
    };

/** A file a message changed, with its contents before and after by hash. */
export interface ChangedFile {
  /** Relative to the folder, with forward slashes. */
  readonly path: string;
  readonly kind: 'added' | 'modified' | 'deleted';
  /** Lines; 0 for a binary file. */
  readonly added: number;
  readonly removed: number;
  readonly binary: boolean;
  /** Content hashes; null where the file did not exist. */
  readonly before: string | null;
  readonly after: string | null;
}

/** One agent in the activity view. */
export interface MonitorAgent {
  readonly role: TurnRole;
  readonly info: RoleInfo;
  /** `waiting`: for the user, on a permission or a message between agents. */
  readonly status: 'idle' | 'working' | 'waiting';
  /** The last thing it did in the current turn. */
  readonly activity: string | null;
  /** Its sub-agents still running. */
  readonly subagents: readonly string[];
  /** How full its session is, after its latest turn. */
  readonly context?: ContextInfo;
}

export interface MonitorEvent {
  readonly at: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly text: string;
}

/** The activity view: who works now, and what happened, latest first. */
export interface MonitorState {
  readonly agents: readonly MonitorAgent[];
  readonly events: readonly MonitorEvent[];
}

/** One usage window of a subscription, as its CLI reported it. */
export interface UsageWindow {
  /** "5h" or "weekly". */
  readonly name: string;
  readonly usedPercent: number;
  /** Unix seconds; null when not reported. */
  readonly resetsAt: number | null;
}

/** A subscription, for the usage view. */
export interface ProviderUsage {
  readonly provider: Cli;
  readonly windows: readonly UsageWindow[];
  /** When the windows were read (ms since epoch); null before the first reading. */
  readonly updatedAt: number | null;
  /** How the windows are read, or why they are missing. */
  readonly note: string;
}

export type HostToWebviewMessage =
  | { readonly type: 'status'; readonly status: ExtensionStatus }
  | { readonly type: 'pong'; readonly id: number; readonly receivedAt: string }
  | { readonly type: 'session'; readonly session: SessionInfo }
  | { readonly type: 'thread'; readonly update: ThreadUpdate }
  | { readonly type: 'reset' }
  | { readonly type: 'usage'; readonly providers: readonly ProviderUsage[] }
  | { readonly type: 'roles'; readonly roles: RolesState }
  | { readonly type: 'monitor'; readonly monitor: MonitorState }
  | { readonly type: 'settings'; readonly settings: SettingsState }
  /** The folder's files and folders for `@` (relative; a folder ends with `/`). */
  | { readonly type: 'files'; readonly paths: readonly string[] }
  /** A CLI's skills for `$` (ADR 0019), as its CLI lists them for the open folder. */
  | {
      readonly type: 'skills';
      readonly cli: Cli;
      readonly status: 'loading' | 'ready' | 'unavailable';
      readonly skills: readonly { readonly name: string; readonly description: string }[];
      readonly note?: string;
    }
  /** Text for the composer: a mention of the open file or of the selection. */
  | { readonly type: 'insert'; readonly text: string };

export type ApprovalAction = 'approve' | 'edit' | 'cancel';

/** The answer to an agent's permission request; "for the session" as the CLI scopes it. */
export type PermitDecision = 'accept' | 'acceptForSession' | 'decline';

export type WebviewToHostMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'ping'; readonly id: number }
  | {
      readonly type: 'send';
      readonly text: string;
      /** Default: the leader. */
      readonly to?: RoleName;
      /** A skill of the recipient's CLI, named with `$` (ADR 0019). */
      readonly skill?: string;
    }
  | {
      readonly type: 'decide';
      readonly id: string;
      readonly action: ApprovalAction;
      readonly text?: string;
    }
  | { readonly type: 'stop' }
  | { readonly type: 'permit'; readonly id: string; readonly decision: PermitDecision }
  /** The user's answers to an agent's questions, by question id (ADR 0019). */
  | {
      readonly type: 'answer';
      readonly id: string;
      readonly answers: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly type: 'setMode'; readonly mode: ApprovalMode }
  | {
      readonly type: 'setRole';
      readonly role: RoleName;
      readonly cli: Cli;
      readonly model: string;
      readonly effort: string;
      readonly permission: PermissionLevel;
    }
  | { readonly type: 'newChat' }
  | { readonly type: 'openChat'; readonly id: string }
  | { readonly type: 'refreshUsage' }
  | { readonly type: 'refreshModels' }
  | { readonly type: 'openFolder' }
  | { readonly type: 'openSettings' }
  | {
      readonly type: 'setSetting';
      readonly key: string;
      /** Undefined: the value is removed from the target. */
      readonly value?: SettingValue;
      readonly target: SettingsTarget;
    }
  | { readonly type: 'openNativeSettings' }
  /** From the settings page: back to the chat. */
  | { readonly type: 'showChat' }
  /** VS Code's Workspace Trust page, for a folder not trusted. */
  | { readonly type: 'manageTrust' }
  /** Text for the clipboard: an error's details. */
  | { readonly type: 'copy'; readonly text: string }
  | {
      /** A file of a changes card: show its diff, keep it, or put it back as it was. */
      readonly type: 'reviewFile';
      readonly id: string;
      readonly path: string;
      readonly action: 'diff' | 'accept' | 'reject';
    }
  | { readonly type: 'restoreCheckpoint'; readonly checkpoint: string }
  /** The implementer's work to a new session of the same model (ADR 0017). */
  | { readonly type: 'handoff' }
  | { readonly type: 'listFiles' }
  /** The skills of a CLI for `$`; `again` reads them anew. */
  | { readonly type: 'listSkills'; readonly cli: Cli; readonly again?: boolean }
  /** A path the thread links (ADR 0018), opened at its lines; the host checks it is in the folder. */
  | {
      readonly type: 'openFile';
      readonly path: string;
      readonly from?: number;
      readonly to?: number;
    };

/** Longest text the webview may send: a large brief fits, a pasted log does not. */
export const MAX_TEXT_LENGTH = 50_000;
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
/** Model ids and aliases as the CLIs name them, e.g. `gpt-6.1-sol`, `claude-haiku-4-5-20251001`. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const EFFORT_PATTERN = /^[a-z]{0,16}$/;
/** A skill's name as the CLIs write them, e.g. `tdd`, `oleafly-latex-build`, `Figure prep`. */
const SKILL_PATTERN = /^[\w][\w .:()-]{0,99}$/;
/** A key under `onlyOneChat.`, e.g. `notifications.waiting`; the host knows which exist. */
const SETTING_KEY = /^[a-zA-Z]+(\.[a-zA-Z]+)?$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH ? value : undefined;
}

const isRole = (value: unknown): value is RoleName => value === 'leader' || value === 'implementer';

const isPermission = (value: unknown): value is PermissionLevel =>
  value === 'read-only' || value === 'ask' || value === 'auto';

/** Validates a message received from a webview; anything unexpected is dropped. */
export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
  const msg = asRecord(value);
  switch (msg?.['type']) {
    case 'ready':
      return { type: 'ready' };
    case 'ping': {
      const id = msg['id'];
      return typeof id === 'number' && Number.isSafeInteger(id) ? { type: 'ping', id } : undefined;
    }
    case 'send': {
      const body = text(msg['text']);
      if (body === undefined || body.trim() === '') return undefined;
      const to = msg['to'];
      const skill = msg['skill'];
      if (to !== undefined && !isRole(to)) return undefined;
      if (skill !== undefined && (typeof skill !== 'string' || !SKILL_PATTERN.test(skill))) {
        return undefined;
      }
      return {
        type: 'send',
        text: body,
        ...(to ? { to } : {}),
        ...(skill !== undefined ? { skill } : {}),
      };
    }
    case 'decide': {
      const id = msg['id'];
      const action = msg['action'];
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) return undefined;
      if (action === 'approve' || action === 'cancel') return { type: 'decide', id, action };
      const edited = text(msg['text']);
      return action === 'edit' && edited !== undefined && edited.trim() !== ''
        ? { type: 'decide', id, action, text: edited }
        : undefined;
    }
    case 'stop':
      return { type: 'stop' };
    case 'permit': {
      const id = msg['id'];
      const decision = msg['decision'];
      return typeof id === 'string' &&
        ID_PATTERN.test(id) &&
        (decision === 'accept' || decision === 'acceptForSession' || decision === 'decline')
        ? { type: 'permit', id, decision }
        : undefined;
    }
    case 'setMode': {
      const mode = msg['mode'];
      return mode === 'auto' || mode === 'manual' ? { type: 'setMode', mode } : undefined;
    }
    case 'setRole': {
      const { role, cli, model, effort, permission } = msg;
      return isRole(role) &&
        (cli === 'codex' || cli === 'claude') &&
        typeof model === 'string' &&
        MODEL_PATTERN.test(model) &&
        typeof effort === 'string' &&
        EFFORT_PATTERN.test(effort) &&
        isPermission(permission)
        ? { type: 'setRole', role, cli, model, effort, permission }
        : undefined;
    }
    case 'newChat':
      return { type: 'newChat' };
    case 'openChat': {
      const id = msg['id'];
      return typeof id === 'string' && ID_PATTERN.test(id) ? { type: 'openChat', id } : undefined;
    }
    case 'refreshUsage':
      return { type: 'refreshUsage' };
    case 'refreshModels':
      return { type: 'refreshModels' };
    case 'openFolder':
      return { type: 'openFolder' };
    case 'openSettings':
      return { type: 'openSettings' };
    case 'reviewFile': {
      const { id, path, action } = msg;
      // The host acts only on a file it finds in the card: the path is a key, not trusted.
      return typeof id === 'string' &&
        ID_PATTERN.test(id) &&
        typeof path === 'string' &&
        path.length > 0 &&
        path.length <= 1000 &&
        (action === 'diff' || action === 'accept' || action === 'reject')
        ? { type: 'reviewFile', id, path, action }
        : undefined;
    }
    case 'listFiles':
      return { type: 'listFiles' };
    case 'answer': {
      const id = msg['id'];
      const raw = asRecord(msg['answers']);
      if (typeof id !== 'string' || !ID_PATTERN.test(id) || !raw) return undefined;
      const entries = Object.entries(raw);
      if (entries.length === 0 || entries.length > 10) return undefined;
      const answers: Record<string, string[]> = {};
      for (const [key, value] of entries) {
        if (!/^[\w.-]{1,64}$/.test(key) || !Array.isArray(value) || value.length > 10)
          return undefined;
        const texts = value.map(text);
        if (texts.some((t) => t === undefined)) return undefined;
        answers[key] = texts as string[];
      }
      return { type: 'answer', id, answers };
    }
    case 'listSkills': {
      const cli = msg['cli'];
      if (cli !== 'codex' && cli !== 'claude') return undefined;
      return { type: 'listSkills', cli, ...(msg['again'] === true ? { again: true } : {}) };
    }
    case 'restoreCheckpoint': {
      const checkpoint = msg['checkpoint'];
      return typeof checkpoint === 'string' && ID_PATTERN.test(checkpoint)
        ? { type: 'restoreCheckpoint', checkpoint }
        : undefined;
    }
    case 'handoff':
      return { type: 'handoff' };
    case 'openFile': {
      const path = msg['path'];
      const line = (value: unknown) =>
        value === undefined ||
        (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1);
      if (typeof path !== 'string' || path === '' || path.length > 1024 || path.includes('\0'))
        return undefined;
      if (!line(msg['from']) || !line(msg['to'])) return undefined;
      const from = msg['from'] as number | undefined;
      const to = msg['to'] as number | undefined;
      return {
        type: 'openFile',
        path,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      };
    }
    case 'showChat':
      return { type: 'showChat' };
    case 'manageTrust':
      return { type: 'manageTrust' };
    case 'copy': {
      const body = text(msg['text']);
      return body !== undefined ? { type: 'copy', text: body } : undefined;
    }
    case 'openNativeSettings':
      return { type: 'openNativeSettings' };
    case 'setSetting': {
      const { key, value, target } = msg;
      if (typeof key !== 'string' || !SETTING_KEY.test(key)) return undefined;
      if (target !== 'user' && target !== 'workspace') return undefined;
      if (value === undefined) return { type: 'setSetting', key, target };
      const fits =
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length <= MAX_TEXT_LENGTH) ||
        (Array.isArray(value) &&
          value.length <= 100 &&
          value.every((v) => typeof v === 'string' && v.length <= 1000));
      return fits ? { type: 'setSetting', key, value: value as SettingValue, target } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Validates a message received from the extension host. The host is trusted:
 * this guards against shape mistakes, not against an attacker.
 */
export function parseHostMessage(value: unknown): HostToWebviewMessage | undefined {
  const msg = asRecord(value);
  switch (msg?.['type']) {
    case 'status': {
      const status = asRecord(msg['status']);
      return status ? { type: 'status', status: status as unknown as ExtensionStatus } : undefined;
    }
    case 'pong': {
      const id = msg['id'];
      const receivedAt = msg['receivedAt'];
      return typeof id === 'number' && typeof receivedAt === 'string'
        ? { type: 'pong', id, receivedAt }
        : undefined;
    }
    case 'session': {
      const session = asRecord(msg['session']);
      return session ? { type: 'session', session: session as unknown as SessionInfo } : undefined;
    }
    case 'thread': {
      const update = asRecord(msg['update']);
      return typeof update?.['type'] === 'string'
        ? { type: 'thread', update: update as unknown as ThreadUpdate }
        : undefined;
    }
    case 'reset':
      return { type: 'reset' };
    case 'usage':
      return Array.isArray(msg['providers'])
        ? { type: 'usage', providers: msg['providers'] as ProviderUsage[] }
        : undefined;
    case 'roles': {
      const roles = asRecord(msg['roles']);
      return roles ? { type: 'roles', roles: roles as unknown as RolesState } : undefined;
    }
    case 'files':
      return Array.isArray(msg['paths'])
        ? { type: 'files', paths: msg['paths'] as string[] }
        : undefined;
    case 'skills':
      return (msg['cli'] === 'codex' || msg['cli'] === 'claude') && Array.isArray(msg['skills'])
        ? (msg as unknown as Extract<HostToWebviewMessage, { type: 'skills' }>)
        : undefined;
    case 'insert':
      return typeof msg['text'] === 'string' ? { type: 'insert', text: msg['text'] } : undefined;
    case 'settings': {
      const settings = asRecord(msg['settings']);
      return settings
        ? { type: 'settings', settings: settings as unknown as SettingsState }
        : undefined;
    }
    case 'monitor': {
      const monitor = asRecord(msg['monitor']);
      return monitor ? { type: 'monitor', monitor: monitor as unknown as MonitorState } : undefined;
    }
    default:
      return undefined;
  }
}
