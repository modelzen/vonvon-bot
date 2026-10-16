// The crash messages to a bot's owner (product.md 3.10, s18b). The host sends them itself with the bot's app identity over
// Feishu's HTTP API, not through a bot's long connection, so they go out while the bots are down or paused.
import { randomUUID } from 'node:crypto';
import { crashText, type CrashEntry } from '@vonvon/protocol';
import { FEISHU_API_BASES } from '../admin/avatar';
import type { BotEntry } from '../config/bots';
import { botPaths } from '../config/paths';
import { isComplete, resolveOwner, type TenantBrand } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { loadConfig } from '../config/store';
import type { CrashLog } from './crash-guard';
import { CRASH_WINDOW_MS, readNotices, startedBeforeThisBoot, systemClock, writeNoticesSync, type Clock, type NoticeStamp } from './crash-store';

/** What the host's start knows of the run before it (bootstrap, from `openHostRun`). */
export type HostNotice = { previous?: CrashEntry; crashes: number; resumed: boolean; pauseEntered: boolean };
export type Sender = { appId: string; tenant: TenantBrand; appSecret: string; openId: string };
type BotEvent = { kind: 'bot-recovered' | 'bot-paused'; appId: string; name: string; crashes: number; reason: string };
export type NoticeEvent = { kind: 'host-recovered' | 'host-paused'; crashes: number; reason?: string; bots: string[] } | BotEvent;
export type SendResult = { ok: true } | { ok: false; retry: boolean; status?: number; code?: number; msg?: string };
/** A sender, or why this bot cannot send (no complete config, no owner, no secret). */
export type LoadSender = (appId: string) => Promise<Sender | string>;

export interface CrashNotifier {
  /** Whole host: "已自动恢复" after 30 s up, or "已停止自动重启" at once in the start that paused it. */
  hostStarted(notice: HostNotice | undefined, ctx: { bots: readonly BotEntry[]; paused: boolean; botPaused: (appId: string) => boolean }): void;
  /** A child of this bot is up: with a crash waiting to be told, its 30 s start now. */
  botStarted(appId: string): void;
  /** Its child ended: the 30 s are void, the crash waits for the next child. */
  botExited(appId: string): void;
  /** A crash that did not pause the bot: told once a child of it has stayed up 30 s, replacing an untold one. */
  botCrashed(appId: string, name: string, crashes: number, reason: string): void;
  /** The crash that paused the bot: told at once, outside the limit, and nothing older of it is told after. */
  botPaused(appId: string, name: string, crashes: number, reason: string): void;
  /** 恢复运行 or a disable: whatever of this bot is untold or waiting to be tried again is dropped. */
  botForget(appId: string): void;
  /** First thing in the supervisor's shutdown: timers stop, ordinary messages are cut; a pause message in flight or queued
   * is waited for, at most 10 s. Never rejects; calls after it do nothing. */
  close(): Promise<void>;
}

export const NOTICE_STABLE_MS = 30_000;
export const NOTICE_RETRY_MS: readonly number[] = [60_000, 300_000];
const STEP_TIMEOUT_MS = 10_000;
const CLOSE_WAIT_MS = 10_000;
/** Feishu's rate limits: the platform's code and the send-message API's own, besides HTTP 429. */
const RATE_LIMITED = new Set([99991400, 230020]);
const HOST = '#host';

/** The name the pages show. */
export const botLabel = (bot: Pick<BotEntry, 'name' | 'botName'>): string => bot.botName || bot.name;
const sentence = (text: string): string => (/[。！？.!?]$/.test(text) ? text : `${text}。`);
const because = (label: string, reason: string | undefined): string => (reason ? `${label}：${sentence(reason)}` : '');

