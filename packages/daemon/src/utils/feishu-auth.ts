import type { TenantBrand } from '../config/schema';
import { CONTACT_SCOPES, JOIN_GROUP_SCOPES, REQUIRED_SCOPES, V1_OPTIONAL_SCOPES } from '../config/scopes';

/** The 3.11 optional scopes that change what the bot does in a chat, listed on the 状态与诊断 page. */
const CHAT_OPTIONAL_SCOPES = [...CONTACT_SCOPES, 'im:chat:readonly', ...V1_OPTIONAL_SCOPES] as const;

const ENDPOINTS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  /** Feishu could not be reached or answered garbage, so the credentials were not judged. */
  unreachable?: boolean;
  botName?: string;
  botOpenId?: string;
  /**
   * Required scopes the app hasn't been granted yet (best-effort; undefined if
   * the scope list couldn't be fetched). Empty array = all granted.
   */
  missingScopes?: string[];
  /**
   * Opt-in "加入存量群" scopes ({@link JOIN_GROUP_SCOPES}) not yet granted. Same
   * 3-state semantics as {@link missingScopes} (undefined = couldn't check).
   * These aren't required for core messaging, so they never gate startup — the
   * doctor card surfaces them so existing users can discover + enable them.
   */
  missingJoinScopes?: string[];
  /** {@link CHAT_OPTIONAL_SCOPES} not yet granted; same 3-state semantics. */
  missingOptional?: string[];
}

interface TokenResp {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
}

interface BotInfoResp {
  code?: number;
  bot?: { activate_status?: number; app_name?: string; open_id?: string };
}

/** Validate app credentials by exchanging for a tenant_access_token. */
/** A stalled Feishu call must not hang the checklist or a credential refresh. */
const FEISHU_TIMEOUT_MS = 10_000;
const networkReason = (err: unknown): string =>
  err instanceof Error && err.name === 'TimeoutError' ? `飞书接口 ${FEISHU_TIMEOUT_MS / 1000} 秒没有响应` : `网络错误：${err instanceof Error ? err.message : String(err)}`;

export async function validateAppCredentials(
  appId: string,
  appSecret: string,
  tenant: TenantBrand,
): Promise<ValidationResult> {
  const base = ENDPOINTS[tenant];
  let resp: Response;
  try {
    resp = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: networkReason(err), unreachable: true };
  }
  if (!resp.ok) {
    // Feishu may put a rejection's {code,msg} on a 4xx; only a body without one means "not judged".
    const body = (await resp.json().catch(() => undefined)) as TokenResp | undefined;
    if (resp.status < 500 && resp.status !== 429 && typeof body?.code === 'number' && body.code !== 0) {
      return { ok: false, reason: `code=${body.code} msg=${body.msg ?? '<no msg>'}` };
    }
    return { ok: false, reason: `HTTP ${resp.status}`, unreachable: true };
  }
  let data: TokenResp;
  try {
    data = (await resp.json()) as TokenResp;
  } catch (err) {
    return { ok: false, reason: err instanceof Error && err.name === 'TimeoutError' ? networkReason(err) : '响应不是合法 JSON', unreachable: true };
  }
  if (data.code !== 0 || !data.tenant_access_token) {
    return { ok: false, reason: `code=${data.code ?? '?'} msg=${data.msg ?? '<no msg>'}` };
  }
  const token = data.tenant_access_token;
  const info = await fetchBotInfo(base, token).catch(() => undefined);
  const granted = await fetchGrantedScopes(base, token).catch(() => undefined);
  const missing = (list: readonly string[]): string[] | undefined =>
    granted ? list.filter((s) => !granted.has(s)) : undefined;
  return {
    ok: true,
    botName: info?.bot?.app_name,
    botOpenId: info?.bot?.open_id,
    missingScopes: missing(REQUIRED_SCOPES),
    missingJoinScopes: missing(JOIN_GROUP_SCOPES),
    missingOptional: missing(CHAT_OPTIONAL_SCOPES),
  };
}

async function fetchBotInfo(base: string, token: string): Promise<BotInfoResp | undefined> {
  const resp = await fetch(`${base}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS),
  });
  if (!resp.ok) return undefined;
  return (await resp.json()) as BotInfoResp;
}

interface ScopeListResp {
  data?: { scopes?: { scope_name: string; grant_status: number }[] };
}

/**
 * The set of scope names the app has actually been granted (`grant_status === 1`).
 * Returns undefined (not an empty set) on any failure so callers can tell "none
 * granted" from "couldn't check" — and compute missing-from-any-list themselves.
 */
async function fetchGrantedScopes(base: string, token: string): Promise<Set<string> | undefined> {
  const resp = await fetch(`${base}/open-apis/application/v6/scopes`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS),
  });
  if (!resp.ok) return undefined;
  const body = (await resp.json()) as ScopeListResp;
  if (!body.data?.scopes) return undefined;
  return new Set(body.data.scopes.filter((s) => s.grant_status === 1).map((s) => s.scope_name));
}
