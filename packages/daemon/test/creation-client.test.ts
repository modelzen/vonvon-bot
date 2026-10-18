import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { AppType, Client, DefaultCache, type HttpInstance } from '@larksuiteoapi/node-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CreationClientClosedError, withCreationClient, type CreationLimits } from '../src/project/creation-client';
import { FAKE_DOMAIN, fakeLark } from './helpers/fake-lark-http';

const quiet = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const request = { method: 'POST', url: 'open-apis/im/v1/chats', params: { uuid: 'stable-operation-fixture', user_id_type: 'open_id' },
  data: { name: 'Research', user_id_list: ['ou_fixture'] } };
function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release: () => release() };
}
const response = z.object({ code: z.literal(0), data: z.object({ chat_id: z.string() }) });
const options = z.object({ signal: z.instanceof(AbortSignal), timeout: z.number().positive() });
function client(httpInstance?: HttpInstance, domain = 'http://127.0.0.1:1') {
  return new Client({ appId: 'cli_fixture', appSecret: 'synthetic-unused', ...(httpInstance ? { httpInstance } : {}), domain, logger: quiet, cache: new DefaultCache() });
}
afterEach(() => vi.useRealTimers());

async function serverFixture(stall?: 'auth' | 'create') {
  const sockets = new Set<Socket>(), seen = gate(), closed = gate();
  const received: { method?: string; url?: string; auth?: string; body: unknown; header?: string }[] = [];
  let late = () => {};
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += String(part);
    received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: text ? JSON.parse(text) : undefined,
      header: typeof req.headers['x-fixture'] === 'string' ? req.headers['x-fixture'] : undefined });
    const kind = req.url?.includes('/auth/') ? 'auth' : 'create';
    const body = kind === 'auth' ? { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 } : { code: 0, data: { chat_id: 'oc_created' } };
    const send = () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
    if (kind === stall) { late = send; req.socket.once('close', closed.release); seen.release(); }
    else send();
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture endpoint');
  return { raw: client(undefined, `http://127.0.0.1:${address.port}`), received, seen: seen.promise, closed: closed.promise,
    late: () => late(), async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}

function stalledTransport(autoAcknowledge = true) {
  const seen = gate(), aborted = gate(), starts: { signal: AbortSignal; timeout: number; acknowledge: () => void; done: Promise<void> }[] = [];
  const failure = new Error('canceled fixture request');
  let aborts = 0;
  function send(input: unknown): Promise<never> {
    const config = options.parse(input), acknowledgment = gate();
    let fail = (_error: Error) => {};
    const promise = new Promise<never>((_resolve, reject) => { fail = reject; });
    config.signal.addEventListener('abort', () => {
      aborts++; aborted.release();
      if (autoAcknowledge) acknowledgment.release();
      void acknowledgment.promise.then(() => fail(failure));
    }, { once: true });
    starts.push({ ...config, acknowledge: acknowledgment.release, done: promise.then(() => {}, () => {}) });
    seen.release();
    return promise;
  }
  const http: HttpInstance = { request: send, get: (_u, o) => send(o), delete: (_u, o) => send(o), head: (_u, o) => send(o),
    options: (_u, o) => send(o), post: (_u, _d, o) => send(o), put: (_u, _d, o) => send(o), patch: (_u, _d, o) => send(o) };
  return { http, starts, failure, seen: seen.promise, aborted: aborted.promise, aborts: () => aborts };
}

it('uses real cold-cache authentication, preserves the create request and leaves the ordinary client usable', async () => {
  const f = await serverFixture();
  try {
    const original = { cache: f.raw.cache, http: f.raw.httpInstance };
    for (let i = 0; i < 2; i++) {
      const result = await withCreationClient(f.raw, scoped => scoped.request<unknown>(request));
      expect(response.parse(result).data.chat_id).toBe('oc_created');
    }
    expect(f.received.map(r => r.url?.split('?')[0])).toEqual([
      '/open-apis/auth/v3/tenant_access_token/internal', '/open-apis/im/v1/chats',
      '/open-apis/auth/v3/tenant_access_token/internal', '/open-apis/im/v1/chats',
    ]);
    expect(f.received[1]).toMatchObject({ method: 'POST', auth: 'Bearer synthetic-token', body: request.data });
    expect(f.received[1]?.url).toContain('uuid=stable-operation-fixture');
    expect(f.received[1]?.body).not.toHaveProperty('owner_id');
    expect(f.raw.cache).toBe(original.cache); expect(f.raw.httpInstance).toBe(original.http);
    expect(response.parse(await f.raw.request<unknown>(request)).data.chat_id).toBe('oc_created');
    expect(f.received).toHaveLength(6);
  } finally { await f.close(); }
});

