import { inspect } from 'node:util';
import { createLarkChannel, Domain } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/schema';

/** An entry as text: an Error is its name and message alone, because the SDK's request errors hold the headers they sent. */
function logText(entry: unknown): string {
  const text = entry instanceof Error ? `${entry.name}: ${entry.message}` : typeof entry === 'string' ? entry : inspect(entry, { depth: 3, breakLength: Infinity });
  return text.replace(/(Bearer\s+)[^\s'"\\]+/gi, '$1[已隐藏]');
}
const logTexts = (entries: unknown[]): string[] => entries.flatMap(entry => Array.isArray(entry) ? logTexts(entry) : [logText(entry)]);
/**
 * The SDK's default logger, same outputs, minus its secrets: a failed `rawClient.request` logs the whole AxiosError, whose
 * `request._header` and `config.headers` hold `Authorization: Bearer` (dm-agent F7).
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
