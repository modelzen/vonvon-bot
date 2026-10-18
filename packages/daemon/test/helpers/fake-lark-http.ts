import { Client, DefaultCache, type HttpInstance, type HttpRequestOptions } from '@larksuiteoapi/node-sdk';

/**
 * A real SDK `Client` over a fake HTTP layer (s36d1): the SDK's own token fetch, URL building and error paths run,
 * nothing leaves the process. Each request is answered by `answer` (by method and path); when it has none or
 * gives (or resolves to) nothing, Feishu's plain success for that call. A request honours its abort signal the way axios does.
 */
export const FAKE_DOMAIN = 'https://open.feishu.test';
export type FakeRequest = { method: string; path: string; params?: Record<string, unknown>; data?: unknown; signal?: AbortSignal; timeout?: number };
export type Answer = (request: FakeRequest) => unknown;

const quiet = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

/** An axios-shaped HTTP failure carrying Feishu's body, as the SDK throws it. */
export function httpError(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}
/** An axios-shaped network failure with no response. */
export function networkError(code: string): Error {
  return Object.assign(new Error(code), { code });
}
/** Never answers; ends only when the request is aborted. */
export function stall(): Promise<never> {
  return new Promise<never>(() => {});
}

function plainSuccess(request: FakeRequest): unknown {
  const { method, path } = request;
  if (path === '/open-apis/auth/v3/tenant_access_token/internal') return { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 };
  // One group per uuid, as Feishu's dedupe would have it.
  if (method === 'POST' && path === '/open-apis/im/v1/chats') return { code: 0, data: { chat_id: typeof request.params?.uuid === 'string' ? `oc_${request.params.uuid}` : 'oc_created' } };
  if (method === 'GET' && /\/announcement\/blocks$/.test(path)) return { code: 0, data: { items: [{ block_type: 1, block_id: 'page', children: [] }] } };
  if (method === 'POST' && path === '/open-apis/im/v1/messages') return { code: 0, data: { message_id: 'om_welcome' } };
  if (method === 'GET' && /^\/open-apis\/im\/v1\/chats\/[^/]+$/.test(path)) return { code: 0, data: { name: 'group', chat_mode: 'group' } };
  return { code: 0, data: {} };
}

export function fakeLark(answer?: Answer) {
  const requests: FakeRequest[] = [];
  let open = 0;
  function handle(method: string, url: string, options: HttpRequestOptions<unknown> | undefined, data: unknown): Promise<unknown> {
    const request: FakeRequest = { method: method.toUpperCase(), path: new URL(url, FAKE_DOMAIN).pathname,
      params: options?.params as Record<string, unknown> | undefined, data, signal: (options as { signal?: AbortSignal } | undefined)?.signal, timeout: options?.timeout };
    requests.push(request);
    open++;
    return new Promise<unknown>((resolve, reject) => {
      const signal = request.signal;
      const cancel = () => reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED', name: 'CanceledError' }));
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      Promise.resolve().then(() => answer?.(request)).then(answered => answered ?? plainSuccess(request))
        .then(resolve, reject).finally(() => signal?.removeEventListener('abort', cancel));
    }).finally(() => { open--; });
  }
  const http: HttpInstance = {
    request: o => handle(o.method ?? 'GET', o.url ?? '', o, o.data) as never,
    get: (u, o) => handle('GET', u, o, undefined) as never,
    delete: (u, o) => handle('DELETE', u, o, undefined) as never,
    head: (u, o) => handle('HEAD', u, o, undefined) as never,
    options: (u, o) => handle('OPTIONS', u, o, undefined) as never,
    post: (u, d, o) => handle('POST', u, o, d) as never,
    put: (u, d, o) => handle('PUT', u, o, d) as never,
    patch: (u, d, o) => handle('PATCH', u, o, d) as never,
  };
  const client = new Client({ appId: 'cli_fixture', appSecret: 'synthetic-unused', domain: FAKE_DOMAIN, httpInstance: http, cache: new DefaultCache(), logger: quiet });
  return {
    client, requests,
    /** chat.create requests, in order. */
    creates: () => requests.filter(r => r.method === 'POST' && r.path === '/open-apis/im/v1/chats'),
    /** Requests handed out and not yet settled. */
    open: () => open,
  };
}
