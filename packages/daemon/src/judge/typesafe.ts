import { JudgeCallError } from '../agent/types';
import type { JudgeErrorKind } from './types';

/** TypeSafe's decision endpoint (Jev report 第 1 节). */
export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
/** From sending the request to the last byte of the answer, inside the judgement's own timeout (JUDGE_TIMEOUT_MS).
 * Jev answered in at most 0.32 s (Jev report 2.4); no retry. */
export const DECISION_TIMEOUT_MS = 5_000;
/** A key or model failure cools 5 minutes, as a backend's does (v1-plan 第 5 节"决策模型出错时"). */
const COOL_MS = 5 * 60_000;
/** 429 without a usable `retry-after`. */
const BUSY_MS = 60_000;
/** A `retry-after` is kept within these, so a wrong header neither hammers the service nor stops it for hours. */
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 10 * 60_000;
/** Bytes read of a response: an answer is a few hundred, an error body never needs more. */
const BODY_MAX = 64 * 1024;

/** What a log line may carry about a failed call: nothing the service echoes back but its error type. */
export interface DecisionErrorInfo {
  status?: number;
  errorType?: string;
  requestId?: string;
  /** the network error's code, such as ENOTFOUND */
  code?: string;
}

/**
 * A decision model's failure, as a backend's {@link JudgeCallError}: the judge falls back by variant, and a structured
 * one (`coolMs` set) cools. The message is always one of ours: never the response body, the request or the key.
 */
export class DecisionError extends JudgeCallError {
  constructor(kind: JudgeErrorKind, message: string, readonly coolMs?: number, readonly info: DecisionErrorInfo = {}) {
    super(kind, message, coolMs !== undefined);
    this.name = 'DecisionError';
  }
}

export interface DecisionReply {
  /** the parsed JSON of a 2xx answer, unchecked */
  body: unknown;
  requestId?: string;
}

/** A header or field the service sets, as a log may keep it. */
const token = (value: unknown, max: number): string | undefined => {
  const kept = typeof value === 'string' ? value.replace(/[^\w.-]/g, '').slice(0, max) : '';
  return kept || undefined;
};

/** At most {@link BODY_MAX} bytes of the body; undefined when it is longer. */
async function readCapped(res: Response): Promise<string | undefined> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    size += value.byteLength;
    if (size > BODY_MAX) {
      reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
}

/** `retry-after` in seconds or as an HTTP date, kept within 1 s and 10 minutes; 1 minute when missing or unreadable. */
export function retryAfterMs(value: string | null, now: number): number {
  const v = value?.trim() ?? '';
  // Date.parse alone takes "1.5" or "-5" as dates
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : / GMT$/.test(v) ? Date.parse(v) - now : NaN;
  return Number.isFinite(ms) ? Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms)) : BUSY_MS;
}

/** A non-2xx answer as a failure (v1-plan 第 5 节"决策模型出错时"). Only `error_type` is read from the body: a 422
 * echoes the fields it refused, group messages included. */
function failure(status: number, text: string | undefined, retryAfter: string | null, now: number, requestId?: string): DecisionError {
  let detail: unknown;
  try { detail = text ? (JSON.parse(text) as { detail?: unknown }).detail : undefined; } catch { /* not JSON: no error type */ }
  const first = (Array.isArray(detail) ? detail[0] : detail) as { error_type?: unknown; type?: unknown; message?: unknown } | undefined;
  const errorType = token(first?.error_type ?? first?.type, 40);
  const info = { status, ...(errorType ? { errorType } : {}), ...(requestId ? { requestId } : {}) };
  if (status === 401) return new DecisionError('auth', 'TypeSafe 不认这个 key', COOL_MS, info);
  if (status === 429) return new DecisionError('busy', 'TypeSafe 限流了', retryAfterMs(retryAfter, now), info);
  // only the prefix: the rest of the message is the model id we sent
  if (status === 400 && errorType === 'api_usage_error' && typeof first?.message === 'string' && first.message.startsWith('Unknown model')) {
    return new DecisionError('model', 'TypeSafe 没有这个模型', COOL_MS, info);
  }
  if (status >= 500) return new DecisionError('network', `TypeSafe 出错了（${status}）`, undefined, info);
  return new DecisionError('failed', `TypeSafe 不收这个请求（${status}${errorType ? ` ${errorType}` : ''}）`, undefined, info);
}

/**
 * One request to Jev. Resolves with the parsed 2xx answer; rejects with a {@link DecisionError}, or with the
 * reason of `signal` once it aborts (the judgement's timeout, the caller, shutdown). Every other error, a header
 * the key cannot go in included, becomes a fixed message: Node's own ones may quote the key or the body.
 */
export async function callTypeSafe(body: unknown, key: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<DecisionReply> {
  if (signal.aborted) throw signal.reason;
  const ctl = new AbortController();
  const timedOut = new Error('decision timeout');
  const timer = setTimeout(() => ctl.abort(timedOut), DECISION_TIMEOUT_MS);
  timer.unref?.();
  const onAbort = (): void => ctl.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  // A fetch that ignores its signal still ends on time.
  const stopped = new Promise<never>((_, reject) => ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true }));
  stopped.catch(() => undefined);
  try {
    const res = await Promise.race([fetchImpl(TYPESAFE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'vonvon-bot' },
      body: JSON.stringify(body),
      // a redirect would send the group messages on to another address
      redirect: 'error',
      signal: ctl.signal,
    }), stopped]);
    const requestId = token(res.headers.get('x-typesafe-request-id'), 64);
    if (!res.ok) {
      const text = await Promise.race([readCapped(res), stopped]).catch(() => undefined);
      throw failure(res.status, text, res.headers.get('retry-after'), now(), requestId);
    }
    const text = await Promise.race([readCapped(res), stopped]);
    let parsed: unknown;
    try { parsed = text === undefined ? undefined : JSON.parse(text); } catch { /* below */ }
    if (parsed === undefined) throw new DecisionError('format', '决策模型没按格式回答', undefined, { status: res.status, ...(requestId ? { requestId } : {}) });
    return { body: parsed, ...(requestId ? { requestId } : {}) };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (ctl.signal.aborted) throw new DecisionError('network', `TypeSafe ${DECISION_TIMEOUT_MS / 1000} 秒没回`);
    if (error instanceof DecisionError) throw error;
    const code = token((error as { cause?: { code?: unknown } } | undefined)?.cause?.code, 30);
    throw new DecisionError('network', `连不上 TypeSafe${code ? `（${code}）` : ''}`, undefined, code ? { code } : {});
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
