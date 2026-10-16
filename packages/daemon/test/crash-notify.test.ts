import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crashText, type CrashEntry } from '@vonvon/protocol';
import type { BotEntry } from '../src/config/bots';
import type { Clock } from '../src/host/crash-store';

// The owner's private messages (s18b): fake fetch, fake timers, an injected clock and senders, crash/ in a temp dir.
const f = vi.hoisted(() => ({ botDir: '' }));
vi.mock('../src/config/paths', async original => {
  const real = await original<typeof import('../src/config/paths')>();
  return { ...real, botPaths: (appId: string) => ({ ...real.botPaths(appId), configFile: join(f.botDir, appId, 'config.json') }) };
});
import { botFolders, createCrashNotifier, loadOwnerSender, noticeText, sendOwnerText, type HostNotice, type LoadSender, type Sender } from '../src/host/crash-notify';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const tempRoot = (): string => { const root = mkdtempSync(join(tmpdir(), 'vonvon-crash-notify-')); roots.push(root); return root; };

const EARLY = 'cli_early';
const LATE = 'cli_late';
const ALONE = 'cli_alone';
// Registry order is the reverse of joining order: the sender must be chosen by createdAt.
const bots: BotEntry[] = [
  { appId: LATE, name: 'late', botName: '晚到', tenant: 'feishu', createdAt: 3000 },
  { appId: ALONE, name: 'alone', tenant: 'feishu', createdAt: 2000 },
  { appId: EARLY, name: 'early', botName: '早到', tenant: 'feishu', createdAt: 1000 },
];
const sender = (appId: string): Sender => ({ appId, tenant: 'feishu', appSecret: `secret-${appId}`, openId: `ou_owner_of_${appId}` });
const previous: CrashEntry = { at: Date.parse('2026-10-16T05:00:00Z'), kind: 'forced', reason: '被系统强制结束', uptimeMs: 180_000 };
const hostNotice = (fields: Partial<HostNotice> = {}): HostNotice => ({ previous, crashes: 1, resumed: false, pauseEntered: false, ...fields });

type Call = { url: string; body: Record<string, unknown>; auth?: string; redirect?: string; signal?: AbortSignal };
type Reply = { status: number; body?: unknown } | 'throw' | 'hang' | { delay: number; then: Reply };
let calls: Call[];
let reply: (call: Call) => Reply;
const ok = (call: Call): Reply => call.url.includes('tenant_access_token')
  ? { status: 200, body: { code: 0, tenant_access_token: `t-${String(call.body.app_id)}` } } : { status: 200, body: { code: 0, data: { message_id: 'om_sent' } } };
const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const call: Call = { url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>, auth: (init?.headers as Record<string, string> | undefined)?.Authorization, redirect: init?.redirect, signal: init?.signal ?? undefined };
  calls.push(call);
  let answer = reply(call);
  while (typeof answer === 'object' && 'delay' in answer) {
    const { delay, then } = answer;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      call.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
    answer = then;
  }
  if (answer === 'throw') throw new TypeError('fetch failed');
  if (answer === 'hang') {
    return new Promise((_resolve, reject) => {
      const abort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (call.signal?.aborted) abort(); else call.signal?.addEventListener('abort', abort);
    });
  }
  return { status: answer.status, json: async () => answer.body } as Response;
}) as typeof fetch;
const messages = (): Call[] => calls.filter(call => call.url.includes('/open-apis/im/v1/messages'));
const textOf = (call: Call | undefined): string => (JSON.parse(String(call?.body.content)) as { text: string }).text;

let now: number;
let up: number;
let boot: string | undefined;
const clock: Clock = { now: () => now, uptimeMs: () => up, bootId: () => boot };
let root: string;
const newLog = () => ({ info: vi.fn(), warn: vi.fn(), fail: vi.fn() });
let logs: ReturnType<typeof newLog>;
let senders: Record<string, Sender | string>;
const loadSender: LoadSender = async appId => senders[appId] ?? 'no-owner';
const make = (extra: Partial<Parameters<typeof createCrashNotifier>[0]> = {}) => createCrashNotifier({ root, log: logs, clock, fetchImpl, loadSender, ...extra });
const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
/** Moves the clock and the timers together. */
const tick = async (ms: number): Promise<void> => { now += ms; up += ms; await vi.advanceTimersByTimeAsync(ms); await flush(); };
const ctx = (paused = false, botPaused: (appId: string) => boolean = () => false) => ({ bots, paused, botPaused });
/** A loadSender that waits `ms` (fake timers) before it answers. */
const slowSender = (ms: number): LoadSender => async appId => { await new Promise(resolve => setTimeout(resolve, ms)); return loadSender(appId); };

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  reply = ok;
  now = Date.parse('2026-10-16T06:00:00Z');
  up = 50_000_000;
  boot = 'boot-a';
  root = tempRoot();
  logs = newLog();
  senders = { [EARLY]: sender(EARLY), [LATE]: sender(LATE), [ALONE]: sender(ALONE) };
});
afterEach(() => { vi.useRealTimers(); });

