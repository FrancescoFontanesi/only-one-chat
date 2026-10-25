// Codex account state, interpreted fail-closed. Codex runs in the user's own
// profile (docs/decisions/0006): a ChatGPT login on a provider that uses OpenAI
// authentication is a verified subscription; a provider that does not (a custom
// proxy, for example) cannot be verified and is usable only when the caller
// opts in; an API key is always refused. Shapes follow codex-rs
// app-server-protocol v2 (GetAccountResponse, AccountUpdatedNotification); see
// docs/codex-auth.md.

export type CodexRejection =
  'api_key' | 'unsupported_mode' | 'provider_not_verified' | 'read_failed';

/** The model provider Codex is configured with, as `config/read` reports it. */
export interface CodexProvider {
  readonly id: string;
  /** Display name from the provider's configuration, when it has one. */
  readonly name: string | null;
  /** `base_url` from the provider's configuration; null for a built-in default. */
  readonly baseUrl: string | null;
  /**
   * True when requests do not go straight to OpenAI (a proxy such as Headroom,
   * a local model). Informational: the account policy does not depend on it.
   */
  readonly unofficialBaseUrl: boolean;
}

/** Hosts of OpenAI's own endpoints (API and ChatGPT backend). */
const OFFICIAL_HOSTS = new Set(['api.openai.com', 'chatgpt.com']);

function isOfficialUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && OFFICIAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

const UNKNOWN_PROVIDER: CodexProvider = {
  id: 'unknown',
  name: null,
  baseUrl: null,
  unofficialBaseUrl: true,
};

export type CodexAuthState =
  | { readonly status: 'authorized'; readonly email: string | null; readonly planType: string }
  | {
      /** Allowed by `allowUnverifiedProvider`: the subscription cannot be checked. */
      readonly status: 'unverified_provider';
      readonly provider: CodexProvider;
    }
  | { readonly status: 'login_required' }
  | {
      readonly status: 'rejected';
      readonly reason: CodexRejection;
      readonly detail: string;
      readonly provider?: CodexProvider;
    };

export type CodexUsableState = Extract<
  CodexAuthState,
  { status: 'authorized' } | { status: 'unverified_provider' }
>;
export type CodexUnauthorizedState = Exclude<CodexAuthState, CodexUsableState>;

export function isUsable(state: CodexAuthState): state is CodexUsableState {
  return state.status === 'authorized' || state.status === 'unverified_provider';
}

export class CodexAuthError extends Error {
  override readonly name = 'CodexAuthError';

  readonly state: CodexUnauthorizedState;

  // A plain field rather than a parameter property: runnable with Node's type stripping.
  constructor(state: CodexUnauthorizedState) {
    super(
      state.status === 'login_required'
        ? 'Codex is not signed in: run `codex login` in a terminal, then try again'
        : `Codex account not allowed (${state.reason}): ${state.detail}`,
    );
    this.state = state;
  }
}

export function rejected(
  reason: CodexRejection,
  detail: string,
  provider?: CodexProvider,
): CodexUnauthorizedState {
  return provider
    ? { status: 'rejected', reason, detail, provider }
    : { status: 'rejected', reason, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extracts the active provider from a `config/read` result; null when it is not there. */
export function providerFromConfig(result: unknown): CodexProvider | null {
  if (!isRecord(result) || !isRecord(result['config'])) return null;
  const config = result['config'];
  const id = typeof config['model_provider'] === 'string' ? config['model_provider'] : 'openai';
  const providers = isRecord(config['model_providers']) ? config['model_providers'] : {};
  const configured = providers[id];
  const entry = isRecord(configured) ? configured : {};
  const name = typeof entry['name'] === 'string' ? entry['name'] : null;
  const baseUrl = typeof entry['base_url'] === 'string' ? entry['base_url'] : null;
  // Without a base_url only the built-in OpenAI provider is known to be official.
  const unofficialBaseUrl = baseUrl === null ? id !== 'openai' : !isOfficialUrl(baseUrl);
  return { id, name, baseUrl, unofficialBaseUrl };
}

export interface AccountPolicy {
  readonly allowUnverifiedProvider: boolean;
  /** From `config/read`; names the provider when `requiresOpenaiAuth` is false. */
  readonly provider?: CodexProvider | null;
}

/** Interprets an `account/read` result. Anything unexpected is a rejection. */
export function interpretAccountRead(result: unknown, policy: AccountPolicy): CodexAuthState {
  if (
    !isRecord(result) ||
    typeof result['requiresOpenaiAuth'] !== 'boolean' ||
    !('account' in result)
  ) {
    return rejected('read_failed', 'Malformed account/read response');
  }
  const account = result['account'];
  if (account !== null && !isRecord(account)) {
    return rejected('read_failed', 'Malformed account in account/read response');
  }
  // An API key is refused whatever the provider says.
  if (account?.['type'] === 'apiKey') {
    return rejected('api_key', 'API key authentication is not allowed; sign in with ChatGPT');
  }
  if (!result['requiresOpenaiAuth']) {
    const provider = policy.provider ?? UNKNOWN_PROVIDER;
    if (policy.allowUnverifiedProvider) return { status: 'unverified_provider', provider };
    const label = provider.name ? `${provider.name} (${provider.id})` : provider.id;
    return rejected(
      'provider_not_verified',
      `Codex uses the model provider ${label}, which does not use OpenAI authentication, ` +
        'so the ChatGPT subscription cannot be verified. Enable allowUnverifiedProvider ' +
        'to use it anyway.',
      provider,
    );
  }
  if (account === null) return { status: 'login_required' };

  switch (account['type']) {
    case 'chatgpt': {
      const planType = account['planType'];
      if (typeof planType !== 'string')
        return rejected('read_failed', 'ChatGPT account without a plan type');
      const email = account['email'];
      return { status: 'authorized', email: typeof email === 'string' ? email : null, planType };
    }
    default:
      return rejected(
        'unsupported_mode',
        `Unsupported account type ${JSON.stringify(account['type'])}`,
      );
  }
}

/**
 * What an `account/updated` notification alone tells us. It can only take an
 * authorization away: a ChatGPT mode returns undefined and must be confirmed by
 * a fresh `account/read`.
 */
export function downgradeFromAccountUpdated(params: unknown): CodexUnauthorizedState | undefined {
  if (!isRecord(params)) return undefined;
  const authMode = params['authMode'];
  if (authMode === 'chatgpt') return undefined;
  if (authMode === null || authMode === undefined) return { status: 'login_required' };
  if (authMode === 'apikey')
    return rejected('api_key', 'The account switched to API key authentication');
  return rejected(
    'unsupported_mode',
    `The account switched to auth mode ${JSON.stringify(authMode)}`,
  );
}
