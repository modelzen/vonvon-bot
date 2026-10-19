import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTypeSafe, DecisionError, DECISION_TIMEOUT_MS, probeTypeSafe, RETRY_MIN_MS, retryAfterMs, TYPESAFE_MODELS_URL, TYPESAFE_URL } from '../src/judge/typesafe';

const fake = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));
vi.mock('../src/core/logger', () => ({ log: fake.log }));

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
  vi.clearAllMocks();
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
    // a 2xx body that breaks halfway: the stream's error has its code on itself, not on a cause
    const cut = fakeFetch(() => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('{"model":"群消息原文')); c.error(Object.assign(new Error('read ECONNRESET 群消息原文'), { code: 'ECONNRESET' })); },
    }), { status: 200 }));
    const broken = await failure(callTypeSafe(BODY, KEY, new AbortController().signal, cut.fn));
    expect(broken).toMatchObject({ kind: 'network', message: '连不上 TypeSafe（ECONNRESET）', info: { code: 'ECONNRESET' } });
    expect(JSON.stringify([broken.message, broken.info])).not.toContain('群消息原文');
  });

  it('gives up after 5 s, the body read included, even when fetch ignores its signal', async () => {
    const hang = fakeFetch(() => new Promise<Response>(() => undefined));
    const first = failure(callTypeSafe(BODY, KEY, new AbortController().signal, hang.fn));
    await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS);
    expect(await first).toMatchObject({ kind: 'timeout', message: 'TypeSafe 5 秒没回', structured: false });
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
    expect(await second).toMatchObject({ kind: 'timeout', message: 'TypeSafe 5 秒没回' });
  });

  it('a status in hand outlives an error body that runs past 5 s: a 401 still cools, a 429 still says how long', async () => {
    const stalled = (status: number, headers: Record<string, string> = {}) =>
      fakeFetch(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"detail":')); } }), { status, headers }));
    const auth = failure(callTypeSafe(BODY, KEY, new AbortController().signal, stalled(401).fn));
    const busy = failure(callTypeSafe(BODY, KEY, new AbortController().signal, stalled(429, { 'retry-after': '30' }).fn));
    await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS);
    expect(await auth).toMatchObject({ kind: 'auth', coolMs: 300_000, structured: true, info: { status: 401 } });
    expect(await busy).toMatchObject({ kind: 'busy', coolMs: 30_000, structured: true });
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

describe('probeTypeSafe (s23g 试一次)', () => {
  const probe = (answer: Parameters<typeof fakeFetch>[0], key = KEY) => {
    const f = fakeFetch(answer);
    return { f, result: probeTypeSafe(key, new AbortController().signal, f.fn) };
  };
  it('asks the model list with the key as a bearer token, sends no body and follows no redirect', async () => {
    const { f, result } = probe(() => json(200, { data: [{ id: 'jev-latest' }] }));
    expect(await result).toEqual({ outcome: 'ok', message: '能用' });
    const { url, init } = f.calls[0]!;
    expect(url).toBe(TYPESAFE_MODELS_URL);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}`, Accept: 'application/json', 'User-Agent': 'vonvon-bot' });
  });

  const offline = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
  // Node's redirect: 'error' rejects as fetch failed with no code
  const redirect = Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
  it.each<[string, () => Response, object]>([
    ['401', () => json(401, { detail: { error_type: 'authentication_error' } }), { outcome: 'auth', message: 'key 不对：TypeSafe 不认这个 key', status: 401 }],
    ['402', () => json(402, {}), { outcome: 'failed', message: 'TypeSafe 不收这个请求（402）', status: 402 }],
    ['403', () => json(403, {}), { outcome: 'failed', message: 'TypeSafe 不收这个请求（403）', status: 403 }],
    ['429', () => json(429, {}), { outcome: 'busy', message: '连上了，但 TypeSafe 限流了，稍后再试', status: 429 }],
    ['503', () => json(503, {}), { outcome: 'network', message: 'TypeSafe 出错了（503）', status: 503 }],
    ['2xx not JSON', () => new Response('<html>', { status: 200 }), { outcome: 'failed', message: 'TypeSafe 回的内容读不懂', status: 200 }],
    ['offline', () => { throw offline; }, { outcome: 'network', message: '连不上 TypeSafe（ENOTFOUND）' }],
    ['a redirect', () => { throw redirect; }, { outcome: 'network', message: '连不上 TypeSafe' }],
  ])('%s', async (_, answer, expected) => {
    expect(await probe(answer).result).toEqual(expected);
  });

  it('5 s without an answer is a timeout; an error quoting the key never reaches the message', async () => {
    const hang = probe(() => new Promise<Response>(() => undefined));
    await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS);
    expect(await hang.result).toEqual({ outcome: 'timeout', message: 'TypeSafe 5 秒没回' });
    const quoted = await probe(({ init }) => { new Headers(init.headers); return json(200, {}); }, `${KEY}\nX: y`).result;
    expect(quoted).toEqual({ outcome: 'network', message: '连不上 TypeSafe' });
  });
});

/** fetch's error for a connection that failed, as undici throws it: `fetch failed` with Node's error as the cause. */
const fetchFailed = (cause: object) => Object.assign(new TypeError('fetch failed'), { cause });
const netError = (code: string, syscall: string, address?: string) =>
  Object.assign(new Error(`${syscall} ${code}${address ? ` ${address}:443` : ''}`), { code, syscall, ...(address ? { address, port: 443 } : {}) });
/** Node's happy eyeballs giving up on TypeSafe's two A and two AAAA records, on a host without an IPv6 route. */
const happyEyeballs = () => Object.assign(new AggregateError([
  netError('ETIMEDOUT', 'connect', '104.18.1.1'), netError('ENETUNREACH', 'connect', '2606:4700::1'),
  netError('ETIMEDOUT', 'connect', '104.18.2.2'), netError('ENETUNREACH', 'connect', '2606:4700::2'),
]), { code: 'ETIMEDOUT' });

describe('a connection that failed before sending is tried once more (s23f2)', () => {
  /** Answers with `first` the first time, then with `then`. */
  const twice = (first: () => Promise<Response> | Response, then: () => Promise<Response> | Response = () => json(200, OK)) => {
    let n = 0;
    return fakeFetch(() => (n++ === 0 ? first() : then()));
  };
  const retries = () => fake.log.info.mock.calls.filter((c) => c[1] === 'decision-retry');

  it('happy eyeballs timing out: tried again within the same 5 s, and the answer says it was retried', async () => {
    const f = twice(() => { throw fetchFailed(happyEyeballs()); });
    expect(await callTypeSafe(BODY, KEY, new AbortController().signal, f.fn)).toEqual({ body: OK, retried: true });
    expect(f.calls).toHaveLength(2);
    // the same request, the same signal
    expect(f.calls[1]!.init).toEqual(f.calls[0]!.init);
    expect(retries()).toHaveLength(1);
    expect(retries()[0]![2]).toEqual({ call: 'decision', code: 'ETIMEDOUT', attempts: ['ETIMEDOUT/v4', 'ENETUNREACH/v6', 'ETIMEDOUT/v4', 'ENETUNREACH/v6'], ms: 0 });
    expect(JSON.stringify(fake.log.info.mock.calls)).not.toMatch(/104\.18|2606:4700|TESTKEY|群消息原文/);
  });

  it.each<[string, object]>([
    ['refused', netError('ECONNREFUSED', 'connect', '104.18.1.1')],
    ['no route', netError('EHOSTUNREACH', 'connect', '104.18.1.1')],
    ['network unreachable', netError('ENETUNREACH', 'connect', '2606:4700::1')],
    ['DNS not answering', netError('EAI_AGAIN', 'getaddrinfo')],
    ["undici's connect timeout", Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })],
  ])('%s: tried again', async (_, cause) => {
    const f = twice(() => { throw fetchFailed(cause); });
    expect(await callTypeSafe(BODY, KEY, new AbortController().signal, f.fn)).toMatchObject({ body: OK, retried: true });
    expect(f.calls).toHaveLength(2);
  });

  it.each<[string, () => Response]>([
    ['a reset after connecting', () => { throw fetchFailed(netError('ECONNRESET', 'read')); }],
    ['a timeout after connecting', () => { throw fetchFailed(netError('ETIMEDOUT', 'read')); }],
    ['the socket closed by the other side', () => { throw fetchFailed(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })); }],
    ['an attempt that got further than connect', () => { throw fetchFailed(Object.assign(new AggregateError([netError('ETIMEDOUT', 'connect', '104.18.1.1'), netError('ECONNRESET', 'read', '104.18.2.2')]), { code: 'ETIMEDOUT' })); }],
    ['a name that does not exist', () => { throw fetchFailed(netError('ENOTFOUND', 'getaddrinfo')); }],
    ['an error with no cause', () => { throw new TypeError('fetch failed'); }],
    ['a 5xx', () => json(503, {})],
    ['an answer it cannot read', () => new Response('<html>', { status: 200 })],
  ])('%s: not tried again, as the request may have been sent and charged', async (_, first) => {
    const f = twice(first);
    const error = await failure(callTypeSafe(BODY, KEY, new AbortController().signal, f.fn));
    expect(f.calls).toHaveLength(1);
    expect(error.info.retried).toBeUndefined();
    expect(retries()).toHaveLength(0);
  });

  it('a read timeout is not tried again', async () => {
    const f = twice(() => new Promise<Response>(() => undefined));
    const first = failure(callTypeSafe(BODY, KEY, new AbortController().signal, f.fn));
    await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS);
    expect(await first).toMatchObject({ kind: 'timeout' });
    expect(f.calls).toHaveLength(1);
  });

  it('only with 1.5 s of the 5 s left', async () => {
    const after = (ms: number) => () => new Promise<Response>((_, reject) => setTimeout(() => reject(fetchFailed(netError('ECONNREFUSED', 'connect', '104.18.1.1'))), ms));
    const late = twice(after(DECISION_TIMEOUT_MS - RETRY_MIN_MS + 1));
    const lateCall = failure(callTypeSafe(BODY, KEY, new AbortController().signal, late.fn));
    await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS - RETRY_MIN_MS + 1);
    expect(await lateCall).toMatchObject({ kind: 'network', message: '连不上 TypeSafe（ECONNREFUSED）', info: { code: 'ECONNREFUSED' } });
    expect(late.calls).toHaveLength(1);
    const inTime = twice(after(DECISION_TIMEOUT_MS - RETRY_MIN_MS));
    const inTimeCall = callTypeSafe(BODY, KEY, new AbortController().signal, inTime.fn);
    await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS - RETRY_MIN_MS);
    expect(await inTimeCall).toMatchObject({ retried: true });
    expect(inTime.calls).toHaveLength(2);
  });

  it('the retry shares the 5 s: a second attempt that hangs ends at 5 s from the first', async () => {
    const f = twice(() => { throw fetchFailed(happyEyeballs()); }, () => new Promise<Response>(() => undefined));
    const call = failure(callTypeSafe(BODY, KEY, new AbortController().signal, f.fn));
    await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS);
    expect(await call).toMatchObject({ kind: 'timeout', info: { retried: true } });
    expect(f.calls).toHaveLength(2);
  });

  it('only once: a second failure is the error, with each attempt by code and family and no address', async () => {
    const f = twice(() => { throw fetchFailed(happyEyeballs()); }, () => { throw fetchFailed(happyEyeballs()); });
    const error = await failure(callTypeSafe(BODY, KEY, new AbortController().signal, f.fn));
    expect(f.calls).toHaveLength(2);
    expect(error).toMatchObject({ kind: 'network', message: '连不上 TypeSafe（ETIMEDOUT）' });
    expect(error.info).toEqual({ code: 'ETIMEDOUT', attempts: ['ETIMEDOUT/v4', 'ENETUNREACH/v6', 'ETIMEDOUT/v4', 'ENETUNREACH/v6'], retried: true });
    expect(JSON.stringify([error.message, error.info])).not.toMatch(/104\.18|2606:4700/);
    // a status after the retry says so too
    const busy = await failure(callTypeSafe(BODY, KEY, new AbortController().signal, twice(() => { throw fetchFailed(happyEyeballs()); }, () => json(429, {})).fn));
    expect(busy).toMatchObject({ kind: 'busy', info: { status: 429, retried: true } });
  });

  it('a caller that gave up is not tried again', async () => {
    const ctl = new AbortController();
    const reason = new Error('judge timeout');
    const f = twice(() => { ctl.abort(reason); throw fetchFailed(happyEyeballs()); });
    await expect(callTypeSafe(BODY, KEY, ctl.signal, f.fn)).rejects.toBe(reason);
    expect(f.calls).toHaveLength(1);
  });

  it('试一次 is tried again the same way', async () => {
    const f = twice(() => { throw fetchFailed(happyEyeballs()); }, () => json(200, { data: [] }));
    expect(await probeTypeSafe(KEY, new AbortController().signal, f.fn)).toEqual({ outcome: 'ok', message: '能用' });
    expect(f.calls.map((c) => c.url)).toEqual([TYPESAFE_MODELS_URL, TYPESAFE_MODELS_URL]);
    expect(retries()[0]![2]).toMatchObject({ call: 'probe', code: 'ETIMEDOUT' });
  });
});
