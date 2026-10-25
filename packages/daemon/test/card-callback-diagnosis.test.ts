import { describe, expect, it, vi } from 'vitest';
import { diagnoseCardCallbackConfiguration } from '../src/utils/card-callback-diagnosis';

const configured = { callback_type: 'websocket', subscribed_callbacks: ['card.action.trigger'] };
const application = (app: unknown) => ({ code: 0, data: { app } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fetchStub(app: unknown, options: { token?: unknown; tokenStatus?: number; appStatus?: number } = {}) {
  return vi.fn<typeof fetch>(async input => String(input).includes('/tenant_access_token/')
    ? json(options.token ?? { code: 0, tenant_access_token: 'token-fixture' }, options.tokenStatus)
    : json(app, options.appStatus));
}

describe('diagnoseCardCallbackConfiguration', () => {
  it.each(['feishu', 'lark'] as const)('reads the %s app configuration with a token and a GET only', async tenant => {
    const fetch = fetchStub(application({ callback_info: configured }));
    expect(await diagnoseCardCallbackConfiguration('cli_/fixture', 'secret-fixture', tenant, fetch))
      .toEqual({ state: 'configured', mode: 'websocket' });
    const base = tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, `${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: 'cli_/fixture', app_secret: 'secret-fixture' }),
      signal: expect.any(AbortSignal),
    });
    expect(fetch).toHaveBeenNthCalledWith(2, `${base}/open-apis/application/v6/applications/cli_%2Ffixture?lang=zh_cn`, {
      method: 'GET', headers: { Authorization: 'Bearer token-fixture' }, signal: expect.any(AbortSignal),
    });
  });

  it.each([
    [{ callback_type: 'websocket', subscribed_callbacks: [] }, { state: 'missing', mode: 'websocket' }],
    [{ callback_type: 'websocket', subscribed_callbacks: ['other.action.trigger'] }, { state: 'missing', mode: 'websocket' }],
    [{ callback_type: 'webhook', subscribed_callbacks: [] }, { state: 'missing', mode: 'webhook' }],
    [{ callback_type: 'webhook', subscribed_callbacks: ['card.action.trigger'] }, { state: 'wrong-mode', mode: 'webhook' }],
    [{ callback_type: 'websocket', subscribed_callbacks: ['other.action.trigger', 'card.action.trigger'] }, { state: 'configured', mode: 'websocket' }],
  ])('distinguishes explicit subscription and transport configuration: %j', async (callback, expected) => {
    expect(await diagnoseCardCallbackConfiguration('cli_fixture', 'secret', 'feishu', fetchStub(application({ callback_info: callback }))))
      .toEqual(expected);
  });

  it('uses the compatibility callback field only when callback_info is absent', async () => {
    expect(await diagnoseCardCallbackConfiguration('cli_fixture', 'secret', 'feishu', fetchStub(application({ callback: configured }))))
      .toEqual({ state: 'configured', mode: 'websocket' });
    expect(await diagnoseCardCallbackConfiguration('cli_fixture', 'secret', 'feishu', fetchStub(application({
      callback_info: { callback_type: 'websocket', subscribed_callbacks: [] }, callback: configured,
    })))).toEqual({ state: 'missing', mode: 'websocket' });
  });

  it.each([
    null, [], 'invalid', {},
    { callback_info: null, callback: configured },
    { callback_info: [], callback: configured },
    { callback_info: 'invalid', callback: configured },
    { callback_info: {}, callback: configured },
    { callback_info: { subscribed_callbacks: ['card.action.trigger'] } },
    { callback_info: { callback_type: 'future-mode', subscribed_callbacks: ['card.action.trigger'] } },
    { callback_info: { callback_type: 1, subscribed_callbacks: [] } },
    { callback_info: { callback_type: 'websocket' } },
    { callback_info: { callback_type: 'websocket', subscribed_callbacks: null } },
    { callback_info: { callback_type: 'websocket', subscribed_callbacks: 'card.action.trigger' } },
    { callback_info: { callback_type: 'websocket', subscribed_callbacks: ['card.action.trigger', null] } },
    { callback_info: { callback_type: 'websocket', subscribed_callbacks: ['card.action.trigger', 1] } },
    { callback_info: { callback_type: 'websocket', subscribed_callbacks: ['card.action.trigger', ''] } },
    { callback_info: { callback_type: 'websocket', subscribed_callbacks: [' '] } },
    { callback_info: { callback_type: 'websocket', subscribed_callbacks: [' card.action.trigger'] } },
  ])('does not interpret absent or malformed fields as missing: %j', async app => {
    const diagnosis = await diagnoseCardCallbackConfiguration('cli_fixture', 'secret', 'feishu', fetchStub(application(app)));
    expect(diagnosis.state).toBe('unchecked');
    expect(diagnosis.reason).toBeTruthy();
  });

  it.each([null, [], {}, { code: 0 }, { code: 0, data: {} }, { code: '0', data: { app: { callback_info: configured } } }])(
    'treats malformed API responses as unchecked: %j', async body => {
      expect((await diagnoseCardCallbackConfiguration('cli_fixture', 'secret', 'feishu', fetchStub(body))).state).toBe('unchecked');
    },
  );

  it.each([
    [200, { code: 99991672, msg: 'secret-fixture internal request info' }],
    [403, { code: 1 }],
    [401, {}],
  ])('reports missing read permission without exposing upstream payloads (%s)', async (appStatus, body) => {
    const diagnosis = await diagnoseCardCallbackConfiguration('cli_fixture', 'secret-fixture', 'feishu', fetchStub(body, { appStatus }));
    expect(diagnosis).toEqual({ state: 'unchecked', reason: '没有读取应用配置的权限，请检查飞书应用权限后重试' });
  });

  it.each([
    [500, application({ callback_info: configured })],
    [200, { code: 1, msg: 'secret-fixture token-fixture' }],
  ])('never accepts unsuccessful app API responses (%s)', async (appStatus, body) => {
    const diagnosis = await diagnoseCardCallbackConfiguration('cli_fixture', 'secret-fixture', 'feishu', fetchStub(body, { appStatus }));
    expect(diagnosis.state).toBe('unchecked');
    expect(diagnosis.reason).not.toContain('secret-fixture');
    expect(diagnosis.reason).not.toContain('token-fixture');
  });

  it.each([
    { code: 10014, msg: 'secret-fixture invalid' },
    { code: 0 }, { code: 0, tenant_access_token: 123 }, { code: 0, tenant_access_token: '' }, { code: 0, tenant_access_token: ' ' },
    [], 'invalid',
  ])('does not call the app API with an invalid token response: %j', async token => {
    const fetch = fetchStub(application({ callback_info: configured }), { token });
    const diagnosis = await diagnoseCardCallbackConfiguration('cli_fixture', 'secret-fixture', 'feishu', fetch);
    expect(diagnosis.state).toBe('unchecked');
    expect(diagnosis.reason).not.toContain('secret-fixture');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a failed token HTTP status even if the body claims success', async () => {
    const fetch = fetchStub(application({ callback_info: configured }), { tokenStatus: 503 });
    expect(await diagnoseCardCallbackConfiguration('cli_fixture', 'secret', 'feishu', fetch))
      .toEqual({ state: 'unchecked', reason: '获取飞书访问凭据失败（HTTP 503）' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['token', 'application'] as const)('handles non-JSON responses from %s', async stage => {
    const fetch = vi.fn<typeof globalThis.fetch>(async input => stage === 'application' && String(input).includes('/tenant_access_token/')
      ? json({ code: 0, tenant_access_token: 'token-fixture' })
      : new Response('<html>secret-fixture</html>'));
    const diagnosis = await diagnoseCardCallbackConfiguration('cli_fixture', 'secret-fixture', 'feishu', fetch);
    expect(diagnosis.state).toBe('unchecked');
    expect(diagnosis.reason).not.toContain('secret-fixture');
  });

  it.each(['token', 'application'] as const)('handles network failures and timeouts from %s without leaking errors', async stage => {
    for (const error of [new Error('secret-fixture token-fixture'), new DOMException('timed out', 'TimeoutError')]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (stage === 'application' && String(input).includes('/tenant_access_token/')) return json({ code: 0, tenant_access_token: 'token-fixture' });
        throw error;
      });
      const diagnosis = await diagnoseCardCallbackConfiguration('cli_fixture', 'secret-fixture', 'feishu', fetch);
      expect(diagnosis.state).toBe('unchecked');
      expect(diagnosis.reason).not.toMatch(/secret-fixture|token-fixture/);
      if (error.name === 'TimeoutError') expect(diagnosis.reason).toBe('飞书接口 10 秒没有响应');
    }
  });
});
