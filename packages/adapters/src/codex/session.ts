// A Codex connection in the user's own profile (docs/decisions/0006):
// - the user's CODEX_HOME and configuration, with their provider, proxies
//   (Headroom) and login; this client never logs in or out;
// - the user's environment minus API key variables;
// - every request except the account read waits for a usable account: a
//   verified ChatGPT subscription, or an unverifiable provider the caller
//   explicitly allowed;
// - methods that spend credits, send communications or hand the session to
//   remote control are never sent.
// Contract: docs/codex-auth.md.

import { startAppServer, type AppServerOptions, type RequestOptions } from './app-server.js';
import {
  CodexAuthError,
  downgradeFromAccountUpdated,
  interpretAccountRead,
  isUsable,
  needsProvider,
  providerFromConfig,
  rejected,
  type CodexAuthState,
  type CodexProvider,
} from './auth.js';
import { withoutApiKeys } from '../environment.js';

export interface CodexSessionOptions extends Omit<AppServerOptions, 'args' | 'env'> {
  /** Environment for the child, minus API keys; defaults to `process.env`. */
  readonly baseEnv?: NodeJS.ProcessEnv;
  /** Arguments placed before Codex's own, for script-based executables (tests). */
  readonly launcherArgs?: readonly string[];
  /**
   * Extra `-c key=value` overrides. Only for isolated test and recorder profiles
   * (reproducible, no network); production launches pass none.
   */
  readonly configOverrides?: readonly string[];
  /**
   * Accept a provider that does not use OpenAI authentication (a custom proxy):
   * the subscription then cannot be verified. Off by default.
   */
  readonly allowUnverifiedProvider?: boolean;
}

export interface CodexSession {
  /** Latest known account state. */
  readonly auth: CodexAuthState;
  /** Reads the account again (`account/read`). */
  verifyAccount(): Promise<CodexAuthState>;
  /** Sends a request; anything but the account read requires a usable account. */
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>;
  close(): Promise<void>;
}

/** Methods that only read the account: allowed before it is verified. */
const UNGATED_METHODS = new Set(['account/read']);

/** Never sent, whatever the account state. */
const DENIED_METHODS: ReadonlyMap<string, string> = new Map([
  ['account/rateLimitResetCredit/consume', 'it spends a rate-limit reset credit'],
  ['account/sendAddCreditsNudgeEmail', 'it sends an e-mail'],
  ['feedback/upload', 'it sends feedback, logs and threads to OpenAI'],
  ['plugin/share/save', 'it publishes a plugin to other people'],
  ['plugin/share/updateTargets', 'it changes who a plugin is shared with'],
  ['account/login/start', 'logging in is done with the Codex CLI in a terminal'],
  ['account/login/cancel', 'logging in is done with the Codex CLI in a terminal'],
  ['account/logout', "it would sign the user's own profile out"],
]);

/** Remote control lets paired ChatGPT clients drive this app-server from outside. */
const REMOTE_CONTROL_PREFIX = 'remoteControl/';

export function deniedReason(method: string): string | undefined {
  if (method.startsWith(REMOTE_CONTROL_PREFIX)) {
    return 'remote control is never driven by this client';
  }
  return DENIED_METHODS.get(method);
}

export interface CodexLaunch {
  /** Arguments for the Codex executable, ending with `app-server`. */
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/**
 * How `connectCodex` launches Codex. Exported for dev tools (transcript
 * recorder, real checks) so they cannot drift from the real launch.
 */
export function prepareCodexLaunch(
  baseEnv: NodeJS.ProcessEnv = process.env,
  launcherArgs: readonly string[] = [],
  configOverrides: readonly string[] = [],
): CodexLaunch {
  return {
    args: [
      ...launcherArgs,
      ...configOverrides.flatMap((override) => ['-c', override]),
      'app-server',
    ],
    env: withoutApiKeys(baseEnv),
  };
}

export async function connectCodex(options: CodexSessionOptions): Promise<CodexSession> {
  const {
    baseEnv = process.env,
    launcherArgs = [],
    configOverrides = [],
    allowUnverifiedProvider = false,
    onNotification,
    ...rest
  } = options;
  // Experimental methods (remote control among them) need this capability: never declared.
  if (rest.capabilities && 'experimentalApi' in rest.capabilities) {
    throw new Error('The experimentalApi capability is not allowed');
  }
  const launch = prepareCodexLaunch(baseEnv, launcherArgs, configOverrides);

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

  async function readProvider(): Promise<CodexProvider | null> {
    try {
      return providerFromConfig(await client.request('config/read', {}));
    } catch {
      return null;
    }
  }

  async function verifyAccount(): Promise<CodexAuthState> {
    const started = generation;
    let next: CodexAuthState;
    try {
      const result = await client.request('account/read', {});
      const provider = needsProvider(result) ? await readProvider() : null;
      next = interpretAccountRead(result, { allowUnverifiedProvider, provider });
    } catch (error) {
      next = rejected('read_failed', error instanceof Error ? error.message : String(error));
    }
    // A change arrived while reading: the answer may predate it, so stay stale.
    if (generation !== started) return state;
    state = next;
    stale = false;
    return state;
  }

  async function ensureUsable(): Promise<void> {
    if (stale || !isUsable(state)) await verifyAccount();
    if (!isUsable(state)) throw new CodexAuthError(state);
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
      const denied = deniedReason(method);
      if (denied) throw new Error(`${method} is not allowed: ${denied}`);
      if (!UNGATED_METHODS.has(method)) await ensureUsable();
      return client.request(method, params, requestOptions);
    },
    close: () => client.close(),
  };
}
