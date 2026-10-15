import {
  DENIED_SCOPE_SHOWN_MS, diagnosticsEventSchema,
  type BotDiagnostics, type DeniedScope, type DiagnosticsEvent, type NotReplied, type ScopeDenialPlace,
} from '@vonvon/protocol';

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
export function reportNotReplied(record: Omit<NotReplied, 'count'>): void { report({ kind: 'notReplied', record }); }
export function reportScopeDenied(scope: string, where: ScopeDenialPlace, at = Date.now()): void {
  report({ kind: 'scopeDenied', denial: { scope, where, at } });
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

/** An error's first line without control characters, cut to the record's 120. */
export function errorDetail(error: unknown): string | undefined {
  const text = (error instanceof Error ? error.message : String(error ?? '')).split('\n')[0]!.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return text ? text.slice(0, 120) : undefined;
}

export const NOT_REPLIED_LIMIT = 30;
const DENIED_SCOPE_LIMIT = 10;
const MERGE_MS = 10 * 60_000;

export interface DiagnosticsStore {
  accept(appId: string, event: DiagnosticsEvent): void;
  /** A bot's records for the snapshot; undefined when it has none. */
  view(appId: string): BotDiagnostics | undefined;
  /** Drops the records of bots no longer registered. */
  retain(appIds: ReadonlySet<string>): void;
  close(): void;
}

/** The supervisor's memory, per bot: 30 records newest first, the same group, place, reason and backend
 * within 10 minutes merged into a count; each scope's latest denial, 10 at most. `changed` fires at most
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
        const last = bot.notReplied[0];
        if (last && last.groupId === record.groupId && last.place === record.place && last.reason === record.reason
          && last.backend === record.backend && Math.abs(record.at - last.at) < MERGE_MS) {
          bot.notReplied[0] = { ...record, count: last.count + 1 };
        } else bot.notReplied = [{ ...record, count: 1 }, ...bot.notReplied].slice(0, NOT_REPLIED_LIMIT);
        if (record.reason === 'signed-out' && record.backend === 'claude') opts.claudeSignedOut?.(record.at);
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
