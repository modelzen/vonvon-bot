import type { BackendLogin } from '../types';

/** Whether Claude can run turns on this machine: 已登录, 未登录 or 无法确认. */
export type ClaudeLogin = BackendLogin;

/** The `account` the SDK's CLI reports at initialize (`AccountInfo` in sdk.d.ts). */
export type ClaudeAccount = { subscriptionType?: string; tokenSource?: string; apiKeySource?: string; apiProvider?: string };

export const CLAUDE_SIGNED_OUT_MESSAGE = '未登录。在终端运行 `claude` 登录，或设置 ANTHROPIC_API_KEY。';
const CREDENTIAL_VARIABLES = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'] as const;

/**
 * The CLI fills `account` from local credentials (keychain or credentials file, env,
 * settings) without asking the server, so an expired token still reads as signed in
 * until a real turn fails. Bedrock, Vertex and the like keep their credentials
 * elsewhere, so they are 无法确认. Returns null when the fields say nothing.
 */
export function loginFromAccount(account: ClaudeAccount | undefined): ClaudeLogin | null {
  if (!account) return null;
  const provider = account.apiProvider ?? 'firstParty';
  if (provider !== 'firstParty') return { state: 'unknown', message: `无法确认：Claude 用的是 ${provider}，本机查不了它的凭据。` };
  if (account.subscriptionType) return { state: 'signedIn', message: `已登录 claude.ai 账号（${account.subscriptionType}）。` };
  const source = [account.apiKeySource, account.tokenSource].find(value => value && value !== 'none');
  if (source) return { state: 'signedIn', message: `已登录，凭据来自 ${source}。` };
  return account.tokenSource === 'none' || account.apiKeySource === 'none' ? { state: 'signedOut', message: CLAUDE_SIGNED_OUT_MESSAGE } : null;
}

/** Under launchd the daemon may not reach the login keychain, and the CLI then reports
 * no credentials. e06 could not check this (that Mac's login is not in the keychain),
 * so under the LaunchAgent a signed-out answer is 无法确认, never 未登录. */
export function loginUnderService(login: ClaudeLogin, env: NodeJS.ProcessEnv): ClaudeLogin {
  if (login.state !== 'signedOut' || env.VONVON_SERVICE !== 'launchd') return login;
  return { state: 'unknown', message: '无法确认：后台服务里没查到 Claude 登录，可能是读不到钥匙串。在终端里运行 `claude` 看是否已登录，或设置 ANTHROPIC_API_KEY。' };
}

/** When the SDK cannot tell: a credential in the env counts as signed in (not
 * validated); otherwise 无法确认, never 未登录, since a keychain login may exist. */
export function loginFromEnv(env: NodeJS.ProcessEnv, reason: string): ClaudeLogin {
  const name = CREDENTIAL_VARIABLES.find(variable => env[variable]?.trim());
  return name ? { state: 'signedIn', message: `设置了 ${name}，没有验证过。` } : { state: 'unknown', message: `无法确认：${reason}` };
}

/** Each probe starts the ~250 MB CLI, and the desktop snapshot asks every 60 s, so a
 * signed-in answer is kept 30 minutes and others 5 minutes. 检查登录 passes `refresh`
 * and shows a login made in the terminal at once. One probe at a time: a refresh
 * that arrives while one runs waits for it and gets the next one, which started after
 * the click. A probe that throws is not cached. */
const SIGNED_IN_TTL_MS = 30 * 60_000;
const OTHER_TTL_MS = 5 * 60_000;
let cache: { value: ClaudeLogin; at: number } | undefined;
let inflight: Promise<ClaudeLogin> | undefined;
let queued: Promise<ClaudeLogin> | undefined;

function start(probe: () => Promise<ClaudeLogin>): Promise<ClaudeLogin> {
  const current = inflight = probe().then(value => {
    cache = { value, at: Date.now() };
    return value;
  }).finally(() => { if (inflight === current) inflight = undefined; });
  return current;
}

function fresh(): ClaudeLogin | undefined {
  return cache && Date.now() - cache.at < (cache.value.state === 'signedIn' ? SIGNED_IN_TTL_MS : OTHER_TTL_MS) ? cache.value : undefined;
}

export function readClaudeLogin(probe: () => Promise<ClaudeLogin>, opts: { refresh?: boolean } = {}): Promise<ClaudeLogin> {
  const cached = opts.refresh ? undefined : fresh();
  if (cached) return Promise.resolve(cached);
  if (!inflight) return start(probe);
  if (!opts.refresh) return inflight;
  queued ??= inflight.then(() => undefined, () => undefined).then(() => {
    queued = undefined;
    return inflight ?? start(probe);
  });
  return queued;
}

/** The last answer without probing, for the 60 s snapshot poll; nothing once it is
 * older than its TTL, so a stale 已登录 does not stay on the home page. */
export function cachedClaudeLogin(): ClaudeLogin | undefined {
  return fresh();
}

/** Test seam. */
export function resetClaudeLoginCache(): void {
  cache = undefined;
  inflight = undefined;
  queued = undefined;
}
