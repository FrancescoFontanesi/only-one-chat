// A Codex connection restricted to the user's ChatGPT subscription:
// - dedicated CODEX_HOME, never the personal profile, so existing config
//   (proxies such as Headroom, custom providers, API keys) is not loaded;
// - provider, base URL and login method pinned with `-c` overrides;
// - an allow-listed environment, so no API key or proxy variable reaches Codex;
// - every request except account methods waits for a verified ChatGPT account.
// Contract: docs/codex-auth.md.

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { startAppServer, type AppServerOptions, type RequestOptions } from './app-server.js';
import {
  CodexAuthError,
  downgradeFromAccountUpdated,
  interpretAccountRead,
  parseLoginStart,
  rejected,
  type CodexAuthState,
  type CodexLoginMethod,
  type CodexLoginStart,
} from './auth.js';

export interface CodexSessionOptions extends Omit<AppServerOptions, 'args' | 'env'> {
  /** Directory of the dedicated Codex profile (CODEX_HOME); created if missing. */
  readonly codexHome: string;
  /** Environment to filter for the child; defaults to `process.env`. */
  readonly baseEnv?: NodeJS.ProcessEnv;
  /** Arguments placed before Codex's own, for script-based executables (tests). */
  readonly launcherArgs?: readonly string[];
  /**
   * Extra `-c key=value` overrides. Only for isolated test and recorder profiles
   * (reproducible, no network); production launches pass none.
   */
  readonly configOverrides?: readonly string[];
}

export interface CodexSession {
  /** Latest known account state. */
  readonly auth: CodexAuthState;
  /** Reads the account again (`account/read`). */
  verifyAccount(): Promise<CodexAuthState>;
  /** Sends a request; anything but account reads requires a verified ChatGPT account. */
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>;
  /** Starts one of the official ChatGPT login flows. */
  startLogin(method: CodexLoginMethod): Promise<CodexLoginStart>;
  close(): Promise<void>;
}

/** Placed before `app-server`; CLI overrides take precedence over config files. */
const PROFILE_ARGS = [
  '-c',
  'forced_login_method="chatgpt"',
  '-c',
  'model_provider="openai"',
  '-c',
  'openai_base_url=""',
];

/**
 * Remote control lets paired ChatGPT clients drive this app-server from outside.
 * It stays the user's feature in their profile; this client never asks for it.
 */
const REMOTE_CONTROL_PREFIX = 'remoteControl/';

/** Checked at runtime too: callers may pass untyped data. */
const LOGIN_METHODS: ReadonlySet<string> = new Set(['chatgpt', 'chatgptDeviceCode']);

/** Methods allowed before the account is verified. Login has its own entry point. */
const UNGATED_METHODS = new Set(['account/read', 'account/login/cancel']);

/** Variables a process needs to run. API keys, proxies and Codex/OpenAI overrides are not here. */
const ENV_ALLOW_LIST = new Set([
  'PATH',
  // Windows
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  // POSIX
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TZ',
  'TERM',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
]);

const windows = process.platform === 'win32';

function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function childEnvironment(base: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const name = key.toUpperCase();
    if (value !== undefined && (ENV_ALLOW_LIST.has(name) || name.startsWith('LC_')))
      env[key] = value;
  }
  env['CODEX_HOME'] = codexHome;
  return env;
}

function samePath(a: string, b: string): boolean {
  const [x, y] = [resolve(a), resolve(b)];
  return windows ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export interface CodexLaunch {
  /** Arguments for the Codex executable, ending with `app-server`. */
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Checks and creates the dedicated profile, then returns how `connectCodex`
 * launches Codex in it. Exported for dev tools (transcript recorder) so they
 * cannot drift from the real launch.
 */
export async function prepareCodexLaunch(
  codexHome: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  launcherArgs: readonly string[] = [],
  configOverrides: readonly string[] = [],
): Promise<CodexLaunch> {
  if (!isAbsolute(codexHome)) {
    throw new Error(`The dedicated Codex profile must be an absolute path: ${codexHome}`);
  }
  const personal = [join(homedir(), '.codex'), getEnv(baseEnv, 'CODEX_HOME')];
  if (personal.some((path) => path !== undefined && path !== '' && samePath(path, codexHome))) {
    throw new Error(`Refusing to use the personal Codex profile ${codexHome}; use a dedicated one`);
  }
  await mkdir(codexHome, { recursive: true });
  return {
    args: [
      ...launcherArgs,
      ...PROFILE_ARGS,
      ...configOverrides.flatMap((override) => ['-c', override]),
      'app-server',
    ],
    env: childEnvironment(baseEnv, codexHome),
  };
}

export async function connectCodex(options: CodexSessionOptions): Promise<CodexSession> {
  const {
    codexHome,
    baseEnv = process.env,
    launcherArgs = [],
    configOverrides = [],
    onNotification,
    ...rest
  } = options;
  // Experimental methods (remote control among them) need this capability: never declared.
  if (rest.capabilities && 'experimentalApi' in rest.capabilities) {
    throw new Error('The experimentalApi capability is not allowed');
  }
  const launch = await prepareCodexLaunch(codexHome, baseEnv, launcherArgs, configOverrides);

  let state: CodexAuthState = rejected('read_failed', 'The account has not been verified yet');
  /** True until a read completes with no account change in between. */
  let stale = true;
  /** Bumped by every account notification, to detect reads that raced with a change. */
  let generation = 0;

  const client = await startAppServer({
    ...rest,
    args: launch.args,
    env: launch.env,
    onNotification(method, params) {
      if (method === 'account/updated' || method === 'account/login/completed') {
        generation++;
        stale = true;
        const downgraded =
          method === 'account/updated' ? downgradeFromAccountUpdated(params) : undefined;
        if (downgraded) state = downgraded;
      }
      onNotification?.(method, params);
    },
  });

  async function verifyAccount(): Promise<CodexAuthState> {
    const started = generation;
    let next: CodexAuthState;
    try {
      next = interpretAccountRead(await client.request('account/read', {}));
    } catch (error) {
      next = rejected('read_failed', error instanceof Error ? error.message : String(error));
    }
    // A change arrived while reading: the answer may predate it, so stay stale.
    if (generation !== started) return state;
    state = next;
    stale = false;
    return state;
  }

  async function ensureAuthorized(): Promise<void> {
    if (stale || state.status !== 'authorized') await verifyAccount();
    if (state.status !== 'authorized') throw new CodexAuthError(state);
    if (stale)
      throw new CodexAuthError(rejected('read_failed', 'The account changed during verification'));
  }

  // The account check precedes anything else sent on this connection.
  await verifyAccount();

  return {
    get auth() {
      return state;
    },
    verifyAccount,
    async request(method, params, requestOptions) {
      if (method === 'account/login/start') {
        throw new Error('Use startLogin() to start an official ChatGPT login');
      }
      if (method.startsWith(REMOTE_CONTROL_PREFIX)) {
        throw new Error(`${method} is not allowed: remote control is never driven by this client`);
      }
      if (!UNGATED_METHODS.has(method)) await ensureAuthorized();
      return client.request(method, params, requestOptions);
    },
    async startLogin(method) {
      if (!LOGIN_METHODS.has(method)) {
        throw new Error(
          `Unsupported login method ${JSON.stringify(method)}: only chatgpt and chatgptDeviceCode`,
        );
      }
      return parseLoginStart(method, await client.request('account/login/start', { type: method }));
    },
    close: () => client.close(),
  };
}
