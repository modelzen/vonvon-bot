import { inspect } from 'node:util';
import { createLarkChannel, Domain } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/schema';

/** What a request carried: the SDK logs a refused call's `config.data`, `params` and `request` (its `formatErrors`), with
 * the recipient, the body and an image's bytes in them (Codex review 376). Feishu's answer stays: it logs that again apart. */
const SENT = new Set(['data', 'params', 'headers', 'body', 'request']);
/** `value` without what was sent, bytes or streams: the status, Feishu's code, msg and log_id stay. */
function scrubbed(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[${value.byteLength} 字节]`;
  if (!value || typeof value !== 'object') return value;
  if (typeof (value as { pipe?: unknown }).pipe === 'function') return '[数据流]';
  if (depth > 3) return '[…]';
  if (Array.isArray(value)) return value.map(item => scrubbed(item, depth + 1));
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SENT.has(key)).map(([key, item]) => [key, scrubbed(item, depth + 1)]));
}
/** An entry as text: an Error is its name and message alone, because the SDK's request errors hold the headers they sent;
 * no one's open id or union id. */
function logText(entry: unknown): string {
  const text = entry instanceof Error ? `${entry.name}: ${entry.message}` : typeof entry === 'string' ? entry : inspect(scrubbed(entry), { depth: 3, breakLength: Infinity });
  return text.replace(/(Bearer\s+)[^\s'"\\]+/gi, '$1[已隐藏]').replace(/\b(o[un])_[\w-]+/g, '$1_…');
}
const logTexts = (entries: unknown[]): string[] => entries.flatMap(entry => Array.isArray(entry) ? logTexts(entry) : [logText(entry)]);
/**
 * The SDK's default logger, same outputs, minus its secrets: a failed `rawClient.request` logs the whole AxiosError, whose
 * `request._header` and `config.headers` hold `Authorization: Bearer` (dm-agent F7); every other call, what it sent.
 */
export const sdkLogger = {
  error: (...entries: unknown[]) => console.log('[error]:', ...logTexts(entries)),
  warn: (...entries: unknown[]) => console.warn('[warn]:', ...logTexts(entries)),
  info: (...entries: unknown[]) => console.info('[info]:', ...logTexts(entries)),
  debug: (...entries: unknown[]) => console.debug('[debug]:', ...logTexts(entries)),
  trace: (...entries: unknown[]) => console.trace('[trace]:', ...logTexts(entries)),
};

/** Shared receive boundary: project policy is enforced by the orchestrator. */
export function createBridgeChannel(app: AppConfig['accounts']['app'], appSecret: string) {
  return createLarkChannel({
    appId: app.id,
    appSecret: appSecret,
    domain: app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'feishu-codex-bridge',
    logger: sdkLogger,
    // surface raw events so card-action handlers can read form submissions
    // (action.form_value) — used by the new-project form.
    includeRawEvent: true,
    // Deliver ALL group messages (not just @bot) to `onMessage`. The SDK's
    // PolicyGate otherwise drops non-@ group messages with reason 'no_mention'
    // before they reach us, which would make 免@ impossible. We turn the SDK
    // filter off and let our per-project gate (shouldRespondWithoutMention in
    // handle-message) be the single source of truth for 免@. Non-@ delivery
    // still requires the im:message.group_msg scope (Feishu-side push).
    // @all must also reach that gate; the SDK blocks it by default.
    policy: { requireMention: false, respondToMentionAll: true },
    // Disable the SDK's 600ms per-chat text batching. It merges messages by
    // chatId, so two topics in the same group posting within 600ms get their
    // content concatenated and senderId taken from the last message — breaking
    // "topic = independent session" and misattributing permissions. delayMs: 0
    // takes the SDK's pure-serial branch (dedup + chat queue stay on); double
    // sends are already prevented by startReservedRun's synchronous booking.
    safety: { batch: { text: { delayMs: 0 } } },
  });
}
