import type { CodexErrorInfo } from './codex-appserver/protocol/generated/v2/CodexErrorInfo';

/**
 * Why a turn failed, as far as the run card needs to know. `network` covers
 * "couldn't reach the model or it is temporarily down" (connection, stream cut,
 * overloaded, 5xx), which is what the [重试] button is for (product.md 3.12).
 * `version`: the server refuses this Codex for the model (s19).
 */
export type AgentErrorKind = 'network' | 'auth' | 'quota' | 'version';

/**
 * Why a smart-mode judgement (s23) fell back to its default decision. The judge layer (`src/judge/`)
 * re-exports it; it lives here so `src/judge/` depends on `src/agent/` and never the other way.
 * `aborted`: the caller gave up; `closed`: the bot is shutting down; `busy`: the queue was full;
 * `format`: the model did not answer in the format; `prompt`: SMART.md could not be read; `key`: a decision
 * model's key is not filled in (or not a key), so nothing was sent (s23f).
 */
export type JudgeErrorKind =
  | 'timeout' | 'aborted' | 'closed' | 'busy' | 'unavailable'
  | 'auth' | 'quota' | 'version' | 'model' | 'network'
  | 'format' | 'prompt' | 'key' | 'failed';

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
  // The server lets a model run only on a new enough Codex (e05); before `auth`, whose `login` would match the hint.
  if (/requires a newer version of codex/i.test(message)) return 'version';
  if (/401|unauthor|not.?logged.?in|login|credential|token.*(expired|invalid)/i.test(message)) return 'auth';
  if (/usage.?limit|quota|rate.?limit|429|too many requests/i.test(message)) return 'quota';
  if (/network|timed?.?out|econn|epipe|enotfound|eai_again|socket|fetch failed|disconnect|connection (error|refused|reset|closed)|overloaded|service unavailable|bad gateway|internal server error/i.test(message)) {
    return 'network';
  }
  return undefined;
}
