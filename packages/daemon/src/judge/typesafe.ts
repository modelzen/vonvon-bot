import { isIP } from 'node:net';
import { JudgeCallError } from '../agent/types';
import { log } from '../core/logger';
import { decisionEndpointProblem, KEY_FAILURE, type SecretTestOutcome } from '@vonvon/protocol';
import type { JudgeErrorKind } from './types';

/** TypeSafe's decision endpoint (Jev report 第 1 节). */
export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
/** Its model list: the key page's 试一次 asks it (product.md 3.1 第 9 条), so no group message goes out. */
export const TYPESAFE_MODELS_URL = 'https://api.typesafe.ai/v1/models';
/** TypeSafe-compatible Jev endpoints. These do not use a chat-completions API. */
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/systemone';
export const VERCEL_URL = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
export const OPENROUTER_MODEL = 'typesafe/jev-1.14';
export const VERCEL_MODEL = 'typesafe-ai/jev';

/** Per-call connection settings. The endpoint is only used by the custom provider; model also selects a probe's model. */
export interface DecisionRequestOptions { endpoint?: string; model?: string }
export type SystemOneProviderId = 'openrouter' | 'vercel' | 'custom';

interface RequestService {
  name: string;
  requestIdHeaders: readonly string[];
  /** TypeSafe's original error handling remains compatible. */
  typesafe?: true;
}
const TYPESAFE: RequestService = { name: 'TypeSafe', requestIdHeaders: ['x-typesafe-request-id'], typesafe: true };
const SYSTEM_ONE = {
  openrouter: { name: 'OpenRouter', url: OPENROUTER_URL, model: OPENROUTER_MODEL, requestIdHeaders: ['x-request-id', 'x-openrouter-request-id', 'x-typesafe-request-id'] },
  vercel: { name: 'Vercel', url: VERCEL_URL, model: VERCEL_MODEL, requestIdHeaders: ['x-ai-gateway-request-id', 'x-vercel-id', 'x-request-id', 'x-typesafe-request-id'] },
  custom: { name: '自定义 Jev', url: undefined, model: 'jev-latest', requestIdHeaders: ['x-request-id', 'x-typesafe-request-id'] },
} satisfies Record<SystemOneProviderId, RequestService & { url: string | undefined; model: string }>;
/** From sending the request to the last byte of the answer, inside the judgement's own timeout (JUDGE_TIMEOUT_MS);
 * past it the call fails as `timeout`. Jev answered in at most 0.32 s (Jev report 2.4). A retry runs inside it. */
export const DECISION_TIMEOUT_MS = 5_000;
/** A connection that failed is tried once more only with this much of the 5 s left: one connection attempt
 * (AUTO_SELECT_ATTEMPT_MS, 1 s) and Jev's answer (s23f2). */
export const RETRY_MIN_MS = 1_500;
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
  /** each connection attempt of Node's happy eyeballs, as code/family (`ETIMEDOUT/v4`): never the address (s23f2) */
  attempts?: string[];
  /** the connection failed once before and was tried again (s23f2) */
  retried?: true;
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
  /** answered on the second try, after a connection that failed (s23f2) */
  retried?: true;
}

/** A header or field the service sets, as a log may keep it. */
const token = (value: unknown, max: number): string | undefined => {
  const kept = typeof value === 'string' ? value.replace(/[^\w.-]/g, '').slice(0, max) : '';
  return kept || undefined;
};

/** What a failed connection says, as Node and undici give it: an error with `code` and `syscall` (and `address`), or
 * Node's happy eyeballs' AggregateError of one such error per address tried. */
type NetFailure = { code?: unknown; syscall?: unknown; address?: unknown; errors?: unknown };
/** Codes of a connection that never opened, so not a byte of the request went out (s23f2). */
const NOT_CONNECTED = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN']);

const netParts = (cause: NetFailure): NetFailure[] => (Array.isArray(cause.errors) ? cause.errors as NetFailure[] : [cause]);

/** fetch's error when it never connected: its cause, or every attempt in it, failed in connect or getaddrinfo with one
 * of {@link NOT_CONNECTED}, or is undici's own connect timeout. A reset or a timeout after that may follow a request
 * the service got, and is not tried again: a second one may be charged twice. */
