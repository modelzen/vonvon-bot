import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionBody, decisionProvider, decisionProviders, readDecision, type DecisionRequestOptions } from '../src/judge/decision';
import { JUDGE_INPUT_EXAMPLE_REQUEST } from '../src/judge/prompt';
import { DECISION_TIMEOUT_MS, DecisionError, OPENROUTER_URL, VERCEL_URL } from '../src/judge/typesafe';

const fake = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));
vi.mock('../src/core/logger', () => ({ log: fake.log }));

const KEY = 'decision_TEST_KEY_123456';
const ENDPOINT = 'https://private.example.test/full/systemone';
const BODY = decisionBody(JUDGE_INPUT_EXAMPLE_REQUEST, 'PRIVATE_GROUP_RULES', 'jev-latest');
const OK = { model: 'jev-1.14', answers: { decision: { type: 'choice', choice: 'fruit', probabilities: { fruit: 0.99, other: 0.01 }, confidence: 0.98 } } };
const CONFIGS = [
  { id: 'openrouter', displayName: 'OpenRouter', keyId: 'openrouter-api-key', model: 'typesafe/jev-1.14', url: OPENROUTER_URL, header: 'x-request-id' },
  { id: 'vercel', displayName: 'Vercel', keyId: 'vercel-api-key', model: 'typesafe-ai/jev', url: VERCEL_URL, header: 'x-vercel-id' },
  { id: 'custom', displayName: '自定义 Jev', keyId: 'custom-decision-api-key', model: 'jev-latest', url: ENDPOINT, header: 'x-request-id' },
] as const;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const signal = () => new AbortController().signal;
const options = (id: string, extra: DecisionRequestOptions = {}): DecisionRequestOptions => ({ ...(id === 'custom' ? { endpoint: ENDPOINT } : {}), ...extra });
function fakeFetch(answer: (init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => answer(init ?? {})) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
async function failure(promise: Promise<unknown>): Promise<DecisionError> {
  const result = await promise.then(() => undefined, (error: unknown) => error);
  expect(result).toBeInstanceOf(DecisionError);
  return result as DecisionError;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('Jev/System One provider registry', () => {
  it('lists exactly the original provider and the three requested Jev paths', () => {
    expect(decisionProviders().map(({ id }) => id)).toEqual(['typesafe', 'openrouter', 'vercel', 'custom']);
    for (const config of CONFIGS) {
      const provider = decisionProvider(config.id)!;
      expect(provider).toMatchObject({ id: config.id, displayName: config.displayName, keyId: config.keyId, models: [{ id: config.model, displayName: 'Jev' }], limit: { running: 8, queued: 32 } });
      expect(provider.label(config.model)).toBe('Jev');
    }
    for (const id of ['constructor', '__proto__', 'openai', 'ollaya']) expect(decisionProvider(id)).toBeUndefined();
  });
});

describe.each(CONFIGS)('$displayName System One transport', (config) => {
  const provider = decisionProvider(config.id)!;
  it('posts the selected body and bearer key to the full endpoint, with redirects disabled', async () => {
    const f = fakeFetch(() => json(200, OK, { [config.header]: 'request_01<script>' }));
    const sent = { ...BODY, model: config.model };
    expect(await provider.call(sent, KEY, signal(), f, options(config.id))).toEqual({ body: OK, requestId: 'request_01script' });
    expect(f).toHaveBeenCalledExactlyOnceWith(config.url, expect.objectContaining({
      method: 'POST', redirect: 'error', body: JSON.stringify(sent),
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'vonvon-bot' },
    }));
  });

  it('lets call options choose a model without mutating the caller body', async () => {
    const f = fakeFetch(() => json(200, OK));
    await provider.call(BODY, KEY, signal(), f, options(config.id, { model: 'jev-fixed' }));
    expect(JSON.parse(f.mock.calls[0]![1]!.body)).toMatchObject({ model: 'jev-fixed' });
    expect(BODY.model).toBe('jev-latest');
  });

  it('probes the configured model with a fixed invented choice instead of group data or a model-list GET', async () => {
    const f = fakeFetch(() => json(200, OK));
    expect(await provider.probe(KEY, signal(), f, options(config.id, { model: 'jev-fixed' }))).toEqual({ outcome: 'ok', message: '能用' });
    const sent = JSON.parse(f.mock.calls[0]![1]!.body);
    expect(sent).toEqual({
      model: 'jev-fixed', state: { message: '这是虚构的连接测试：苹果是一种水果。' },
      questions: { decision: { type: 'choice', instructions: '根据测试陈述，苹果属于哪一类？', criteria: { fruit: '水果', other: '其他类别' } } },
    });
    expect(JSON.stringify(sent)).not.toMatch(/PRIVATE_GROUP_RULES|new_message|recent_messages/);
    expect(f.mock.calls[0]![0]).toBe(config.url);
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error' });
  });

  it('uses its registered model when a probe has no model override', async () => {
    const f = fakeFetch(() => json(200, OK));
    await provider.probe(KEY, signal(), f, options(config.id));
    expect(JSON.parse(f.mock.calls[0]![1]!.body).model).toBe(config.model);
  });

  it.each([
    {}, { answers: {} }, { answers: { decision: {} } },
    { answers: { decision: { type: 'noul', choice: 'fruit', probabilities: { fruit: 1, other: 0 } } } },
    { answers: { decision: { type: 'choice', choice: 'unknown', probabilities: { fruit: 1, other: 0 } } } },
    { answers: { decision: { type: 'choice', choice: ['fruit'], probabilities: { fruit: 1, other: 0 } } } },
    { answers: { decision: { type: 'choice', choice: 'fruit', probabilities: { fruit: 1 } } } },
    { answers: { decision: { type: 'choice', choice: 'fruit', probabilities: { fruit: 1, other: 0, extra: 0 } } } },
    { answers: { decision: { type: 'choice', choice: 'fruit', probabilities: { fruit: '1', other: 0 } } } },
    { answers: { decision: { type: 'choice', choice: 'fruit', probabilities: { fruit: 1.1, other: -0.1 } } } },
    { answers: { decision: { type: 'choice', choice: 'fruit', probabilities: { fruit: 0.1, other: 0.1 } } } },
    { answers: { decision: { type: 'choice', choice: 'fruit', probabilities: { fruit: 1, other: 0 }, confidence: 2 } } },
  ])('rejects a JSON response that did not complete the choice: %j', async (body) => {
    expect(await provider.probe(KEY, signal(), fakeFetch(() => json(200, body)), options(config.id)))
      .toEqual({ outcome: 'failed', message: `${config.displayName} 回的内容读不懂` });
  });

  it('names the actual provider for auth, throttling, upstream and malformed responses', async () => {
    const auth = await failure(provider.call(BODY, KEY, signal(), fakeFetch(() => json(401, { error: { message: `${KEY} ${ENDPOINT} PRIVATE_GROUP_RULES` } })), options(config.id)));
    expect(auth).toMatchObject({ kind: 'auth', message: `${config.displayName} 不认这个 key`, coolMs: 300_000 });
    const busy = await failure(provider.call(BODY, KEY, signal(), fakeFetch(() => json(429, {}, { 'retry-after': '12' })), options(config.id)));
    expect(busy).toMatchObject({ kind: 'busy', message: `${config.displayName} 限流了`, coolMs: 12_000 });
    expect(await provider.probe(KEY, signal(), fakeFetch(() => json(429, {})), options(config.id)))
      .toEqual({ outcome: 'busy', message: `连上了，但 ${config.displayName} 限流了，稍后再试`, status: 429 });
    const upstream = await failure(provider.call(BODY, KEY, signal(), fakeFetch(() => json(503, {})), options(config.id)));
    expect(upstream).toMatchObject({ kind: 'network', message: `${config.displayName} 出错了（503）` });
    const unreadable = await failure(provider.call(BODY, KEY, signal(), fakeFetch(() => new Response('PRIVATE_GROUP_RULES', { status: 200 })), options(config.id)));
    expect(unreadable).toMatchObject({ kind: 'format', message: `${config.displayName} 没按格式回答` });
    expect(JSON.stringify([auth.message, auth.info, busy.message, upstream.message, unreadable.message])).not.toMatch(/decision_TEST|private\.example|PRIVATE_GROUP_RULES/);
  });

  it('does not expose an echoed URL, key or arbitrary body through error metadata', async () => {
    for (const value of [KEY, ENDPOINT, 'PRIVATE_GROUP_RULES']) {
      const error = await failure(provider.call(BODY, KEY, signal(), fakeFetch(() => json(400, { error_type: value, message: value }, { [config.header]: value })), options(config.id)));
      expect(JSON.stringify([error.message, error.info])).not.toContain(value);
    }
  });

  it('removes echoed private data from successful model metadata before readDecision can log it', async () => {
    const sent = decisionBody({ ...JUDGE_INPUT_EXAMPLE_REQUEST, variant: 'topic', message: { ...JUDGE_INPUT_EXAMPLE_REQUEST.message, text: 'PRIVATE_MESSAGE_original_123' } }, 'PRIVATE_GROUP_RULES', config.model);
    const answers = { decision: { type: 'choice', choice: 'skip', probabilities: { skip: 0.9, reply: 0.1 }, confidence: 0.8 } };
    const expected = readDecision(sent, 'topic', 'Jev', { answers });
    for (const model of [KEY, config.url, config.url.replace(/[^\w.-]/g, ''), sent.state.new_message.text, `jev-${sent.state.new_message.text}`, 'PRIVATE_GROUP_RULES']) {
      const reply = await provider.call(sent, KEY, signal(), fakeFetch(() => json(200, { model, answers })), options(config.id));
      expect(reply.body).toEqual({ answers });
      const decision = readDecision(sent, 'topic', 'Jev', reply.body);
      expect(decision).toEqual(expected);
      expect(decision).not.toHaveProperty('providerModel');
    }
  });

  it('retains legitimate successful model versions, including the model sent in the request', async () => {
    const sent = { ...BODY, model: config.model };
    for (const model of [config.model, 'jev-1.14.0', 'typesafe/jev-1.14-20261014', 'typesafe-ai/jev']) {
      const reply = await provider.call(sent, KEY, signal(), fakeFetch(() => json(200, { ...OK, model })), options(config.id));
      expect(reply.body).toEqual({ ...OK, model });
    }
  });

  it('shares the original five-second budget, caller abort and retry rules', async () => {
    const hanging = fakeFetch(() => new Promise<Response>(() => undefined));
    const timed = failure(provider.call(BODY, KEY, signal(), hanging, options(config.id)));
    await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS);
    expect(await timed).toMatchObject({ kind: 'timeout', message: `${config.displayName} 5 秒没回` });
    const ctl = new AbortController();
    const aborted = provider.call(BODY, KEY, ctl.signal, hanging, options(config.id)).catch((error: unknown) => error);
    const reason = new Error('caller cancelled');
    ctl.abort(reason);
    expect(await aborted).toBe(reason);
    let n = 0;
    const reconnect = fakeFetch(() => {
      if (n++ === 0) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', syscall: 'connect' } });
      return json(200, OK);
    });
    expect(await provider.call(BODY, KEY, signal(), reconnect, options(config.id))).toEqual({ body: OK, retried: true });
    expect(reconnect).toHaveBeenCalledTimes(2);
    const reset = fakeFetch(() => { throw Object.assign(new TypeError(`${KEY} ${ENDPOINT}`), { cause: { code: 'ECONNRESET', syscall: 'read' } }); });
    expect(await failure(provider.call(BODY, KEY, signal(), reset, options(config.id))))
      .toMatchObject({ kind: 'network', message: `连不上 ${config.displayName}（ECONNRESET）` });
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('gateway error shapes', () => {
  it.each([
    ['openrouter', 400, { error: { code: 400, message: 'typesafe/missing is not a valid model ID' } }, undefined],
    ['openrouter', 404, { error: { code: 404, message: 'No endpoints found for typesafe/missing' } }, undefined],
    ['vercel', 404, { error_type: 'model_not_found', message: 'PRIVATE_GROUP_RULES' }, 'model_not_found'],
    ['vercel', 400, { detail: { error_type: 'api_usage_error', message: 'Unknown model: missing' } }, 'api_usage_error'],
  ])('%s classifies an unavailable model without quoting the upstream message', async (id, status, body, errorType) => {
    const provider = decisionProvider(id as string)!;
    const error = await failure(provider.call(BODY, KEY, signal(), fakeFetch(() => json(status as number, body))));
    expect(error).toMatchObject({ kind: 'model', coolMs: 300_000, message: `${provider.displayName} 没有这个模型` });
    expect(error.info.errorType).toBe(errorType);
    expect(JSON.stringify([error.message, error.info])).not.toMatch(/missing|PRIVATE_GROUP_RULES/);
  });

  it('reads Vercel top-level validation codes and never treats them as TypeSafe errors', async () => {
    const error = await failure(decisionProvider('vercel')!.call(BODY, KEY, signal(), fakeFetch(() => json(400, { error_type: 'invalid_request', message: 'PRIVATE_GROUP_RULES' }))));
    expect(error).toMatchObject({ kind: 'failed', message: 'Vercel 不收这个请求（400 invalid_request）', info: { status: 400, errorType: 'invalid_request' } });
  });
});

describe('custom endpoint is checked again at the transport boundary', () => {
  const provider = decisionProvider('custom')!;
  it.each([undefined, '', 'file:///tmp/systemone', 'ftp://example.test/systemone', 'https://user:pass@example.test/systemone', `${ENDPOINT}?key=secret`, `${ENDPOINT}#secret`, `${ENDPOINT}?`, `${ENDPOINT}#`, 'not a url', 'https://bad host.test/systemone'])('rejects %s before any request', async (endpoint) => {
    const f = fakeFetch(() => json(200, OK));
    const error = await failure(provider.call(BODY, KEY, signal(), f, { endpoint }));
    expect(error).toMatchObject({ kind: 'failed' });
    expect(error.message).toContain('自定义 Jev 请求地址不可用');
    if (endpoint) expect(error.message).not.toContain(endpoint);
    expect(await provider.probe(KEY, signal(), f, { endpoint })).toMatchObject({ outcome: 'failed' });
    expect(f).not.toHaveBeenCalled();
  });

  it('permits a complete local HTTP endpoint and sends no redirects', async () => {
    const f = fakeFetch(() => json(200, OK));
    const endpoint = 'http://127.0.0.1:12000/v1/systemone';
    await provider.call(BODY, KEY, signal(), f, { endpoint });
    expect(f).toHaveBeenCalledExactlyOnceWith(endpoint, expect.objectContaining({ redirect: 'error' }));
  });

  it('does not let a preset be redirected through custom endpoint options', async () => {
    for (const config of CONFIGS.filter(({ id }) => id !== 'custom')) {
      const f = fakeFetch(() => json(200, OK));
      await decisionProvider(config.id)!.call(BODY, KEY, signal(), f, { endpoint: ENDPOINT });
      expect(f.mock.calls[0]![0]).toBe(config.url);
    }
  });
});
