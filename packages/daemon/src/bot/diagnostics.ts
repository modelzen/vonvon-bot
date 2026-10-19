import {
  DENIED_SCOPE_SHOWN_MS, diagnosticsEventSchema,
  type BotDiagnostics, type DeniedScope, type DiagnosticsEvent, type NotReplied, type NotRepliedReason, type ScopeDenialPlace,
} from '@vonvon/protocol';
import { CHAT_OPTIONAL_SCOPES, REQUIRED_SCOPES } from '../config/scopes';

/**
 * The 状态与诊断 page's not-replied messages and runtime scope denials (product.md 3.1 item 8).
 * A bot child reports them through one sink, installed by `daemon run`: an IPC message to the
 * supervisor, or this process's own store when one bot runs alone. Nothing is written to disk.
 */
export type { DiagnosticsEvent };

let sink: ((event: DiagnosticsEvent) => void) | undefined;
/** Where this process's events go; unset (tests, other entry points) drops them. */
export function setDiagnosticsSink(next: ((event: DiagnosticsEvent) => void) | undefined): void { sink = next; }
/** Checked here too, so a single bot's own store gets the same bounded records as the supervisor. */
function report(event: DiagnosticsEvent): void {
  const parsed = diagnosticsEventSchema.safeParse(event);
  try { if (parsed.success) sink?.(parsed.data); } catch { /* the page is best-effort; a turn never fails for it */ }
}
/** `times` > 1: one record for that many messages (a group's dropped queue, s18c). */
export function reportNotReplied(record: Omit<NotReplied, 'count'>, times = 1): void { report({ kind: 'notReplied', record, ...(times > 1 ? { times } : {}) }); }
/** Only scopes the console check reads reach 缺的权限, which may call one 后台显示已开; Feishu's list of scopes that
 * would do can start with an alias (`im:message`), so the name is the first the check reads, else the first. */
const CHECKED_SCOPES: ReadonlySet<string> = new Set([...REQUIRED_SCOPES, ...CHAT_OPTIONAL_SCOPES]);
export const deniedScopeName = (accepted: readonly string[]): string | undefined => accepted.find(scope => CHECKED_SCOPES.has(scope)) ?? accepted[0];
export function reportScopeDenied(scope: string, where: ScopeDenialPlace, at = Date.now()): void {
  if (CHECKED_SCOPES.has(scope)) report({ kind: 'scopeDenied', denial: { scope, where, at } });
}
/** A supervised child's sink: one IPC message per event, send errors ignored like fcb.connection. */
export function ipcDiagnosticsSink(send: (message: unknown, callback: (error: Error | null) => void) => void): (event: DiagnosticsEvent) => void {
  return event => send({ fcb: 'fcb.diagnostics', event }, () => undefined);
}
/** A child's IPC message, or undefined when it is not one (or fails the schema). */
export function parseDiagnosticsIpc(message: unknown): DiagnosticsEvent | undefined {
  if (!message || typeof message !== 'object' || (message as { fcb?: unknown }).fcb !== 'fcb.diagnostics') return undefined;
  const parsed = diagnosticsEventSchema.safeParse((message as { event?: unknown }).event);
  return parsed.success ? parsed.data : undefined;
}

/** Cut to the record's 120 UTF-16 units, which its schema counts, without splitting a character: a judge's
 * 80-character reason in emoji is 160 (s25). */
export function fitDetail(text: string | undefined): string | undefined {
  if (!text || text.length <= 120) return text;
  let out = '';
  for (const char of text) {
    if (out.length + char.length > 120) break;
    out += char;
  }
  return out;
}

/** An error's first line without control characters, cut to the record's 120. */
export function errorDetail(error: unknown): string | undefined {
  const text = (error instanceof Error ? error.message : String(error ?? '')).split('\n')[0]!.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return text ? text.slice(0, 120) : undefined;
}

export const NOT_REPLIED_LIMIT = 30;
const DENIED_SCOPE_LIMIT = 10;
const MERGE_MS = 10 * 60_000;
/** Of the 30, the most kept for the smart mode's normal outcomes (s25), another bot's @ past the cap or dropped by
 * a setting included (s27a-0): a busy group's quiet records do not push out the failures the page is for. */
export const QUIET_LIMIT = 10;
const QUIET_REASONS: ReadonlySet<NotRepliedReason> = new Set([
  'judge-skip', 'judge-superseded', 'judge-empty', 'bot-wake-cap', 'bot-wake-not-allowed', 'bot-wake-dropped',
]);

export interface DiagnosticsStore {
  accept(appId: string, event: DiagnosticsEvent): void;
  /** A bot's records for the snapshot; undefined when it has none. */
  view(appId: string): BotDiagnostics | undefined;
  /** Drops the records of bots no longer registered. */
  retain(appIds: ReadonlySet<string>): void;
  close(): void;
}

/** The supervisor's memory, per bot: 30 records newest first, at most 10 of them judgements that did not
 * answer, the same group, place, reason and backend within 10 minutes merged into a count; each scope's latest denial, 10 at most. `changed` fires at most
 * once a second. A Claude turn that failed for its login tells `claudeSignedOut`. */
export function createDiagnosticsStore(opts: { changed: () => void; claudeSignedOut?: (at: number) => void; now?: () => number; throttleMs?: number }): DiagnosticsStore {
  const now = opts.now ?? Date.now;
  const bots = new Map<string, { notReplied: NotReplied[]; deniedScopes: DeniedScope[] }>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const changed = (): void => {
    if (timer || closed) return;
    timer = setTimeout(() => { timer = undefined; opts.changed(); }, opts.throttleMs ?? 1000);
    timer.unref?.();
  };
  return {
    accept(appId, event) {
      const bot = bots.get(appId) ?? { notReplied: [], deniedScopes: [] };
      bots.set(appId, bot);
      if (event.kind === 'scopeDenied') {
        bot.deniedScopes = [event.denial, ...bot.deniedScopes.filter(item => item.scope !== event.denial.scope)].slice(0, DENIED_SCOPE_LIMIT);
      } else {
        const record = event.record;
        // Any matching record, moved to the front; always a new array, or the snapshot's deep compare sees no change.
        const same = bot.notReplied.find(item => item.groupId === record.groupId && item.place === record.place
          && item.reason === record.reason && item.backend === record.backend && Math.abs(record.at - item.at) < MERGE_MS);
        let quiet = 0;
        bot.notReplied = [{ ...record, count: (same?.count ?? 0) + (event.times ?? 1) }, ...bot.notReplied.filter(item => item !== same)]
          .filter(item => !QUIET_REASONS.has(item.reason) || ++quiet <= QUIET_LIMIT).slice(0, NOT_REPLIED_LIMIT);
        // Stamped now: a queued turn can fail long after its message was sent.
        if (record.reason === 'signed-out' && record.backend === 'claude') opts.claudeSignedOut?.(now());
      }
      changed();
    },
    view(appId) {
      const bot = bots.get(appId);
      if (!bot) return undefined;
      const deniedScopes = bot.deniedScopes.filter(item => now() - item.at < DENIED_SCOPE_SHOWN_MS);
      return bot.notReplied.length || deniedScopes.length ? { notReplied: bot.notReplied, deniedScopes } : undefined;
    },
    retain(appIds) { for (const appId of bots.keys()) if (!appIds.has(appId)) bots.delete(appId); },
    close() { closed = true; if (timer) clearTimeout(timer); timer = undefined; },
  };
}
