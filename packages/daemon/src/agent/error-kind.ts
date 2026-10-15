import type { CodexErrorInfo } from './codex-appserver/protocol/generated/v2/CodexErrorInfo';

/**
 * Why a turn failed, as far as the run card needs to know. `network` covers
 * "couldn't reach the model or it is temporarily down" (connection, stream cut,
 * overloaded, 5xx), which is what the [重试] button is for (product.md 3.12).
 */
export type AgentErrorKind = 'network' | 'auth' | 'quota';

/** From the structured `codexErrorInfo` on a Codex `error` notification. */
export function codexErrorKind(info: CodexErrorInfo | null | undefined): AgentErrorKind | undefined {
  if (!info) return undefined;
  if (typeof info === 'object') {
    const connectionFailed = 'httpConnectionFailed' in info || 'responseStreamConnectionFailed' in info
      || 'responseStreamDisconnected' in info || 'responseTooManyFailedAttempts' in info;
    return connectionFailed ? 'network' : undefined;
  }
  switch (info) {
    case 'serverOverloaded':
    case 'internalServerError':
      return 'network';
    case 'usageLimitExceeded':
      return 'quota';
    case 'unauthorized':
      return 'auth';
    default:
      return undefined;
  }
}

/** From the Claude Agent SDK's `SDKAssistantMessageError` code. */
export function claudeErrorKind(code: unknown): AgentErrorKind | undefined {
  switch (code) {
    case 'overloaded':
    case 'server_error':
      return 'network';
    case 'rate_limit':
    case 'billing_error':
      return 'quota';
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'cloud_credential_error':
      return 'auth';
    default:
      return undefined;
  }
}

/** Fallback by message text, for errors that carry no structured code. */
export function errorKindFromText(message: string): AgentErrorKind | undefined {
  if (/401|unauthor|not.?logged.?in|login|credential|token.*(expired|invalid)/i.test(message)) return 'auth';
  if (/usage.?limit|quota|rate.?limit|429|too many requests/i.test(message)) return 'quota';
  if (/network|timed?.?out|econn|epipe|enotfound|eai_again|socket|fetch failed|disconnect|connection (error|refused|reset|closed)|overloaded|service unavailable|bad gateway|internal server error/i.test(message)) {
    return 'network';
  }
  return undefined;
}