it('forwards every SDK HTTP method and refuses escaped clients after scope closure', async () => {
  const f = await serverFixture();
  try {
    let retained: Client | undefined;
    await withCreationClient(f.raw, async scoped => {
      retained = scoped;
      const url = `${scoped.domain}/probe`, config = { headers: { 'x-fixture': 'kept' }, params: { q: 'retained' } };
      await scoped.httpInstance.request({ ...config, method: 'POST', url, data: { body: 'request' } });
      await scoped.httpInstance.get(url, config); await scoped.httpInstance.delete(url, config);
      await scoped.httpInstance.head(url, config); await scoped.httpInstance.options(url, config);
      await scoped.httpInstance.post(url, { body: 'post' }, config); await scoped.httpInstance.put(url, { body: 'put' }, config);
      await scoped.httpInstance.patch(url, { body: 'patch' }, config);
    });
    expect(f.received.map(r => r.method)).toEqual(['POST', 'GET', 'DELETE', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH']);
    expect(f.received.every(r => r.header === 'kept' && r.url === '/probe?q=retained')).toBe(true);
    expect(f.received.filter(r => r.body).map(r => r.body)).toEqual([{ body: 'request' }, { body: 'post' }, { body: 'put' }, { body: 'patch' }]);
    if (!retained) throw new Error('Missing retained client');
    await expect(retained.request(request)).rejects.toBeInstanceOf(CreationClientClosedError);
    expect(f.received).toHaveLength(8);
  } finally { await f.close(); }
});

it.each(['auth', 'create'] as const)('aborts actual Axios during %s and waits for socket closure without another create', async stage => {
  const f = await serverFixture(stage), abort = new AbortController();
  try {
    const result = withCreationClient(f.raw, scoped => scoped.request(request), { signal: abort.signal }).catch(error => error);
    await f.seen; abort.abort();
    expect(await result).toBeInstanceOf(Error); await f.closed;
    f.late();
    expect(f.received).toHaveLength(stage === 'auth' ? 1 : 2);
  } finally { await f.close(); }
});

it('waits for both canceled requests to acknowledge termination and preserves the original callback error', async () => {
  const transport = stalledTransport(false), raw = client(transport.http), ready = gate();
  const primary = new Error('callback failure'), terminals: Promise<unknown>[] = [];
  let finished = false;
  const result = withCreationClient(raw, async scoped => {
    terminals.push(scoped.request(request).catch(error => error));
    await transport.seen;
    terminals.push(scoped.httpInstance.post('/second').catch(error => error)); ready.release();
    throw primary;
  }).catch(error => { finished = true; return error; });
  await ready.promise; await transport.aborted;
  expect(transport.starts).toHaveLength(2); expect(transport.aborts()).toBe(2);
  const [first, second] = transport.starts;
  if (!first || !second) throw new Error('Missing started requests');
  first.acknowledge(); await first.done;
  expect(finished).toBe(false);
  second.acknowledge(); expect(await result).toBe(primary);
  await Promise.all(terminals);
});

it('uses one decreasing deadline for authentication and every later request and leaves no timer', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const transport = stalledTransport(), raw = client(transport.http), ready = gate();
  const result = withCreationClient(raw, async scoped => {
    const auth = scoped.request(request).catch(error => error);
    await transport.seen; ready.release();
    await vi.advanceTimersByTimeAsync(10_000);
    const later = scoped.httpInstance.post('/another').catch(error => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await auth).toBe(transport.failure); expect(await later).toBe(transport.failure);
    await expect(scoped.httpInstance.get('/too-late')).rejects.toBeInstanceOf(CreationClientClosedError);
  });
  await ready.promise; await result;
  expect(transport.starts.map(r => r.timeout)).toEqual([30_000, 20_000]);
  expect(transport.starts[0]?.signal).toBe(transport.starts[1]?.signal);
  expect(transport.aborts()).toBe(2); expect(vi.getTimerCount()).toBe(0);
});

it('closes admission before an unawaited SDK continuation can send after callback return', async () => {
  const transport = stalledTransport();
  let terminal: Promise<unknown> = Promise.resolve();
  await withCreationClient(client(transport.http), async scoped => {
    terminal = scoped.request(request).catch(error => error);
  });
  const starts = transport.starts.length;
  expect(await terminal).toBeInstanceOf(Error);
  expect(transport.starts).toHaveLength(starts);
  expect(transport.starts.every(r => r.signal.aborted)).toBe(true);
});

it('refuses an already canceled scope and invalid budgets without sending HTTP or invoking work for invalid setup', async () => {
  const transport = stalledTransport(), raw = client(transport.http), abort = new AbortController();
  abort.abort();
  await expect(withCreationClient(raw, scoped => scoped.request(request), { signal: abort.signal })).rejects.toBeInstanceOf(CreationClientClosedError);
  const work = vi.fn(async () => {});
  for (const timeoutMs of [0, -1, NaN, Infinity, 2_147_483_648]) await expect(withCreationClient(raw, work, { timeoutMs })).rejects.toThrow('budget');
  raw.appType = AppType.ISV;
  await expect(withCreationClient(raw, work)).rejects.toThrow('app-secret');
  expect(work).not.toHaveBeenCalled(); expect(transport.starts).toHaveLength(0);
});

it('s36d1: reports each admitted request before sending it, never a refused one, and hands the work its limits', async () => {
  const fake = fakeLark(), sent: { method: string; url: string }[] = [];
  let escaped: Client | undefined;
  let limits: CreationLimits | undefined;
  const started = performance.now();
  await withCreationClient(fake.client, async (scoped, given) => {
    escaped = scoped; limits = given;
    expect(given.signal.aborted).toBe(false);
    await scoped.im.v1.chat.create({ params: { user_id_type: 'open_id', uuid: 'fixture' }, data: { name: 'Research' } });
  }, { onSend: sent.push.bind(sent), timeoutMs: 5_000 });
  // The deadline the requests are held to, and a signal that ends with the scope.
  expect(limits?.deadline).toBeGreaterThanOrEqual(started + 5_000);
  expect(limits?.deadline).toBeLessThanOrEqual(performance.now() + 5_000);
  expect(limits?.signal.aborted).toBe(true);
  // lifecycle.ts knows chat.create by exactly this method and URL.
  expect(sent).toEqual([{ method: 'POST', url: `${FAKE_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal` }, { method: 'POST', url: `${FAKE_DOMAIN}/open-apis/im/v1/chats` }]);
  await expect(escaped?.request(request)).rejects.toBeInstanceOf(CreationClientClosedError);
  expect(sent).toHaveLength(2); expect(fake.requests).toHaveLength(2);
});
