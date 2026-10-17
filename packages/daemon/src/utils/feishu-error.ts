/** Feishu OpenAPI error code for "the app lacks a scope this call needs" (same on every endpoint). */
const SCOPE_DENIED_CODE = 99991672;
/** Feishu's rate limits: the platform's code and the send-message API's own, besides HTTP 429. */
export const FEISHU_RATE_LIMIT_CODES: ReadonlySet<number> = new Set([99991400, 230020]);

/** Feishu's error body, as thrown by the SDK (axios `response.data`) or returned with a non-zero code. */
export interface FeishuErrorBody {
  code?: unknown;
  msg?: unknown;
  error?: { permission_violations?: { subject?: unknown }[] };
}

/** A Feishu call rejected because the app lacks a scope. */
export interface ScopeDenial {
  code: number;
  /** Scopes Feishu says would satisfy the call (any one of them); empty when it didn't list them. */
  accepted: string[];
}

/** The body Feishu answered with: a thrown axios error's `response.data`, else the value itself. */
function errorBody(failure: unknown): FeishuErrorBody | undefined {
  if (!failure || typeof failure !== 'object') return undefined;
  const wrapped = (failure as { response?: { data?: unknown } }).response?.data;
  return (wrapped && typeof wrapped === 'object' ? wrapped : failure) as FeishuErrorBody;
}

/**
 * Feishu's own `{code, msg}` from either shape the SDK surfaces, or undefined when the
 * failure carries no Feishu code (a network error, an HTML 502, a plain Error).
 */
export function feishuError(failure: unknown): { code: number; msg?: string } | undefined {
  const body = errorBody(failure);
  if (typeof body?.code !== 'number' || body.code === 0) return undefined;
  return { code: body.code, ...(typeof body.msg === 'string' && body.msg ? { msg: body.msg } : {}) };
}

/**
 * Recognise Feishu's "app lacks a scope" rejection (code 99991672) from either
 * shape the SDK surfaces: a thrown axios error carrying the body in
 * `response.data`, or a resolved body with the non-zero code. The accepted
 * scopes come from `error.permission_violations[].subject`, else from the
 * bracketed list in `msg` ("One of the following scopes is required: [a, b]").
 * Returns undefined for every other failure.
 */
export function scopeDenial(failure: unknown): ScopeDenial | undefined {
  const body = errorBody(failure);
  if (body?.code !== SCOPE_DENIED_CODE) return undefined;
  const isScope = (s: unknown): s is string => typeof s === 'string' && /^[\w.:-]+$/.test(s);
  const violations = body.error?.permission_violations;
  const fromViolations = Array.isArray(violations) ? violations.map((v) => v?.subject).filter(isScope) : [];
  const listed = typeof body.msg === 'string' ? /\[([^\]]*)\]/.exec(body.msg)?.[1] : undefined;
  const fromMsg = listed ? listed.split(',').map((s) => s.trim()).filter(isScope) : [];
  return { code: SCOPE_DENIED_CODE, accepted: fromViolations.length ? fromViolations : fromMsg };
}
