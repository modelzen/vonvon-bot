import type { TenantBrand } from '../config/schema';

export interface CardCallbackConfiguration {
  state: 'configured' | 'missing' | 'wrong-mode' | 'unchecked';
  mode?: 'websocket' | 'webhook';
  reason?: string;
}

const ENDPOINTS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};
const FEISHU_TIMEOUT_MS = 10_000;
const CARD_ACTION_CALLBACK = 'card.action.trigger';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requestFailure(error: unknown): CardCallbackConfiguration {
  return {
    state: 'unchecked',
    // Do not expose upstream messages, request URLs or credentials in diagnostics.
    reason: error instanceof Error && error.name === 'TimeoutError'
      ? '飞书接口 10 秒没有响应'
      : '无法连接飞书读取卡片回调配置，请稍后重试',
  };
}

function apiFailure(stage: 'token' | 'configuration', response: Response, body: Record<string, unknown> | undefined): CardCallbackConfiguration {
  const code = typeof body?.code === 'number' && Number.isSafeInteger(body.code) ? body.code : undefined;
  if (stage === 'configuration' && (response.status === 401 || response.status === 403 || code === 99991672)) {
    return { state: 'unchecked', reason: '没有读取应用配置的权限，请检查飞书应用权限后重试' };
  }
  const label = stage === 'token' ? '获取飞书访问凭据失败' : '读取飞书应用配置失败';
  const detail = !response.ok ? `HTTP ${response.status}` : code !== undefined && code !== 0 ? `code=${code}` : '响应格式无效';
  return { state: 'unchecked', reason: `${label}（${detail}）` };
}

/**
 * Read the app's callback subscription configuration without changing it. Configuration
 * is distinct from a locally observed callback or the owner's manual confirmation.
 * Only an explicit, valid subscription list can establish a missing callback.
 */
export async function diagnoseCardCallbackConfiguration(
  appId: string,
  appSecret: string,
  tenant: TenantBrand,
  fetchFn: typeof fetch = fetch,
): Promise<CardCallbackConfiguration> {
  const base = ENDPOINTS[tenant];
  let token: string;
  try {
    const response = await fetchFn(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS),
    });
    const body = record(await response.json().catch(() => undefined));
    if (!response.ok || body?.code !== 0 || typeof body.tenant_access_token !== 'string' || !body.tenant_access_token.trim()) {
      return apiFailure('token', response, body);
    }
    token = body.tenant_access_token;
  } catch (error) {
    return requestFailure(error);
  }

  let body: Record<string, unknown> | undefined;
  try {
    const response = await fetchFn(
      `${base}/open-apis/application/v6/applications/${encodeURIComponent(appId)}?lang=zh_cn`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS) },
    );
    body = record(await response.json().catch(() => undefined));
    if (!response.ok || body?.code !== 0) return apiFailure('configuration', response, body);
  } catch (error) {
    return requestFailure(error);
  }

  const app = record(record(body.data)?.app);
  // callback is the SDK's older compatibility field. A present but malformed
  // callback_info must never fall back to an older, potentially contradictory value.
  const callback = record(app?.callback_info !== undefined ? app.callback_info : app?.callback);
  if (!callback) return { state: 'unchecked', reason: '应用接口未返回可识别的卡片回调配置' };
  const mode = callback.callback_type;
  if (mode !== 'websocket' && mode !== 'webhook') {
    return { state: 'unchecked', reason: '应用接口未返回可识别的回调接收方式' };
  }
  const callbacks = callback.subscribed_callbacks;
  if (!Array.isArray(callbacks) || !callbacks.every(value => typeof value === 'string' && value.length > 0 && value.trim() === value)) {
    return { state: 'unchecked', mode, reason: '应用接口未返回可识别的回调订阅列表' };
  }
  if (!callbacks.includes(CARD_ACTION_CALLBACK)) return { state: 'missing', mode };
  return { state: mode === 'websocket' ? 'configured' : 'wrong-mode', mode };
}