function neverConnected(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (!cause || typeof cause !== 'object') return false;
  const parts = netParts(cause as NetFailure);
  return parts.length > 0 && parts.every((part) => part?.code === 'UND_ERR_CONNECT_TIMEOUT'
    || (typeof part?.code === 'string' && NOT_CONNECTED.has(part.code) && (part.syscall === 'connect' || part.syscall === 'getaddrinfo')));
}

/** An AggregateError's attempts, at most 8, as `code/v4`. */
function attemptsOf(cause: unknown, safeToken: typeof token = token): string[] | undefined {
  if (!cause || typeof cause !== 'object' || !Array.isArray((cause as NetFailure).errors)) return undefined;
  const attempts = netParts(cause as NetFailure).slice(0, 8).map((part) => {
    const code = safeToken(part?.code, 30) ?? '?';
    const family = typeof part?.address === 'string' ? isIP(part.address) : 0;
    return family ? `${code}/v${family}` : code;
  });
  return attempts.length ? attempts : undefined;
}

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

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const GATEWAY_ERROR_TYPES = new Set([
  'api_usage_error', 'authentication_error', 'authorization_error', 'invalid_api_key', 'invalid_request', 'invalid_request_error',
  'model_not_found', 'unknown_model', 'invalid_model', 'invalid_model_id', 'rate_limit_error', 'rate_limit_exceeded',
  'insufficient_credits', 'insufficient_quota', 'max_tokens_exceeded', 'provider_error', 'upstream_error', 'internal_server_error',
]);

/** A non-2xx answer as a failure (v1-plan 第 5 节"决策模型出错时"). Only a machine error type is retained: error
 * messages and validation details may echo the key, URL and group messages. Gateway errors may wrap it in `error`
 * or put it at the top level instead of TypeSafe's `detail`. */
function failure(status: number, text: string | undefined, retryAfter: string | null, now: number, more: DecisionErrorInfo, service: RequestService, safeToken: typeof token): DecisionError {
  let body: Record<string, unknown> | undefined;
  try { body = text ? asObject(JSON.parse(text)) : undefined; } catch { /* not JSON: no error type */ }
  const detail = body?.detail;
  const first = asObject(Array.isArray(detail) ? detail[0] : detail)
    ?? (service.typesafe ? undefined : asObject(body?.error) ?? body);
  const extractedType = safeToken(first?.error_type ?? first?.type ?? first?.code, 40);
  // A custom server can put arbitrary request text into a field named `type`; only known machine codes leave it.
  const errorType = service.typesafe || (extractedType && GATEWAY_ERROR_TYPES.has(extractedType)) ? extractedType : undefined;
  const info = { status, ...(errorType ? { errorType } : {}), ...more };
  if (status === 401) return new DecisionError('auth', KEY_FAILURE.rejected(service.name), COOL_MS, info);
  if (status === 429) return new DecisionError('busy', `${service.name} 限流了`, retryAfterMs(retryAfter, now), info);
  // only the prefix: the rest of the message is the model id we sent
  const unknownModel = status === 400 && errorType === 'api_usage_error' && typeof first?.message === 'string' && first.message.startsWith('Unknown model');
  const gatewayModel = !service.typesafe && (status === 400 || status === 404)
    && (['model_not_found', 'unknown_model', 'invalid_model', 'invalid_model_id'].includes(errorType ?? '')
      || (typeof first?.message === 'string' && /^(Unknown model|No endpoints found for )|is not a valid model ID/i.test(first.message)));
  if (unknownModel || gatewayModel) {
    return new DecisionError('model', `${service.name} 没有这个模型`, COOL_MS, info);
  }
  if (status >= 500) return new DecisionError('network', `${service.name} 出错了（${status}）`, undefined, info);
  return new DecisionError('failed', `${service.name} 不收这个请求（${status}${errorType ? ` ${errorType}` : ''}）`, undefined, info);
}

/**
 * One request to Jev. Resolves with the parsed 2xx answer; rejects with a {@link DecisionError}, or with the
 * reason of `signal` once it aborts (the judgement's timeout, the caller, shutdown). Every other error, a header
 * the key cannot go in included, becomes a fixed message: Node's own ones may quote the key or the body.
 */
