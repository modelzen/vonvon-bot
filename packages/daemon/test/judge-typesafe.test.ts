import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTypeSafe, DecisionError, DECISION_TIMEOUT_MS, retryAfterMs, TYPESAFE_URL } from '../src/judge/typesafe';

const KEY = 'ts_TESTKEY0000';
const BODY = { model: 'jev-latest', state: { new_message: { text: '群消息原文' } }, questions: {} };
const OK = { model: 'jev-1.13.0', answers: { decision: { type: 'choice', choice: 'skip', confidence: 0.4, probabilities: { skip: 0.7, reply: 0.3 } } } };

type Call = { url: string; init: RequestInit };
function fakeFetch(answer: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
/** The failure a call rejects with. */
async function failure(promise: Promise<unknown>): Promise<DecisionError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(DecisionError);
  return error as DecisionError;
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-18T10:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('callTypeSafe (s23f 做法（调用）)', () => {
  it('posts the body with the key as a bearer token, follows no redirect, and gives back the answer and request id', async () => {
    const f = fakeFetch(() => json(200, OK, { 'x-typesafe-request-id': 'req_01abc<script>' }));
    expect(await callTypeSafe(BODY, KEY, new AbortController().signal, f.fn)).toEqual({ body: OK, requestId: 'req_01abcscript' });
    const { url, init } = f.calls[0]!;
    expect(url).toBe(TYPESAFE_URL);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'vonvon-bot' });
    expect(JSON.parse(init.body as string)).toEqual(BODY);
  });

  it.each<[string, Response, Partial<DecisionError>]>([
    ['401', json(401, { detail: { error_type: 'authentication_error', message: 'Cannot authenticate' } }), { kind: 'auth', coolMs: 300_000, structured: true, info: { status: 401, errorType: 'authentication_error' } }],
    ['429 retry-after 30', json(429, {}, { 'retry-after': '30' }), { kind: 'busy', coolMs: 30_000, structured: true }],
    ['429 without retry-after', json(429, {}), { kind: 'busy', coolMs: 60_000 }],
    ['400 Unknown model', json(400, { detail: { error_type: 'api_usage_error', message: 'Unknown model: jev-nonexistent' } }), { kind: 'model', coolMs: 300_000, message: 'TypeSafe 没有这个模型' }],
    ['400 other usage error', json(400, { detail: { error_type: 'api_usage_error', message: 'something else' } }), { kind: 'failed', coolMs: undefined, structured: false }],
    ['400 max_tokens_exceeded', json(400, { detail: { error_type: 'max_tokens_exceeded' } }), { kind: 'failed', coolMs: undefined, message: 'TypeSafe 不收这个请求（400 max_tokens_exceeded）' }],
    ['422 echoing a field', json(422, { detail: [{ type: 'too_short', loc: ['body', 'state'], input: '群消息原文' }] }), { kind: 'failed', info: { status: 422, errorType: 'too_short' } }],
    ['413 not JSON', new Response('<html>群消息原文</html>', { status: 413 }), { kind: 'failed', message: 'TypeSafe 不收这个请求（413）' }],
    ['402', json(402, {}), { kind: 'failed', coolMs: undefined }],
    ['403', json(403, {}), { kind: 'failed' }],
    ['404', json(404, {}), { kind: 'failed' }],
    ['529', json(529, {}), { kind: 'network', coolMs: undefined, message: 'TypeSafe 出错了（529）' }],
    ['500', new Response('群消息原文', { status: 500 }), { kind: 'network', coolMs: undefined }],
  ])('%s', async (_, res, expected) => {
    const error = await failure(callTypeSafe(BODY, KEY, new AbortController().signal, fakeFetch(() => res).fn));
    expect(error).toMatchObject(expected);
    // only our words: never the body, the request or the key
    expect(JSON.stringify([error.message, error.info])).not.toMatch(/群消息原文|Cannot authenticate|jev-nonexistent|TESTKEY/);
  });

  it('a 2xx that is not JSON, or longer than 64 KiB, is a format failure that quotes none of it', async () => {
    for (const res of [new Response('<html>群消息原文</html>', { status: 200 }), new Response(`{"a":"${'x'.repeat(70 * 1024)}"}`, { status: 200 })]) {
      const error = await failure(callTypeSafe(BODY, KEY, new AbortController().signal, fakeFetch(() => res).fn));
      expect(error).toMatchObject({ kind: 'format', message: '决策模型没按格式回答', structured: false, info: { status: 200 } });
      expect(error.message).not.toContain('群消息原文');
    }
  });

  it('an error fetch throws becomes a fixed message, with only the network code kept', async () => {
    const offline = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.typesafe.ai'), { code: 'ENOTFOUND' }) });
    expect(await failure(callTypeSafe(BODY, KEY, new AbortController().signal, fakeFetch(() => { throw offline; }).fn)))
      .toMatchObject({ kind: 'network', message: '连不上 TypeSafe（ENOTFOUND）', info: { code: 'ENOTFOUND' }, structured: false });
    // Node's Headers check quotes the whole header, key and all
    const bad = `${KEY}\nX: y`;
    const error = await failure(callTypeSafe(BODY, bad, new AbortController().signal, fakeFetch(({ init }) => { new Headers(init.headers); return json(200, OK); }).fn));
    expect(error).toMatchObject({ kind: 'network', message: '连不上 TypeSafe' });
    expect(JSON.stringify([error.message, error.info])).not.toContain('TESTKEY');
  });

  it('gives up after 5 s, the body read included, even when fetch ignores its signal', async () => {
    const hang = fakeFetch(() => new Promise<Response>(() => undefined));
    const first = failure(callTypeSafe(BODY, KEY, new AbortController().signal, hang.fn));
    await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS);
    expect(await first).toMatchObject({ kind: 'network', message: 'TypeSafe 5 秒没回' });
    expect((hang.calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
    // headers came, the body never ends
    const slow = fakeFetch(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"model":')); } }), { status: 200 }));
    const second = failure(callTypeSafe(BODY, KEY, new AbortController().signal, slow.fn));
    await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS - 1);
    let settled = false;
    void second.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toMatchObject({ kind: 'network', message: 'TypeSafe 5 秒没回' });
  });

  it('an abort from outside rejects with its reason at once, and is forwarded to fetch', async () => {
    const reason = new Error('judge timeout');
    const ctl = new AbortController();
    const hang = fakeFetch(() => new Promise<Response>(() => undefined));
    const call = callTypeSafe(BODY, KEY, ctl.signal, hang.fn).then(() => undefined, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    ctl.abort(reason);
    expect(await call).toBe(reason);
    expect((hang.calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
    // already aborted: nothing is sent
    const none = fakeFetch(() => json(200, OK));
    await expect(callTypeSafe(BODY, KEY, ctl.signal, none.fn)).rejects.toBe(reason);
    expect(none.calls).toHaveLength(0);
  });

  it('retry-after: seconds or an HTTP date, kept within 1 s and 10 minutes, else 1 minute', () => {
    const now = Date.parse('2026-10-18T10:00:00Z');
    expect(retryAfterMs('30', now)).toBe(30_000);
    expect(retryAfterMs('0', now)).toBe(1_000);
    expect(retryAfterMs('99999', now)).toBe(600_000);
    expect(retryAfterMs('Sun, 18 Oct 2026 10:02:00 GMT', now)).toBe(120_000);
    expect(retryAfterMs('Sun, 18 Oct 2026 09:00:00 GMT', now)).toBe(1_000);
    for (const bad of [null, '', 'soon', '-5', '1.5']) expect(retryAfterMs(bad, now)).toBe(60_000);
  });
});
