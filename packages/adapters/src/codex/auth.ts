// Codex account state, interpreted fail-closed: only a ChatGPT-plan login on a
// provider that uses OpenAI authentication authorizes model use. Shapes follow
// codex-rs app-server-protocol v2 (GetAccountResponse, AccountUpdatedNotification,
// LoginAccountResponse); see docs/codex-auth.md.

import { AppServerError } from './app-server.js';

export type CodexRejection =
  'api_key' | 'unsupported_mode' | 'provider_not_verified' | 'read_failed';

export type CodexAuthState =
  | { readonly status: 'authorized'; readonly email: string | null; readonly planType: string }
  | { readonly status: 'login_required' }
  | { readonly status: 'rejected'; readonly reason: CodexRejection; readonly detail: string };

export type CodexUnauthorizedState = Exclude<CodexAuthState, { status: 'authorized' }>;

export class CodexAuthError extends Error {
  override readonly name = 'CodexAuthError';

  constructor(readonly state: CodexUnauthorizedState) {
    super(
      state.status === 'login_required'
        ? 'Codex needs a ChatGPT login before it can be used'
        : `Codex account not allowed (${state.reason}): ${state.detail}`,
    );
  }
}

export function rejected(reason: CodexRejection, detail: string): CodexUnauthorizedState {
  return { status: 'rejected', reason, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Interprets an `account/read` result. Anything unexpected is a rejection. */
export function interpretAccountRead(result: unknown): CodexAuthState {
  if (
    !isRecord(result) ||
    typeof result['requiresOpenaiAuth'] !== 'boolean' ||
    !('account' in result)
  ) {
    return rejected('read_failed', 'Malformed account/read response');
  }
  if (!result['requiresOpenaiAuth']) {
    return rejected(
      'provider_not_verified',
      'The active model provider does not use OpenAI authentication, so a ChatGPT plan cannot be verified',
    );
  }
  const account = result['account'];
  if (account === null) return { status: 'login_required' };
  if (!isRecord(account))
    return rejected('read_failed', 'Malformed account in account/read response');

  switch (account['type']) {
    case 'chatgpt': {
      const planType = account['planType'];
      if (typeof planType !== 'string')
        return rejected('read_failed', 'ChatGPT account without a plan type');
      const email = account['email'];
      return { status: 'authorized', email: typeof email === 'string' ? email : null, planType };
    }
    case 'apiKey':
      return rejected('api_key', 'API key authentication is not allowed; sign in with ChatGPT');
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

export type CodexLoginMethod = 'chatgpt' | 'chatgptDeviceCode';

export type CodexLoginStart =
  | { readonly type: 'chatgpt'; readonly loginId: string; readonly authUrl: string }
  | {
      readonly type: 'chatgptDeviceCode';
      readonly loginId: string;
      readonly verificationUrl: string;
      readonly userCode: string;
    };

function httpsUrl(value: unknown, field: string): string {
  if (typeof value === 'string') {
    try {
      if (new URL(value).protocol === 'https:') return value;
    } catch {
      // reported below
    }
  }
  throw new AppServerError(
    'protocol',
    `account/login/start returned a ${field} that is not an https URL`,
  );
}

function text(value: unknown, field: string): string {
  if (typeof value === 'string' && value !== '') return value;
  throw new AppServerError('protocol', `account/login/start returned no ${field}`);
}

/** Validates an `account/login/start` result against the method that was requested. */
export function parseLoginStart(method: CodexLoginMethod, result: unknown): CodexLoginStart {
  if (!isRecord(result) || result['type'] !== method) {
    throw new AppServerError('protocol', `account/login/start did not answer with type ${method}`);
  }
  const loginId = text(result['loginId'], 'loginId');
  return method === 'chatgpt'
    ? { type: method, loginId, authUrl: httpsUrl(result['authUrl'], 'authUrl') }
    : {
        type: method,
        loginId,
        verificationUrl: httpsUrl(result['verificationUrl'], 'verificationUrl'),
        userCode: text(result['userCode'], 'userCode'),
      };
}