export function callTypeSafe(body: unknown, key: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<DecisionReply> {
  return request(TYPESAFE_URL, body, key, signal, fetchImpl, now);
}

/** Calls only the TypeSafe-compatible System One API, using the same request budget as the original provider. */
export async function callSystemOne(provider: SystemOneProviderId, body: { model: string }, key: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch, options: DecisionRequestOptions = {}): Promise<DecisionReply> {
  if (signal.aborted) throw signal.reason;
  const service = SYSTEM_ONE[provider];
  let url = service.url;
  if (provider === 'custom') {
    const problem = decisionEndpointProblem(typeof options.endpoint === 'string' ? options.endpoint : undefined);
    if (problem) throw new DecisionError('failed', `自定义 Jev 请求地址不可用：${problem}`);
    url = options.endpoint!.trim();
  }
  return request(url!, options.model === undefined ? body : { ...body, model: options.model }, key, signal, fetchImpl, Date.now, service);
}

/** What 试一次 found (s23g), by the judgement's failure kinds: a 2xx is `ok`; `model` and `format` are `failed`. */
export interface ProbeResult { outcome: SecretTestOutcome; message: string; status?: number }

/** Asks the model list with `key`, as callTypeSafe asks Jev: the same timeout, redirect rule and error words. */
export async function probeTypeSafe(key: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    await request(TYPESAFE_MODELS_URL, undefined, key, signal, fetchImpl, Date.now);
    return { outcome: 'ok', message: '能用' };
  } catch (error) {
    if (!(error instanceof DecisionError)) throw error;
    const status = error.info.status ? { status: error.info.status } : {};
    if (error.kind === 'auth') return { outcome: 'auth', message: `key 不对：${error.message}`, ...status };
    if (error.kind === 'busy') return { outcome: 'busy', message: '连上了，但 TypeSafe 限流了，稍后再试', ...status };
    if (error.kind === 'network' || error.kind === 'timeout') return { outcome: error.kind, message: error.message, ...status };
    return { outcome: 'failed', message: error.kind === 'format' ? 'TypeSafe 回的内容读不懂' : error.message, ...status };
  }
}

/** Only invented test data leaves this function. A successful JSON response alone is not proof of a working model. */
export async function probeSystemOne(provider: SystemOneProviderId, key: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch, options: DecisionRequestOptions = {}): Promise<ProbeResult> {
  const service = SYSTEM_ONE[provider];
  const body = {
    model: options.model ?? service.model,
    state: { message: '这是虚构的连接测试：苹果是一种水果。' },
    questions: {
      decision: {
        type: 'choice', instructions: '根据测试陈述，苹果属于哪一类？',
        criteria: { fruit: '水果', other: '其他类别' },
      },
    },
  };
  try {
    const reply = await callSystemOne(provider, body, key, signal, fetchImpl, options);
    const answer = asObject(asObject(asObject(reply.body)?.answers)?.decision);
    const probabilities = asObject(answer?.probabilities);
    const share = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    if (answer?.type !== 'choice' || typeof answer.choice !== 'string' || !['fruit', 'other'].includes(answer.choice)
      || !probabilities || Object.keys(probabilities).length !== 2
      || !share(probabilities.fruit) || !share(probabilities.other)
      || Math.abs(probabilities.fruit + probabilities.other - 1) > 0.02
      || (answer.confidence !== undefined && !share(answer.confidence))) {
      return { outcome: 'failed', message: `${service.name} 回的内容读不懂` };
    }
    return { outcome: 'ok', message: '能用' };
  } catch (error) {
    if (!(error instanceof DecisionError)) throw error;
    const status = error.info.status ? { status: error.info.status } : {};
    if (error.kind === 'auth') return { outcome: 'auth', message: `key 不对：${error.message}`, ...status };
    if (error.kind === 'busy') return { outcome: 'busy', message: `连上了，但 ${service.name} 限流了，稍后再试`, ...status };
    if (error.kind === 'network' || error.kind === 'timeout') return { outcome: error.kind, message: error.message, ...status };
    return { outcome: 'failed', message: error.kind === 'format' ? `${service.name} 回的内容读不懂` : error.message, ...status };
  }
}

