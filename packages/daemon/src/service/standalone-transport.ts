import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { ReadableStreamReadResult } from 'node:stream/web';

export type ServerFetch = (url: string, init?: RequestInit) => Promise<Response>;
export const SERVER_SOURCE_GRACE_MS = 300;
export const SERVER_CONNECT_MS = 8_000;
export const SERVER_IDLE_MS = 15_000;

/** Fetch adapters and streams must not be able to turn an ignored abort into an unbounded wait. */
export function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    void promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', aborted); });
  });
}

/** Also close a response that arrives after its losing request was aborted. */
export function fetchWithAbort(fetcher: ServerFetch, url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  const pending = Promise.resolve().then(() => fetcher(url, init));
  void pending.then(response => { if (init.signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
  return untilAbort(pending, init.signal);
}

/** The primary wins immediately; a usable mirror gives the primary only a short grace, never a connect timeout. */
export function firstUsableSource<T>(sources: string[], read: (source: string, signal: AbortSignal) => Promise<T>, graceMs = SERVER_SOURCE_GRACE_MS): Promise<{ value: T; source: string }> {
  if (!sources.length) return Promise.reject(new Error('No download source'));
  return new Promise((resolve, reject) => {
    const controllers = sources.map(() => new AbortController());
    const errors: unknown[] = [];
    let pending = sources.length;
    let primaryFailed = false;
    let finished = false;
    let fallback: { value: T; source: string } | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const close = (): void => {
      finished = true;
      if (grace) clearTimeout(grace);
      controllers.forEach(controller => { controller.abort(); });
    };
    const choose = (result: { value: T; source: string }): void => { close(); resolve(result); };
    sources.forEach((source, index) => {
      void Promise.resolve().then(() => read(source, controllers[index]!.signal)).then(value => {
        if (finished) return;
        pending--;
        const result = { value, source };
        if (index === 0 || primaryFailed) { choose(result); return; }
        fallback ??= result;
        grace ??= setTimeout(() => { if (!finished && fallback) choose(fallback); }, graceMs);
      }, error => {
        if (finished) return;
        errors[index] = error;
        pending--;
        if (index === 0) primaryFailed = true;
        if (fallback && primaryFailed) { choose(fallback); return; }
        if (!pending) { close(); reject(new AggregateError(errors.filter(error => error !== undefined), 'All download sources failed')); }
      });
    });
  });
}

export class ServerDownloadError extends Error {}
type SignedFile = { size: number; sha512: string };
export type ServerDownloadOptions = {
  file: SignedFile;
  urls: string[];
  destination: string;
  fetcher?: ServerFetch;
  onProgress?: (transferred: number) => void;
  onVerifying?: (transferred: number) => void;
  onRetry?: () => void;
  /** Dependency injection for bounded local tests; not user-configurable update-source settings. */
  policy?: { connectMs: number; idleMs: number };
};

/**
 * Download exactly the signed bytes. A stalled/broken source is retried from byte zero on another trusted source.
 * Restarting is deliberate: no partial bytes from different versions or origins are ever combined. A download with
 * continued progress has no total time limit. Each source is attempted once and redirects are never followed.
 */
export async function downloadServerArtifact(options: ServerDownloadOptions): Promise<void> {
  const { file, urls, destination, onProgress, onVerifying, onRetry } = options;
  const fetcher = options.fetcher ?? fetch;
  const policy = options.policy ?? { connectMs: SERVER_CONNECT_MS, idleMs: SERVER_IDLE_MS };
  if (!urls.length) throw new ServerDownloadError('没有可用的下载源');
  const handle = await open(destination, 'wx', 0o600);
  let failure: unknown;
  try {
    for (const [attempt, url] of [...new Set(urls)].entries()) {
      if (attempt) { await handle.truncate(0); onRetry?.(); }
      const controller = new AbortController();
      let deadline = setTimeout(() => { controller.abort(new ServerDownloadError('下载连接超时')); }, policy.connectMs);
      const idleDeadline = (): void => {
        clearTimeout(deadline);
        deadline = setTimeout(() => { controller.abort(new ServerDownloadError('下载暂时没有进展')); }, policy.idleMs);
      };
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        try { response = await fetchWithAbort(fetcher, url, { signal: controller.signal, redirect: 'error', headers: { 'accept-encoding': 'identity' } }); }
        catch { throw new ServerDownloadError('连接下载源失败'); }
        const length = response.headers.get('content-length');
        if (response.status !== 200 || !response.body) throw new ServerDownloadError(`下载失败：HTTP ${response.status}`);
        if (length !== null && (!/^\d+$/.test(length) || Number(length) !== file.size)) throw new ServerDownloadError('下载的大小和发布清单不一致');
        reader = response.body.getReader();
        const hash = createHash('sha512');
        let transferred = 0;
        let reported = 0;
        idleDeadline();
        for (;;) {
          let part: ReadableStreamReadResult<Uint8Array>;
          try { part = await untilAbort(reader.read(), controller.signal); }
          catch { throw new ServerDownloadError('下载连接中断或暂时没有进展'); }
          if (part.done) break;
          if (!part.value.byteLength) continue;
          if (transferred + part.value.byteLength > file.size) throw new ServerDownloadError('下载的大小和发布清单不一致');
          clearTimeout(deadline); // Local disk time is not a stalled network connection.
          // Positioned writes also make a retry after truncate independent of the previous attempt's file offset.
          let written = 0;
          while (written < part.value.byteLength) {
            const result = await handle.write(part.value, written, part.value.byteLength - written, transferred + written);
            if (!result.bytesWritten) throw new Error('Could not write downloaded bytes');
            written += result.bytesWritten;
          }
          transferred += part.value.byteLength;
          hash.update(part.value);
          idleDeadline();
          if (transferred - reported >= 1024 * 1024) { reported = transferred; onProgress?.(transferred); }
        }
        onVerifying?.(transferred);
        if (transferred !== file.size || hash.digest('hex') !== file.sha512) throw new ServerDownloadError('下载内容和发布清单不一致');
        return;
      } catch (error) {
        if (!(error instanceof ServerDownloadError)) throw error; // Disk/state failures do not trigger another download.
        failure = error;
      } finally {
        clearTimeout(deadline);
        controller.abort();
        if (reader) {
          void reader.cancel().catch(() => undefined);
          try { reader.releaseLock(); } catch { /* A pending adapter read is cancelled above. */ }
        } else { void response?.body?.cancel().catch(() => undefined); }
      }
    }
    throw failure;
  } finally { await handle.close(); }
}