/** One line each (3.10): no stack and no local path; the reason is a record's `crashText`, already sanitized. */
export function noticeText(event: NoticeEvent): string {
  const several = event.crashes > 1;
  const why = because(several ? '最近一次的原因' : '原因', event.reason);
  switch (event.kind) {
    case 'host-recovered':
      return `${several ? `daemon 10 分钟内崩溃了 ${event.crashes} 次` : 'daemon 刚才崩溃过一次'}，已自动恢复。`
        + `${event.bots.length ? `受影响的 bot：${event.bots.join('、')}。` : ''}${why}`;
    case 'host-paused':
      return `daemon 10 分钟内崩溃了 ${event.crashes} 次，已停止自动重启，bot 都没有启动${event.bots.length ? `：${event.bots.join('、')}` : ''}。`
        + `${because('最近一次的原因', event.reason)}查完原因后在状态与诊断页点「恢复运行」，或运行 vonvon daemon restart。`;
    case 'bot-recovered':
      return `「${event.name}」${several ? `10 分钟内崩溃了 ${event.crashes} 次` : '刚才崩溃过一次'}，已自动恢复。${why}`;
    case 'bot-paused':
      return `「${event.name}」10 分钟内崩溃了 ${event.crashes} 次，已停止自动重启，别的 bot 照常。${because('最近一次的原因', event.reason)}查完原因后在状态与诊断页点「恢复运行」。`;
  }
}

/** The bot's own config, read at each send (no secret kept in memory). */
export async function loadOwnerSender(appId: string): Promise<Sender | string> {
  let cfg: Awaited<ReturnType<typeof loadConfig>>;
  try { cfg = await loadConfig(botPaths(appId).configFile); } catch { return 'config-unreadable'; }
  if (!isComplete(cfg)) return 'config-incomplete';
  const openId = resolveOwner(cfg);
  if (!openId) return 'no-owner';
  try { return { appId, tenant: cfg.accounts.app.tenant, appSecret: await resolveAppSecret(cfg), openId }; }
  catch { return 'secret-unreadable'; }
}

type Reply = { status: number; code?: number; msg?: string; token?: string };
async function post(fetchImpl: typeof fetch, url: string, body: unknown, signal: AbortSignal, token?: string): Promise<Reply> {
  const response = await fetchImpl(url, {
    method: 'POST', redirect: 'error', signal, body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  let value: unknown;
  try { value = await response.json(); } catch { value = undefined; }
  const fields = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return {
    status: response.status,
    ...(typeof fields.code === 'number' ? { code: fields.code } : {}),
    ...(typeof fields.msg === 'string' && fields.msg ? { msg: fields.msg.slice(0, 200) } : {}),
    ...(typeof fields.tenant_access_token === 'string' && fields.tenant_access_token ? { token: fields.tenant_access_token } : {}),
  };
}
/** Undefined when Feishu took it. A network error, 5xx, 429 or a rate limit is tried again; any other refusal is not. */
function refused(reply: Reply): SendResult | undefined {
  const detail = { status: reply.status, ...(reply.code !== undefined ? { code: reply.code } : {}), ...(reply.msg ? { msg: reply.msg } : {}) };
  if (reply.status >= 500 || reply.status === 429 || (reply.code !== undefined && RATE_LIMITED.has(reply.code))) return { ok: false, retry: true, ...detail };
  if (reply.status < 200 || reply.status >= 300 || reply.code !== 0) return { ok: false, retry: false, ...detail };
  return undefined;
}

/** A tenant token for the bot's app, then a text message to its owner's open_id. `uuid` makes a resend of the same
 * message a no-op on Feishu's side (verified 2026-10-16: the same uuid returns the same message_id). */
export async function sendOwnerText(sender: Sender, text: string, uuid: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const base = FEISHU_API_BASES[sender.tenant];
  const step = (): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(STEP_TIMEOUT_MS)]);
  try {
    const auth = await post(fetchImpl, `${base}/open-apis/auth/v3/tenant_access_token/internal`, { app_id: sender.appId, app_secret: sender.appSecret }, step());
    const authRefused = refused(auth);
    if (authRefused) return authRefused;
    if (!auth.token) return { ok: false, retry: false, status: auth.status, msg: 'no tenant_access_token' };
    const sent = await post(fetchImpl, `${base}/open-apis/im/v1/messages?receive_id_type=open_id`,
      { receive_id: sender.openId, msg_type: 'text', content: JSON.stringify({ text }), uuid }, step(), auth.token);
    return refused(sent) ?? { ok: true };
  } catch (error) {
    return { ok: false, retry: true, msg: (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 200) };
  }
}

type Job = { event: NoticeEvent; uuid: string; attempt: number; scope: string; gen: number; exempt: boolean; candidates: readonly string[] };

