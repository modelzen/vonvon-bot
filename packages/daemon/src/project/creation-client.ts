import { AppType, Client, DefaultCache, type HttpInstance, type HttpRequestOptions } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

/** `onSend` sees each request the scope hands to the transport, after admission; refused ones never reach it. */
type Budget = Readonly<{ timeoutMs?: number; signal?: AbortSignal; onSend?: (request: Readonly<{ method: string; url: string }>) => void }>;
type Result<T> = { kind: 'value'; value: T } | { kind: 'error'; error: unknown };
const quietLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

export class CreationClientClosedError extends Error {
  constructor() { super('Creation request scope is closed'); }
}

/** The scope ran out of time or was stopped, so trying again inside it cannot help (s36d1). */
export function creationStopped(error: unknown): boolean {
  if (error instanceof CreationClientClosedError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ERR_CANCELED' || code === 'ECONNABORTED' || code === 'ETIMEDOUT';
}

/** Own authentication and every HTTP request through cancellation and settlement.
 * Callers still await SDK methods; a closed scope refuses late SDK continuations. */
export async function withCreationClient<T>(raw: Client, work: (client: Client) => Promise<T>, budget: Budget = {}): Promise<T> {
  const { timeoutMs = 30_000, signal, onSend } = budget;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError('Invalid creation request budget');
  if (raw.appType !== AppType.SelfBuild || raw.clientAssertionProvider || !raw.appSecret) throw new Error('Creation requires app-secret authentication');
  const base = raw.httpInstance;
  const abort = new AbortController(), pending = new Set<Promise<unknown>>();
  const deadline = performance.now() + timeoutMs;
  let closed = false;
  const close = () => { closed = true; abort.abort(); };
  const timer = setTimeout(close, timeoutMs);
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();

  function forward<D, R>(method: string, url: string, input: HttpRequestOptions<D> | undefined,
    send: (options: HttpRequestOptions<D> & { signal: AbortSignal; timeout: number }) => Promise<R>): Promise<R> {
    if (closed || performance.now() >= deadline) return Promise.reject(new CreationClientClosedError());
    try {
      onSend?.({ method: method.toUpperCase(), url });
      const request = send({ ...input, signal: abort.signal, timeout: Math.max(1, Math.ceil(deadline - performance.now())) });
      pending.add(request);
      void request.then(() => pending.delete(request), () => pending.delete(request));
      return request;
    } catch (error) { return Promise.reject(error); }
  }
  const http: HttpInstance = {
    request: <A = unknown, R = A, D = unknown>(o: HttpRequestOptions<D>) => forward(o.method ?? 'GET', o.url ?? '', o, c => base.request<A, R, D>(c)),
    get: <A = unknown, R = A, D = unknown>(u: string, o?: HttpRequestOptions<D>) => forward('GET', u, o, c => base.get<A, R, D>(u, c)),
    delete: <A = unknown, R = A, D = unknown>(u: string, o?: HttpRequestOptions<D>) => forward('DELETE', u, o, c => base.delete<A, R, D>(u, c)),
    head: <A = unknown, R = A, D = unknown>(u: string, o?: HttpRequestOptions<D>) => forward('HEAD', u, o, c => base.head<A, R, D>(u, c)),
    options: <A = unknown, R = A, D = unknown>(u: string, o?: HttpRequestOptions<D>) => forward('OPTIONS', u, o, c => base.options<A, R, D>(u, c)),
    post: <A = unknown, R = A, D = unknown>(u: string, d?: D, o?: HttpRequestOptions<D>) => forward('POST', u, o, c => base.post<A, R, D>(u, d, c)),
    put: <A = unknown, R = A, D = unknown>(u: string, d?: D, o?: HttpRequestOptions<D>) => forward('PUT', u, o, c => base.put<A, R, D>(u, d, c)),
    patch: <A = unknown, R = A, D = unknown>(u: string, d?: D, o?: HttpRequestOptions<D>) => forward('PATCH', u, o, c => base.patch<A, R, D>(u, d, c)),
  };
  let outcome: Result<T>;
  try {
    const client = new Client({ appId: raw.appId, appSecret: raw.appSecret, domain: raw.domain,
      cache: new DefaultCache(), httpInstance: http, logger: quietLogger, source: 'vonvon-create' });
    outcome = { kind: 'value', value: await work(client) };
  } catch (error) { outcome = { kind: 'error', error }; }

  closed = true;
  clearTimeout(timer);
  signal?.removeEventListener('abort', close);
  let cleanup: Result<void> = { kind: 'value', value: undefined };
  try { abort.abort(); }
  catch (error) { cleanup = { kind: 'error', error }; }
  await Promise.allSettled([...pending]);
  if (outcome.kind === 'error') {
    if (cleanup.kind === 'error') {
      try { log.warn('project', 'creation-client-cleanup-failed'); } catch {}
    }
    throw outcome.error;
  }
  if (cleanup.kind === 'error') throw cleanup.error;
  return outcome.value;
}