describe('the host\'s messages', () => {
  it('① tells the earliest bot\'s owner 30 s after a crashed host is back, listing the bots it took down', async () => {
    const n = make();
    n.hostStarted(hostNotice(), ctx(false, appId => appId === ALONE));
    await tick(29_000);
    expect(calls).toEqual([]);
    await tick(1_000);
    const [token, message] = calls;
    expect(token).toMatchObject({ url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', body: { app_id: EARLY, app_secret: `secret-${EARLY}` }, redirect: 'error' });
    expect(message).toMatchObject({ url: 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', auth: `Bearer t-${EARLY}`, body: { receive_id: `ou_owner_of_${EARLY}`, msg_type: 'text' } });
    expect(textOf(message)).toBe(`daemon 刚才崩溃过一次，已自动恢复。受影响的 bot：晚到、早到。原因：${crashText(previous)}。`);
    expect(logs.info).toHaveBeenCalledWith('crash-notify', 'sent', expect.objectContaining({ kind: 'host-recovered', bot: EARLY }));
    await n.close();
  });

  it('② sends nothing when it closes before the 30 s', async () => {
    const n = make();
    n.hostStarted(hostNotice(), ctx());
    await tick(29_000);
    await n.close();
    expect(vi.getTimerCount()).toBe(0); // no timer is left behind
    await tick(120_000);
    expect(calls).toEqual([]);
  });

  it('③ a start that took a resume request, or found no crash, tells nothing', async () => {
    const n = make();
    n.hostStarted(hostNotice({ resumed: true }), ctx());
    n.hostStarted(hostNotice({ previous: undefined }), ctx());
    n.hostStarted(undefined, ctx());
    await tick(60_000);
    expect(calls).toEqual([]);
    await n.close();
  });

  it('③ a start by hand long after the crash (none in the last 10 minutes) tells nothing', async () => {
    const n = make();
    n.hostStarted(hostNotice({ crashes: 0 }), ctx());
    await tick(60_000);
    expect(calls).toEqual([]);
    expect(logs.info).toHaveBeenCalledWith('crash-notify', 'skipped', { kind: 'host-recovered', why: 'stale' });
    await n.close();
  });

  it('④ the start that paused the host tells at once and lists every enabled bot; a start already paused tells nothing', async () => {
    const n = make();
    n.hostStarted(hostNotice({ crashes: 3, pauseEntered: true }), ctx(true, appId => appId === ALONE));
    await flush();
    expect(messages()).toHaveLength(1);
    expect(textOf(messages()[0])).toBe(`daemon 10 分钟内崩溃了 3 次，已停止自动重启，bot 都没有启动：晚到、alone、早到。最近一次的原因：${crashText(previous)}。查完原因后在状态与诊断页点「恢复运行」，或运行 vonvon daemon restart。`);
    const again = make();
    again.hostStarted(hostNotice({ crashes: 4, pauseEntered: false }), ctx(true));
    await tick(60_000);
    expect(messages()).toHaveLength(1);
    await Promise.all([n.close(), again.close()]);
  });

  it('④ with bots.json unreadable, the pause message goes from a bot that has a folder (D1)', async () => {
    for (const name of [LATE, ALONE, 'not-a-bot']) mkdirSync(join(root, 'bots', name), { recursive: true });
    writeFileSync(join(root, 'bots', 'cli_file'), '');
    expect(botFolders(root).sort()).toEqual([ALONE, LATE].sort());
    senders[LATE] = 'no-owner';
    const n = make();
    n.hostStarted(hostNotice({ crashes: 3, pauseEntered: true }), { bots: [], paused: true, botPaused: () => false, registryUnreadable: true });
    await flush();
    // Not EARLY: it has a sender, but no folder.
    expect(messages()).toMatchObject([{ body: { receive_id: `ou_owner_of_${ALONE}` } }]);
    expect(textOf(messages()[0])).toMatch(/^daemon 10 分钟内崩溃了 3 次，已停止自动重启，bot 都没有启动。/);
    expect(botFolders(join(root, 'nothing-here'))).toEqual([]);
    await n.close();
  });

  it('⑤ goes to the next bot that joined when the earliest cannot send, and says why', async () => {
    senders[EARLY] = 'no-owner';
    const n = make();
    n.hostStarted(hostNotice({ crashes: 2 }), ctx());
    await tick(30_000);
    expect(messages()).toMatchObject([{ body: { receive_id: `ou_owner_of_${ALONE}` } }]);
    expect(textOf(messages()[0])).toMatch(/^daemon 10 分钟内崩溃了 2 次，已自动恢复。.*最近一次的原因：/);
    expect(logs.warn).toHaveBeenCalledWith('crash-notify', 'skipped', expect.objectContaining({ bot: EARLY, why: 'no-owner' }));
    await n.close();
  });
});

describe('a bot\'s messages', () => {
  it('⑥ tells a crash once the next child has stayed up 30 s; a child that ends sooner starts the count again', async () => {
    const n = make();
    n.botCrashed(LATE, '晚到', 1, '程序出错：TypeError: x，运行了 3 分 12 秒');
    n.botStarted(LATE);
    await tick(20_000);
    n.botExited(LATE);
    n.botCrashed(LATE, '晚到', 2, '程序出错：TypeError: y，运行了 20 秒');
    await tick(20_000);
    n.botStarted(LATE);
    await tick(29_000);
    expect(calls).toEqual([]);
    await tick(1_000);
    expect(messages()).toMatchObject([{ body: { receive_id: `ou_owner_of_${LATE}` } }]);
    expect(textOf(messages()[0])).toBe('「晚到」10 分钟内崩溃了 2 次，已自动恢复。最近一次的原因：程序出错：TypeError: y，运行了 20 秒。');
    // Nothing waits any more: the next child sends nothing.
    n.botExited(LATE);
    n.botStarted(LATE);
    await tick(60_000);
    expect(messages()).toHaveLength(1);
    await n.close();
  });

  it('⑥ a child that ends without a crash (exit 0 or 75) before its 30 s sends nothing until the next one has stayed up', async () => {
    const n = make();
    n.botCrashed(ALONE, 'alone', 1, 'x');
    n.botStarted(ALONE);
    await tick(20_000);
    n.botExited(ALONE);
    await tick(40_000);
    expect(calls).toEqual([]);
    n.botStarted(ALONE);
    await tick(30_000);
    expect(messages().map(textOf)).toEqual(['「alone」刚才崩溃过一次，已自动恢复。原因：x。']);
    await n.close();
  });

  it('a bot\'s own messages are not sent by another bot when its config cannot (P4)', async () => {
    senders[LATE] = 'secret-unreadable';
    const n = make();
    n.botCrashed(LATE, '晚到', 1, 'x');
    n.botStarted(LATE);
    await tick(30_000);
    n.botPaused(LATE, '晚到', 3, 'z');
    await tick(60_000);
    expect(calls).toEqual([]);
    expect(logs.warn).toHaveBeenCalledWith('crash-notify', 'skipped', expect.objectContaining({ kind: 'bot-paused', bot: LATE, why: 'secret-unreadable' }));
    await n.close();
  });

  it('⑦ one message a bot per 10 minutes of this boot; a new boot or 10 minutes later sends again', async () => {
    const n = make();
    const crashOnce = async (): Promise<void> => { n.botCrashed(LATE, '晚到', 1, 'x'); n.botStarted(LATE); await tick(30_000); n.botExited(LATE); };
    await crashOnce();
    await crashOnce();
    expect(messages()).toHaveLength(1);
    expect(logs.info).toHaveBeenCalledWith('crash-notify', 'limited', expect.objectContaining({ kind: 'bot-recovered', bot: LATE }));
    await tick(540_000);
    await crashOnce();
    expect(messages()).toHaveLength(2);
    await crashOnce();
    expect(messages()).toHaveLength(2);
    boot = 'boot-b';
    up = 1_000_000;
    await crashOnce();
    expect(messages()).toHaveLength(3);
    await n.close();
  });

  it('⑧ the pause message goes out within the limit and takes the place of the next one', async () => {
    const n = make();
    n.botCrashed(LATE, '晚到', 1, 'x');
    n.botStarted(LATE);
    await tick(30_000);
    n.botPaused(LATE, '晚到', 3, '程序出错：TypeError: z');
    await flush();
    expect(messages()).toHaveLength(2);
    expect(textOf(messages()[1])).toBe('「晚到」10 分钟内崩溃了 3 次，已停止自动重启，别的 bot 照常。最近一次的原因：程序出错：TypeError: z。查完原因后在状态与诊断页点「恢复运行」。');
    // Same quota as the host's message from this bot.
    const host = make();
    senders[EARLY] = 'no-owner';
    senders[ALONE] = 'no-owner';
    host.hostStarted(hostNotice(), ctx());
    await tick(30_000);
    expect(messages()).toHaveLength(2);
    await Promise.all([n.close(), host.close()]);
  });

  it('⑪ a pause drops the untold crash, its 30 s and its retries: no "已自动恢复" after "已停止"', async () => {
    const n = make();
    reply = call => (call.url.includes('/im/v1/messages') ? 'throw' : ok(call));
    n.botCrashed(LATE, '晚到', 1, 'x');
    n.botStarted(LATE);
    await tick(30_000);
    expect(messages()).toHaveLength(1); // failed, a retry waits
    n.botCrashed(LATE, '晚到', 2, 'y');
    n.botStarted(LATE);
    // Feishu refuses the pause message: no quota is taken, so only the drop keeps the older ones from going out.
    reply = call => (call.url.includes('/im/v1/messages') && textOf(call).includes('已停止') ? { status: 400, body: { code: 230013 } } : ok(call));
    n.botPaused(LATE, '晚到', 3, 'z');
    await tick(600_000);
    expect(messages().map(textOf)).toEqual([expect.stringContaining('刚才崩溃过一次'), expect.stringContaining('已停止自动重启')]);
    await n.close();
  });

  it('恢复运行 or a disable drops what waits', async () => {
    const n = make();
    n.botCrashed(LATE, '晚到', 1, 'x');
    n.botStarted(LATE);
    n.botForget(LATE);
    await tick(60_000);
    expect(calls).toEqual([]);
    await n.close();
  });

  it('恢复运行 or a disable while the sender is being read drops the message too', async () => {
    let release: (() => void) | undefined;
    const n = make({ loadSender: appId => new Promise(resolve => { release = () => resolve(senders[appId] ?? 'no-owner'); }) });
    n.botCrashed(LATE, '晚到', 1, 'x');
    n.botStarted(LATE);
    await tick(30_000);
    expect(release).toBeDefined();
    n.botForget(LATE);
    release?.();
    await flush();
    expect(calls).toEqual([]);
    await n.close();
  });
});

describe('sending', () => {
  it('⑨ retries a network error 1 and 5 minutes on with the same uuid, then gives up', async () => {
    const n = make();
    reply = () => 'throw';
    n.hostStarted(hostNotice({ crashes: 3, pauseEntered: true }), ctx(true));
    await flush();
    await tick(59_000);
    expect(calls).toHaveLength(1);
    await tick(1_000);
    expect(calls).toHaveLength(2);
    reply = call => (call.url.includes('/im/v1/messages') ? 'throw' : ok(call));
    await tick(300_000);
    expect(calls).toHaveLength(4);
    await tick(3_600_000);
    expect(calls).toHaveLength(4);
    expect(logs.warn).toHaveBeenLastCalledWith('crash-notify', 'failed', expect.objectContaining({ kind: 'host-paused', attempt: 3 }));
    await n.close();
  });

  it.each([
    ['HTTP 429', { status: 429, body: {} }, true],
    ['HTTP 503', { status: 503 }, true],
    ['code 99991400', { status: 400, body: { code: 99991400, msg: 'request trigger frequency limit' } }, true],
    ['code 230020', { status: 400, body: { code: 230020, msg: 'rate limited' } }, true],
    ['HTTP 400', { status: 400, body: { code: 230013, msg: 'Bot has NO availability to this user.' } }, false],
    ['code ≠ 0 with HTTP 200', { status: 200, body: { code: 230002, msg: 'bot not in chat' } }, false],
  ] as const)('⑨ %s is %s tried again', async (_label, answer, retried) => {
    const n = make();
    const uuids: unknown[] = [];
    reply = call => {
      if (!call.url.includes('/im/v1/messages')) return ok(call);
      uuids.push(call.body.uuid);
      return uuids.length === 1 ? answer : ok(call);
    };
    n.botPaused(LATE, '晚到', 3, 'z');
    await flush();
    await tick(60_000);
    if (retried) {
      expect(uuids).toHaveLength(2);
      expect(uuids[0]).toMatch(/^vc-[0-9a-f]{32}$/);
      expect(uuids[1]).toBe(uuids[0]);
    } else {
      expect(uuids).toHaveLength(1);
      expect(logs.warn).toHaveBeenCalledWith('crash-notify', 'failed', expect.objectContaining({ bot: LATE, status: answer.status }));
    }
    await n.close();
  });

  it('a refused token is not tried again', async () => {
    const n = make();
    reply = () => ({ status: 200, body: { code: 10014, msg: 'app secret invalid' } });
    n.botPaused(LATE, '晚到', 3, 'z');
    await tick(600_000);
    expect(calls).toHaveLength(1);
    expect(logs.warn).toHaveBeenCalledWith('crash-notify', 'failed', expect.objectContaining({ code: 10014 }));
    await n.close();
  });

  it('⑩ only a message that got through is written to crash/notices.json (0600), which the next host reads', async () => {
    reply = call => (call.url.includes('/im/v1/messages') ? { status: 400, body: { code: 230013 } } : ok(call));
    const n = make();
    n.botPaused(LATE, '晚到', 3, 'z');
    await flush();
    expect(() => statSync(join(root, 'crash', 'notices.json'))).toThrow();
    reply = ok;
    n.botPaused(EARLY, '早到', 3, 'z');
    await flush();
    const file = join(root, 'crash', 'notices.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, bots: { [EARLY]: { at: new Date(now).toISOString(), uptimeMs: up, bootId: 'boot-a' } } });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    await n.close();
    // The next host (the same boot, 5 minutes on) is still limited for EARLY.
    await tick(300_000);
    const next = make();
    next.hostStarted(hostNotice(), ctx());
    await tick(30_000);
    expect(messages()).toHaveLength(2);
    expect(logs.info).toHaveBeenCalledWith('crash-notify', 'limited', expect.objectContaining({ kind: 'host-recovered', bot: EARLY }));
    await next.close();
  });

  it('⑫ close cuts an ordinary message in flight, waits for a pause message, and cuts that one at 10 s', async () => {
    reply = call => (call.url.includes('/im/v1/messages') ? 'hang' : ok(call));
    const n = make();
    n.botCrashed(LATE, '晚到', 1, 'x');
    n.botStarted(LATE);
    await tick(30_000);
    expect(messages()).toHaveLength(1);
    const closed = n.close();
    await flush();
    expect(messages()[0]?.signal?.aborted).toBe(true);
    await closed;
    // Cut by the shutdown is not a failure to send.
    expect(logs.warn).not.toHaveBeenCalledWith('crash-notify', 'failed', expect.anything());
    expect(logs.info).toHaveBeenCalledWith('crash-notify', 'cut', expect.objectContaining({ kind: 'bot-recovered', bot: LATE }));

    const paused = make();
    paused.hostStarted(hostNotice({ crashes: 3, pauseEntered: true }), ctx(true));
    await flush();
    const inFlight = messages()[1];
    let done = false;
    const closing = paused.close().then(() => { done = true; });
    await tick(9_000);
    expect(inFlight?.signal?.aborted).toBe(false);
    expect(done).toBe(false);
    await tick(1_000);
    await closing;
    expect(inFlight?.signal?.aborted).toBe(true);
    expect(logs.warn).toHaveBeenCalledWith('crash-notify', 'cut', expect.objectContaining({ kind: 'host-paused' }));
  });

  it('⑫ a pause message whose sender is read after close gets the whole wait for its requests, once', async () => {
    reply = call => ({ delay: 3_000, then: ok(call) });
    const n = make({ loadSender: slowSender(6_000) });
    n.hostStarted(hostNotice({ crashes: 3, pauseEntered: true }), ctx(true));
    let done = false;
    const closing = n.close().then(() => { done = true; });
    await tick(9_000); // the sender read at 6 s, the token at 9 s
    await tick(3_000); // the message at 12 s: past the 10 s counted from close
    await closing;
    expect(done).toBe(true);
    expect(logs.info).toHaveBeenCalledWith('crash-notify', 'sent', expect.objectContaining({ kind: 'host-paused' }));

    // Counted again once only: a sender read at 9 s and Feishu hanging end the wait at 19 s.
    reply = () => 'hang';
    const slow = make({ loadSender: slowSender(9_000) });
    slow.hostStarted(hostNotice({ crashes: 3, pauseEntered: true }), ctx(true));
    let ended = false;
    const ending = slow.close().then(() => { ended = true; });
    await tick(18_999);
    expect(ended).toBe(false);
    await tick(1);
    await ending;
    expect(calls.at(-1)?.signal?.aborted).toBe(true);
  });

  it('⑫ close waits for a pause message queued at the start (D1), and calls after it do nothing', async () => {
    const n = make();
    n.hostStarted(hostNotice({ crashes: 3, pauseEntered: true }), ctx(true));
    await n.close(); // before the job even began: startApi threw right after hostStarted
    expect(messages()).toHaveLength(1);
    n.botPaused(LATE, '晚到', 3, 'z');
    n.botCrashed(LATE, '晚到', 1, 'x');
    n.botStarted(LATE);
    n.hostStarted(hostNotice({ crashes: 3, pauseEntered: true }), ctx(true));
    await tick(60_000);
    expect(messages()).toHaveLength(1);
  });

  it('sendOwnerText goes to the Lark host for a Lark bot', async () => {
    const result = await sendOwnerText({ ...sender(LATE), tenant: 'lark' }, 'hi', 'vc-1', new AbortController().signal, fetchImpl);
    expect(result).toEqual({ ok: true });
    expect(calls.map(call => call.url)).toEqual([
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', 'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id',
    ]);
    expect(calls[1]?.body).toEqual({ receive_id: `ou_owner_of_${LATE}`, msg_type: 'text', content: JSON.stringify({ text: 'hi' }), uuid: 'vc-1' });
  });
});

describe('texts and senders', () => {
  it('⑬ one line, no stack and no home folder; no "受影响的 bot" when none was', () => {
    const reason = crashText({ kind: 'exception', reason: 'TypeError: x', uptimeMs: 192_000 });
    const texts = [
      noticeText({ kind: 'host-recovered', crashes: 1, reason, bots: [] }),
      noticeText({ kind: 'host-paused', crashes: 3, bots: [] }),
      noticeText({ kind: 'bot-recovered', appId: LATE, name: '晚到', crashes: 1, reason }),
      noticeText({ kind: 'bot-paused', appId: LATE, name: '晚到', crashes: 3, reason }),
    ];
    expect(texts).toEqual([
      'daemon 刚才崩溃过一次，已自动恢复。原因：程序出错：TypeError: x，运行了 3 分 12 秒。',
      'daemon 10 分钟内崩溃了 3 次，已停止自动重启，bot 都没有启动。查完原因后在状态与诊断页点「恢复运行」，或运行 vonvon daemon restart。',
      '「晚到」刚才崩溃过一次，已自动恢复。原因：程序出错：TypeError: x，运行了 3 分 12 秒。',
      '「晚到」10 分钟内崩溃了 3 次，已停止自动重启，别的 bot 照常。最近一次的原因：程序出错：TypeError: x，运行了 3 分 12 秒。查完原因后在状态与诊断页点「恢复运行」。',
    ]);
    for (const text of texts) expect(text).not.toMatch(/\n|\/home\/|\/Users\/|at .*\(/);
  });

  it('reads the owner, the tenant and the secret from the bot\'s config, and says why it cannot', async () => {
    f.botDir = tempRoot();
    const write = (appId: string, config: unknown): void => {
      mkdirSync(join(f.botDir, appId), { recursive: true });
      writeFileSync(join(f.botDir, appId, 'config.json'), JSON.stringify(config));
    };
    write(EARLY, { accounts: { app: { id: EARLY, secret: 'plain-secret', tenant: 'lark' } }, preferences: { access: { ownerOpenId: 'ou_owner_early' } } });
    write(LATE, { accounts: { app: { id: LATE, secret: 'plain-secret', tenant: 'feishu' } } });
    write(ALONE, { accounts: { app: { id: ALONE, tenant: 'feishu' } } });
    mkdirSync(join(f.botDir, 'cli_broken'), { recursive: true });
    writeFileSync(join(f.botDir, 'cli_broken', 'config.json'), '{');
    expect(await loadOwnerSender(EARLY)).toEqual({ appId: EARLY, tenant: 'lark', appSecret: 'plain-secret', openId: 'ou_owner_early' });
    expect(await loadOwnerSender(LATE)).toBe('no-owner');
    expect(await loadOwnerSender(ALONE)).toBe('config-incomplete');
    expect(await loadOwnerSender('cli_missing')).toBe('config-incomplete');
    expect(await loadOwnerSender('cli_broken')).toBe('config-unreadable');
  });
});