/** A GET without a body, else a POST of its JSON. */
async function request(url: string, body: unknown, key: string, signal: AbortSignal, fetchImpl: typeof fetch, now: () => number, service: RequestService = TYPESAFE): Promise<DecisionReply> {
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
  const started = now();
  let retried = false;
  let sentText: string | undefined;
  const inputStrings: string[] = [];
  const again = (): DecisionErrorInfo => (retried ? { retried: true } : {});
  const echoesSecret = (value: string): boolean => {
    const normalized = value.replace(/[^\w.-]/g, '');
    return [key, url].some((secret) => {
      const cleaned = secret.replace(/[^\w.-]/g, '');
      return secret && (value.includes(secret) || (cleaned && normalized.includes(cleaned)));
    });
  };
  // Defensive even if a gateway puts a credential or custom address into a metadata field.
  const safeToken: typeof token = (value, max) => {
    const kept = token(value, max);
    if (!kept || typeof value !== 'string' || sentText?.includes(value)) return undefined;
    return echoesSecret(value) ? undefined : kept;
  };
  try {
    const post = body !== undefined;
    sentText = post ? JSON.stringify(body) : undefined;
    // The selected model itself may legitimately be echoed. Protect the request's other strings separately so a
    // success response cannot smuggle message/rule text into the version metadata that readDecision later logs.
    const collect = (value: unknown): void => {
      if (typeof value === 'string') inputStrings.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    const sent = sentText ? asObject(JSON.parse(sentText)) : undefined;
    for (const [name, value] of Object.entries(sent ?? {})) if (name !== 'model') collect(value);
    const send = (): Promise<Response> => Promise.race([fetchImpl(url, {
      method: post ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, ...(post ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json', 'User-Agent': 'vonvon-bot' },
      ...(post ? { body: sentText } : {}),
      // a redirect would send the key and the group messages on to another address
      redirect: 'error',
      signal: ctl.signal,
    }), stopped]);
    let res: Response;
    try {
      res = await send();
    } catch (error) {
      // once, within the same 5 s, and only when nothing was sent (s23f2)
      const left = DECISION_TIMEOUT_MS - (now() - started);
      if (ctl.signal.aborted || !neverConnected(error) || left < RETRY_MIN_MS) throw error;
      const cause = (error as { cause?: NetFailure }).cause!;
      const attempts = attemptsOf(cause, safeToken);
      log.info('judge', 'decision-retry', { call: post ? 'decision' : 'probe', code: safeToken(cause.code, 30), ...(attempts ? { attempts } : {}), ms: now() - started });
      retried = true;
      res = await send();
    }
    const requestId = service.requestIdHeaders.map((name) => safeToken(res.headers.get(name), 64)).find(Boolean);
    if (!res.ok) {
      const text = await Promise.race([readCapped(res), stopped]).catch(() => undefined);
      throw failure(res.status, text, res.headers.get('retry-after'), now(), { ...(requestId ? { requestId } : {}), ...again() }, service, safeToken);
    }
    const text = await Promise.race([readCapped(res), stopped]);
    let parsed: unknown;
    try { parsed = text === undefined ? undefined : JSON.parse(text); } catch { /* below */ }
    if (parsed === undefined) throw new DecisionError('format', service.typesafe ? '决策模型没按格式回答' : `${service.name} 没按格式回答`, undefined, { status: res.status, ...(requestId ? { requestId } : {}), ...again() });
    const response = asObject(parsed);
    if (typeof response?.model === 'string') {
      const model = response.model;
      const normalized = model.replace(/[^\w.-]/g, '');
      const echoesInput = inputStrings.some((value) => {
        const cleaned = value.replace(/[^\w.-]/g, '');
        return model === value || (cleaned && (normalized === cleaned || (cleaned.length >= 4 && normalized.includes(cleaned))));
      });
      if (echoesSecret(model) || echoesInput) delete response.model;
    }
    return { body: parsed, ...(requestId ? { requestId } : {}), ...(retried ? { retried: true as const } : {}) };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    // a status already in hand says more than the 5 s its error body ran past: a 401 still cools
    if (error instanceof DecisionError) throw error;
    // `timeout`, not `network`: it neither cools nor falls back differently, but counts apart (review)
    if (ctl.signal.aborted) throw new DecisionError('timeout', `${service.name} ${DECISION_TIMEOUT_MS / 1000} 秒没回`, undefined, again());
    // fetch puts the code on the cause; a body stream that breaks halfway, on the error itself
    const failed = error as { code?: unknown; cause?: NetFailure } | undefined;
    const code = safeToken(failed?.cause?.code ?? failed?.code, 30);
    const attempts = attemptsOf(failed?.cause, safeToken);
    throw new DecisionError('network', `连不上 ${service.name}${code ? `（${code}）` : ''}`, undefined, { ...(code ? { code } : {}), ...(attempts ? { attempts } : {}), ...again() });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