export function createCrashNotifier(deps: {
  root: string; log: CrashLog; clock?: Clock; fetchImpl?: typeof fetch; loadSender?: LoadSender;
  stableMs?: number; retryMs?: readonly number[]; closeWaitMs?: number;
}): CrashNotifier {
  const { root, log } = deps;
  const clock = deps.clock ?? systemClock;
  // Looked up at each send, so a fetch replaced after this was made (a test preload) is the one used.
  const fetchImpl: typeof fetch = (input, init) => (deps.fetchImpl ?? globalThis.fetch)(input, init);
  const loadSender = deps.loadSender ?? loadOwnerSender;
  const stableMs = deps.stableMs ?? NOTICE_STABLE_MS;
  const retryMs = deps.retryMs ?? NOTICE_RETRY_MS;
  const last = new Map<string, NoticeStamp>(Object.entries(readNotices(root, () => log.warn('crash-notify', 'notices-corrupt', {}))));
  let closed = false;
  let closing: Promise<void> | undefined;
  let queue: Promise<void> = Promise.resolve();
  const closeCut = new AbortController();
  const finalCut = new AbortController();
  const waiting = new Map<string, BotEvent>();
  const stable = new Map<string, NodeJS.Timeout>();
  const retries = new Map<NodeJS.Timeout, string>();
  const gens = new Map<string, number>();
  const gen = (scope: string): number => gens.get(scope) ?? 0;

  const guard = (phase: string, step: () => void): void => {
    try { step(); } catch (error) { log.fail('crash-notify', error, { phase }); }
  };
  /** One a bot per 10 minutes of this boot, counted from the last message that got through. */
  const limited = (appId: string): boolean => {
    const stamp = last.get(appId);
    if (!stamp || startedBeforeThisBoot({ startedAt: stamp.at, ...(stamp.bootId ? { bootId: stamp.bootId } : {}) }, clock)) return false;
    const age = clock.uptimeMs() - stamp.uptimeMs;
    return age >= -5000 && age < CRASH_WINDOW_MS;
  };
  const stampSent = (appId: string): void => {
    const bootId = clock.bootId();
    last.set(appId, { at: new Date(clock.now()).toISOString(), uptimeMs: Math.max(0, Math.round(clock.uptimeMs())), ...(bootId ? { bootId } : {}) });
    // Memory alone still limits this run when the disk does not take it.
    try { writeNoticesSync(root, Object.fromEntries(last), clock.now()); } catch (error) { log.fail('crash-notify', error, { phase: 'notices' }); }
  };
  const job = (event: NoticeEvent, scope: string, exempt: boolean, candidates: readonly string[]): Job =>
    ({ event, uuid: `vc-${randomUUID().replace(/-/g, '')}`, attempt: 0, scope, gen: gen(scope), exempt, candidates });
  /** One chain: the limit check, the send and the stamp of one message never interleave with another's. */
  const enqueue = (next: Job): void => {
    queue = queue.then(() => run(next)).catch(error => log.fail('crash-notify', error, { phase: 'send' }));
  };
  const later = (next: Job, wait: number): void => {
    const timer = setTimeout(() => { retries.delete(timer); enqueue({ ...next, attempt: next.attempt + 1 }); }, wait);
    timer.unref();
    retries.set(timer, next.scope);
  };
  const arm = (scope: string, fire: () => void): void => {
    clearTimeout(stable.get(scope));
    const timer = setTimeout(() => { stable.delete(scope); guard('stable', fire); }, stableMs);
    timer.unref();
    stable.set(scope, timer);
  };
  const forget = (scope: string): void => {
    gens.set(scope, gen(scope) + 1);
    waiting.delete(scope);
    clearTimeout(stable.get(scope));
    stable.delete(scope);
    for (const [timer, owner] of retries) if (owner === scope) { clearTimeout(timer); retries.delete(timer); }
  };

  async function run(next: Job): Promise<void> {
    const current = (): boolean => !finalCut.signal.aborted && (!closed || next.exempt) && gen(next.scope) === next.gen;
    if (!current()) return;
    const fields = { kind: next.event.kind, attempt: next.attempt + 1 };
    let sender: Sender | undefined;
    for (const appId of next.candidates) {
      const loaded = await Promise.resolve().then(() => loadSender(appId)).catch(() => 'config-unreadable');
      if (typeof loaded !== 'string') { sender = loaded; break; }
      // The host's message goes to the next bot that joined; a bot's own is not sent by another (P4).
      log.warn('crash-notify', 'skipped', { ...fields, bot: appId, why: loaded });
    }
    if (!next.candidates.length) log.warn('crash-notify', 'skipped', { ...fields, why: 'no-bot' });
    if (!sender || !current()) return;
    if (!next.exempt && limited(sender.appId)) { log.info('crash-notify', 'limited', { ...fields, bot: sender.appId }); return; }
    const signal = next.exempt ? finalCut.signal : AbortSignal.any([closeCut.signal, finalCut.signal]);
    const result = await sendOwnerText(sender, noticeText(next.event), next.uuid, signal, fetchImpl);
    if (result.ok) {
      stampSent(sender.appId);
      log.info('crash-notify', 'sent', { ...fields, bot: sender.appId, owner: sender.openId });
      return;
    }
    const detail = { ...fields, bot: sender.appId, ...(result.status !== undefined ? { status: result.status } : {}), ...(result.code !== undefined ? { code: result.code } : {}), ...(result.msg ? { msg: result.msg } : {}) };
    const wait = retryMs[next.attempt];
    if (result.retry && wait !== undefined && !closed && gen(next.scope) === next.gen) {
      log.warn('crash-notify', 'retry', { ...detail, inMs: wait });
      later(next, wait);
      return;
    }
    log.warn('crash-notify', 'failed', detail);
  }

  return {
    hostStarted(notice, ctx) {
      guard('host-started', () => {
        if (closed || !notice || notice.resumed) return;
        // The earliest bot that can send sends, chosen at each send (D2); ties keep the registry's order.
        const candidates = [...ctx.bots].sort((a, b) => a.createdAt - b.createdAt).map(bot => bot.appId);
        const reason = notice.previous ? crashText(notice.previous) : undefined;
        if (ctx.paused) {
          if (notice.pauseEntered) enqueue(job({ kind: 'host-paused', crashes: notice.crashes, ...(reason ? { reason } : {}), bots: ctx.bots.map(botLabel) }, HOST, true, candidates));
          return;
        }
        if (!reason) return;
        // A bot paused alone before the host went down was not taken down by it (D3).
        const bots = ctx.bots.filter(bot => !ctx.botPaused(bot.appId)).map(botLabel);
        arm(HOST, () => { if (!closed) enqueue(job({ kind: 'host-recovered', crashes: notice.crashes, reason, bots }, HOST, false, candidates)); });
      });
    },
    botStarted(appId) {
      guard('bot-started', () => {
        const event = waiting.get(appId);
        if (closed || !event) return;
        arm(appId, () => {
          if (closed || waiting.get(appId) !== event) return;
          waiting.delete(appId);
          enqueue(job(event, appId, false, [appId]));
        });
      });
    },
    botExited(appId) {
      guard('bot-exited', () => { clearTimeout(stable.get(appId)); stable.delete(appId); });
    },
    botCrashed(appId, name, crashes, reason) {
      guard('bot-crashed', () => { if (!closed) waiting.set(appId, { kind: 'bot-recovered', appId, name, crashes, reason }); });
    },
    botPaused(appId, name, crashes, reason) {
      guard('bot-paused', () => {
        if (closed) return;
        forget(appId);
        enqueue(job({ kind: 'bot-paused', appId, name, crashes, reason }, appId, true, [appId]));
      });
    },
    botForget(appId) {
      guard('bot-forget', () => forget(appId));
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const timer of [...stable.values(), ...retries.keys()]) clearTimeout(timer);
      stable.clear();
      retries.clear();
      waiting.clear();
      closeCut.abort();
      closing = new Promise<void>(resolve => {
        const cut = setTimeout(() => { finalCut.abort(); resolve(); }, deps.closeWaitMs ?? CLOSE_WAIT_MS);
        void queue.then(() => { clearTimeout(cut); resolve(); });
      });
      return closing;
    },
  };
}
