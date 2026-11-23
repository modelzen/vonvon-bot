import { selfEntry } from '../core/self-entry';
import { readSingleInstanceHolder } from '../core/single-instance';
import { botPaths, paths } from '../config/paths';
import { CHILD_SHUTDOWN_GRACE_MS, closeOwnedProviders, observeShutdown, settleOwnedChild, type ShutdownControl, type StopReason } from '../host/lifecycle';
import type { ChildProcess } from 'node:child_process';
import { spawnProcess } from '../platform/spawn';
import { log } from '../core/logger';
import { withoutSessionMarkers } from '../config/session-env';
import { loadBots, type BotEntry } from '../config/bots';
import { askBotOver, createAdminIpcCaller, createHostIpcResponder, FEISHU_READ_IPC_MS, type AdminIpcCaller } from '../admin/ipc';
import { hostFeishuApi, hostFeishuRead } from '../admin/feishu-route';
import { createSessionTokens } from '../host/session-tokens';
import { AdminWriteError } from '../admin/ops';
import { createAdminService } from '../admin/service';
import { botNotRunning } from '../admin/schedule-commands';
import { installBackendDep, uninstallBackendDep } from '../agent';
import { performCoreUpdate } from '../service/update';
import { startApi } from '../server/http';
import { noteClaudeLoginFailed } from '../agent/claude-agent/login';
import { toolCommand } from '../environment/tool-command';
import { createDiagnosticsStore, parseDiagnosticsIpc } from './diagnostics';
import { bridgeVersion } from '../core/version';
import {
  BOT_LOCK_BUSY_EXIT, countInWindow, CRASH_EXIT_CODE, CRASH_PAUSE_COUNT, CRASH_WINDOW_MS, crashRecordFor, crashScopeKey, createCrashRecordCache, hasCrashRecordFor,
  listCrashRecords, pruneCrashRecords, readBotPauses, sanitizeReason, stderrReason, systemClock, writeBotPausesSync, writeCrashRecordSync, type BotPauseState, type CrashRecord,
} from '../host/crash-store';
import { botLabel, createCrashNotifier, type CrashNotifier, type HostNotice } from '../host/crash-notify';
import { crashText, type CrashKind, type CrashPause, type LockHeld, type ScheduleReply } from '@vonvon/protocol';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {bridgeImportRuntime} from '../import/bridge/runtime';

const ownedWorkSchema = z.object({
  fcb: z.literal('fcb.owned-work'),
  pids: z.array(z.number().int().positive()),
  settled: z.boolean(),
  /** The provider process groups the child still has registered; absent from a child before 2026-11-02. */
  registered: z.array(z.number().int().positive()).optional(),
});
type OwnedWorkReport = z.infer<typeof ownedWorkSchema>;
type ChildOwnership = { report?: OwnedWorkReport };


const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** A child that stays up at least this long resets its backoff to the minimum. */
const HEALTHY_UPTIME_MS = 60_000;
/** A failed write of `crash/bot-pauses.json` is tried again this often, besides at each exit and spawn (s18a). */
const PAUSES_RETRY_MS = 30_000;
const LOCK_RETRY_MS = 5_000;
const LOCK_WARN_MS = 120_000;
const LOCK_SLOW_MS = 30_000;
/**
 * The longest a Bot child takes to stop (owner 2026-11-02): it interrupts its turns, gives them 3 seconds, closes the
 * agents and waits at most 8 seconds for the cards (handle-message.ts); past this it is killed, and so are the agent
 * process groups it last reported (they run in groups of their own and would outlive it).
 */
export const BOT_STOP_LIMIT_MS = 15_000;

/** SIGKILL to each reported agent process group still there; POSIX only (Windows ends a child's tree with its job). */
export function reapReportedGroups(pids: readonly number[], kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => process.kill(pid, signal)): number[] {
  if (process.platform === 'win32') return [];
  const reaped: number[] = [];
  for (const pid of new Set(pids)) {
    try { kill(-pid, 'SIGKILL'); reaped.push(pid); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) log.fail('daemon-shutdown', error, { phase: 'reap-agent-group', pid }); }
  }
  return reaped;
}

interface Child {
  bot: BotEntry;
  enabled: boolean;
  stopping?: Promise<void>;
  proc?: ChildProcess;
  backoffMs: number;
  restartTimer?: NodeJS.Timeout;
  startedAt: number;
  /** 管理面 IPC（写转发 + 实时状态查询）；子进程重启换新实例，旧在途请求由
   * rejectAll 收尾，绝不悬挂 Web 请求。 */
  ipc?: AdminIpcCaller;
  /** s18a: 3 crashes in 10 minutes stop this bot alone until 恢复运行 or a new chain. The counted crashes' uptimes
   * back up the disk (full or unwritable); crashes before the last 恢复运行 no longer count. */
  pause?: CrashPause;
  crashTimes: number[];
  resumedUptimeMs?: number;
  prunedAt?: number;
  spawnRecordedAt?: number;
  lockWait?: { since: number; reported?: LockHeld };
  bridgeHeld?: LockHeld;
  bridgeChecking?: boolean;
}

/** The host's run and chain, under which the children's records go, and its own pause (s18a); what its start knows of
 * the run before it, for the owner's private message (s18b). */
export type SupervisorCrash = { runId?: string; chainId?: string; pause?: CrashPause; notice?: HostNotice };
/** An exit 70 whose record cannot be read (s18b's message). */
const NO_RECORD_REASON = '程序出错（子进程出错退出，没留下记录）';

/** 实时状态查询（{kind:'status'}）的短超时：/api/state 是 5s 轮询，不能被一个
 * 假死子进程拖住整页——超时按 connection:'unknown' 渲染。 */
const STATUS_IPC_TIMEOUT_MS = 2_000;
/** Enough for Node's printout of an uncaught error: where, a caret, the error, 10 frames, its fields and a cause. */
const STDERR_TAIL_LINES = 64;
export const HOST_PAUSED_ACTIVATION = 'daemon 已暂停（10 分钟内崩溃了 3 次），这个 Bot 恢复运行后才会启动。运行 vonvon daemon restart 恢复。';

export async function runSupervisor(bots: BotEntry[], options: { control?: ShutdownControl; managed?: boolean; port?: number; onListening?: (listen: string) => Promise<void>; paused?: boolean; crash?: SupervisorCrash; notifier?: CrashNotifier; registryUnreadable?: boolean; timing?: { lockRetryMs?: number; lockWarnMs?: number; lockSlowMs?: number; botStopLimitMs?: number } } = {}): Promise<void> {
  const control = options.control ?? observeShutdown();
  const supervisorStartedAt = Date.now();
  const cliEntry = selfEntry();
  if (!cliEntry) throw new Error('supervisor: 无法解析 CLI 入口');

  // An untracked host (no run marker) still gets its bots' records, under ids of its own.
  const runId = options.crash?.runId ?? randomUUID();
  const chainId = options.crash?.chainId ?? randomUUID();
  // Not a session's: a host started inside one carries its markers, which would refuse `daemon run --bot` (devices-4a 4.9).
  const childEnv: NodeJS.ProcessEnv = { ...withoutSessionMarkers(process.env), VONVON_HOME: paths.appDir, VONVON_HOST_RUN_ID: runId, VONVON_HOST_CHAIN_ID: chainId };
  const migration = bridgeImportRuntime();
  const importCodex = new Map<string, string>();
  let bridgeTimer: ReturnType<typeof setTimeout> | undefined;
  const paused = Boolean(options.paused);
  const root = paths.appDir;
  const clock = systemClock;
  const version = bridgeVersion().slice(0, 40) || '0.0.0';
  const managed = process.env.VONVON_SERVICE?.slice(0, 20) || null;
  const lockRetryMs = options.timing?.lockRetryMs ?? LOCK_RETRY_MS;
  const lockWarnMs = options.timing?.lockWarnMs ?? LOCK_WARN_MS;
  const lockSlowMs = options.timing?.lockSlowMs ?? LOCK_SLOW_MS;
  const botStopLimitMs = options.timing?.botStopLimitMs ?? BOT_STOP_LIMIT_MS;
  // Same chain after a host crash: a paused bot stays paused. A new chain (restart, stop and start) starts them all, and
  // so does a damaged file, logged like a damaged run.json.
  const saved = readBotPauses(root, chainId, () => log.warn('daemon-crash', 'bot_pauses_corrupt', {}));
  const newChild = (bot: BotEntry, enabled: boolean): Child => {
    const state = saved[bot.appId];
    return {
      bot, enabled, backoffMs: BACKOFF_MIN_MS, startedAt: 0, crashTimes: [],
      ...(state?.pausedAt ? { pause: { since: Date.parse(state.pausedAt), crashes: state.pauseCrashes ?? CRASH_PAUSE_COUNT } } : {}),
      ...(state?.resumedUptimeMs !== undefined ? { resumedUptimeMs: state.resumedUptimeMs } : {}),
    };
  };

  let shuttingDown = false;
  const ownership = new WeakMap<ChildProcess, ChildOwnership>();
  const errors: unknown[] = [];
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  /** Stands once the API does; a child's read may come before it (dm-agent 7.3). */
  let adminService!: ReturnType<typeof createAdminService>;
  /** devices-4a 4.1: the bots' session tokens, which the API checks a session's hello against; in memory only. */
  const sessionTokens = createSessionTokens();
  const children = new Map<string, Child>(bots.map((bot) => [bot.appId, newChild(bot, true)]));
  // Lives here, not in the child: a bot's records survive its restarts and go with the daemon's.
  const diagnostics = createDiagnosticsStore({ changed: () => api?.invalidate(), claudeSignedOut: at => noteClaudeLoginFailed(at, toolCommand('claude')) });
  const records = createCrashRecordCache(root);
  const notifier = options.notifier ?? createCrashNotifier({ root, clock, log });

  console.log(paused ? `\ndaemon 已暂停，${bots.length} 个 Bot 都不启动：` : `\n正在启动 ${bots.length} 个 Bot（各自独立进程）：`);
  for (const b of bots) console.log(`  • ${b.name}  (${b.appId})  [${b.tenant}]`);
  console.log('Ctrl+C 退出（关闭全部）。\n');

  const prefixPipe = (name: string, src: NodeJS.ReadableStream | null, dst: NodeJS.WriteStream, onLine?: (line: string) => void): void => {
    if (!src) return;
    let buf = '';
    src.setEncoding('utf8');
    src.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        dst.write(`\x1b[2m[${name}]\x1b[0m ${line}\n`);
        onLine?.(line);
      }
    });
    src.on('end', () => {
      if (buf) dst.write(`\x1b[2m[${name}]\x1b[0m ${buf}\n`);
    });
  };

  /** Disk steps of an exit handler only log: a throw there would be the host's uncaught exception (s18a). */
  const tryDisk = <T>(c: Child, phase: string, fallback: T, step: () => T): T => {
    try { return step(); } catch (error) { log.fail('supervisor', error, { bot: c.bot.name, phase }); return fallback; }
  };
  let pausesUnsaved = false;
  let pausesRetry: NodeJS.Timeout | undefined;
  /** `crash/bot-pauses.json` as memory has it; a bot with no Child here (disabled since the start) keeps the file's entry. */
  const writePauses = (): void => {
    const states: Record<string, BotPauseState> = {};
    for (const [appId, state] of Object.entries(saved)) if (!children.has(appId)) states[appId] = state;
    for (const [appId, each] of children) {
      if (!each.pause && each.resumedUptimeMs === undefined) continue;
      states[appId] = {
        ...(each.pause ? { pausedAt: new Date(each.pause.since).toISOString(), pauseCrashes: each.pause.crashes } : {}),
        ...(each.resumedUptimeMs !== undefined ? { resumedUptimeMs: each.resumedUptimeMs } : {}),
      };
    }
    writeBotPausesSync(root, chainId, states);
    pausesUnsaved = false;
    if (pausesRetry) clearTimeout(pausesRetry);
    pausesRetry = undefined;
  };
  /** Memory decides, the disk follows (s18a): a failed write is logged here, then tried again quietly at the next exit or
   * spawn and every 30 s, so 恢复运行 never waits on a full disk and the file catches up once it is back. */
  const savePauses = (c: Child): void => {
    pausesUnsaved = true;
    tryDisk(c, 'bot-pauses', undefined, writePauses);
    if (pausesUnsaved) armPausesRetry();
  };
  const retryPauses = (): void => {
    if (!pausesUnsaved) return;
    try { writePauses(); } catch { armPausesRetry(); }
  };
  const armPausesRetry = (): void => {
    if (pausesRetry || shuttingDown) return;
    pausesRetry = setTimeout(() => { pausesRetry = undefined; retryPauses(); }, PAUSES_RETRY_MS);
    pausesRetry.unref();
  };
  /** What the child could not record itself: a signal, a handler that failed to write, a fatal exit, a failed spawn. */
  const recordCrash = (c: Child, kind: CrashKind, reason: string, pid: number): CrashRecord => {
    const bootId = clock.bootId();
    const entry: CrashRecord = {
      v: 1, at: new Date(clock.now()).toISOString(), sysUptimeMs: clock.uptimeMs(), ...(bootId ? { bootId } : {}), kind, scope: 'bot', appId: c.bot.appId,
      pid, runId, chainId, startedAt: new Date(c.startedAt).toISOString(), uptimeMs: Math.max(0, Date.now() - c.startedAt), version, managed,
      during: 'run', reason: sanitizeReason(reason),
    };
    tryDisk(c, 'crash-record', '', () => writeCrashRecordSync(root, entry));
    // Pruned at most once a minute, failed spawns included (they never reach countCrash); a paused bot writes no more.
    if (!(Date.now() - (c.prunedAt ?? 0) < 60_000)) {
      c.prunedAt = Date.now();
      tryDisk(c, 'crash-prune', 0, () => pruneCrashRecords(root, { now: clock.now(), scope: crashScopeKey('bot', c.bot.appId) }));
    }
    records.invalidate();
    return entry;
  };
  /** Counts a crash: the larger of the disk's count (it outlives a host crash) and memory's. `paused` when it paused the bot. */
  const countCrash = (c: Child): { crashes: number; paused: boolean } => {
    const up = clock.uptimeMs();
    const since = c.resumedUptimeMs;
    c.crashTimes = [...c.crashTimes.filter(at => up - at <= CRASH_WINDOW_MS && (since === undefined || at > since)), up];
    const key = crashScopeKey('bot', c.bot.appId);
    const onDisk = tryDisk(c, 'crash-count', 0, () => countInWindow(listCrashRecords(root, { scope: key, limit: 10 }),
      { chainId, nowUptimeMs: up, appId: c.bot.appId, ...(since !== undefined ? { sinceUptimeMs: since } : {}) }));
    api?.invalidate();
    const crashes = Math.max(onDisk, c.crashTimes.length);
    if (crashes < CRASH_PAUSE_COUNT) return { crashes, paused: false };
    c.pause = { since: clock.now(), crashes };
    savePauses(c);
    log.warn('supervisor', 'bot-paused', { bot: c.bot.name, appId: c.bot.appId, crashes });
    console.error(`\x1b[2m[${c.bot.name}]\x1b[0m 10 分钟内崩溃了 ${crashes} 次，已停止自动重启。查完原因后在状态与诊断页点「恢复运行」，或运行 vonvon daemon restart。`);
    return { crashes, paused: true };
  };
  /** The owner's private message of a counted crash (s18b): at once when it paused the bot, else once a child stays up. */
  const tellCrash = (c: Child, counted: { crashes: number; paused: boolean }, reason: string): void => {
    if (counted.paused) notifier.botPaused(c.bot.appId, botLabel(c.bot), counted.crashes, reason);
    else notifier.botCrashed(c.bot.appId, botLabel(c.bot), counted.crashes, reason);
  };
  const pausedWrite = (c: Child): string =>
    `Bot「${c.bot.name}」10 分钟内崩溃了 ${c.pause?.crashes ?? CRASH_PAUSE_COUNT} 次，已暂停。在状态与诊断页点「恢复运行」后再试。`;
  /** 恢复运行 of this bot alone, and the disable of a paused bot (s18a): the crashes before it no longer count, on disk either. */
  const clearPause = (c: Child): void => {
    c.pause = undefined;
    c.crashTimes = [];
    // macOS reports uptime in whole seconds: a crash in the same second must still count.
    c.resumedUptimeMs = clock.uptimeMs() - 1;
    c.backoffMs = BACKOFF_MIN_MS;
    savePauses(c);
    api?.invalidate();
  };
  const restartLater = (c: Child, fields: Record<string, unknown>, what: string): void => {
    const wait = c.backoffMs;
    c.backoffMs = Math.min(c.backoffMs * 2, BACKOFF_MAX_MS);
    log.warn('supervisor', 'child-exit', { bot: c.bot.name, ...fields, restartInMs: wait });
    console.error(`\x1b[2m[${c.bot.name}]\x1b[0m ${what}，${Math.round(wait / 1000)}s 后重启…`);
    c.restartTimer = setTimeout(() => spawnChild(c), wait);
  };
  /** No PID: EAGAIN or ENOMEM is the machine's, not the bot's, so one record a minute and retries up to the 30 s backoff;
   * a missing or unrunnable executable (ENOENT, EACCES) counts toward the pause. */
  const spawnFailed = (c: Child, error: unknown): void => {
    if (shuttingDown || !c.enabled || c.stopping) return;
    c.lockWait = undefined;
    const code = String((error as NodeJS.ErrnoException | undefined)?.code ?? (error instanceof Error ? error.message : error));
    if (Date.now() - (c.spawnRecordedAt ?? 0) >= 60_000) { c.spawnRecordedAt = Date.now(); recordCrash(c, 'fatal', `spawn ${code}`, process.pid); }
    if (code === 'ENOENT' || code === 'EACCES') {
      const counted = countCrash(c);
      tellCrash(c, counted, crashText({ kind: 'fatal', reason: sanitizeReason(`spawn ${code}`) }));
      if (counted.paused) return;
    }
    restartLater(c, { spawn: code }, `起不来（spawn ${code}）`);
  };

  const spawnUnchecked = (c: Child): void => {
    if (shuttingDown || paused || !c.enabled || c.proc || c.stopping || c.pause || c.bridgeHeld) return;
    c.restartTimer = undefined;
    retryPauses();
    c.startedAt = Date.now();
    // 'ipc' 通道：子进程据此识别自己被 supervisor 托管（不自己挂 Web 控制台），
    // 并接收管理面写请求（admin/ipc.ts 协议）。
    let proc: ChildProcess;
    try {
      proc = spawnProcess(process.execPath, [cliEntry, 'daemon', 'run', '--bot', c.bot.appId], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: importCodex.has(c.bot.appId) ? {...childEnv, CODEX_BIN: importCodex.get(c.bot.appId)} : childEnv,
      });
    } catch (error) { // ENOMEM and the like throw instead of emitting 'error'
      log.fail('supervisor', error, { bot: c.bot.name, phase: 'spawn' });
      spawnFailed(c, error);
      return;
    }
    c.proc = proc;
    notifier.botStarted(c.bot.appId);
    const owned: ChildOwnership = {};
    ownership.set(proc, owned);
    api?.invalidate();
    const ipc = createAdminIpcCaller((msg) => {
      // connected=false 才算通道关闭；send 返回 false 还可能只是背压（消息仍会
      // 送达），不能据此误拒——真丢失由 caller 的超时兜底。
      if (!proc.connected) throw new Error('IPC 通道已关闭');
      proc.send(msg);
    });
    c.ipc = ipc;
    proc.on('message', ipc.onMessage);
    // devices-4a 4.2: the child asks for its sessions' tokens, and only for its own bot; they end with the process.
    const appId = c.bot.appId;
    const issued = new Set<string>();
    proc.on('message', createHostIpcResponder({
      issueSessionToken: async input => {
        if (input.appId !== appId) throw new Error('A bot process asked for another bot\'s session token');
        const token = sessionTokens.issue(input);
        issued.add(input.sessionId);
        return token;
      },
      revokeSessionToken: async sessionId => { if (issued.delete(sessionId)) sessionTokens.revoke(sessionId); },
      feishuRead: (bot, request) => hostFeishuRead({ appId, tokens: sessionTokens, read: async (reach, read) => {
        if (!adminService?.feishuRead) throw new Error('The daemon is still starting');
        return adminService.feishuRead(reach, read);
      } }, bot, request),
      feishuApi: (bot, request) => hostFeishuApi({ appId, tokens: sessionTokens, api: async (target, call) => {
        if (!adminService?.feishuApi) throw new Error('The daemon is still starting');
        return adminService.feishuApi(target, call);
      } }, bot, request),
    }, msg => { if (proc.connected) proc.send(msg); }).onMessage);
    proc.on('message', (message: unknown) => {
      if (c.proc !== proc) return;
      const parsed = ownedWorkSchema.safeParse(message);
      if (parsed.success && !owned.report?.settled) owned.report = parsed.data;
      if (message && typeof message === 'object' && 'fcb' in message && message.fcb === 'fcb.connection') {
        c.lockWait = undefined;
        api?.invalidate();
      }
      const event = parseDiagnosticsIpc(message);
      if (event) diagnostics.accept(c.bot.appId, event);
    });
    log.info('supervisor', 'child-start', { bot: c.bot.name, appId: c.bot.appId, pid: proc.pid ?? null });
    // The reason of a fatal exit the child did not record; best effort, as the last line may arrive after 'exit' ('close'
    // would wait for a Codex grandchild holding the same stderr). A few lines back, for Node's own printout (s18b).
    const stderrTail: string[] = [];
    prefixPipe(c.bot.name, proc.stdout, process.stdout);
    prefixPipe(c.bot.name, proc.stderr, process.stderr, line => {
      if (!line.trim()) return;
      stderrTail.push(line.slice(0, 300));
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    });

    proc.on('exit', (code, signal) => {
      // Its sessions ended with it, whether or not it is still the bot's current process.
      for (const sessionId of issued) sessionTokens.revoke(sessionId);
      issued.clear();
      if (c.proc !== proc) return;
      diagnostics.clearLive(c.bot.appId);
      c.proc = undefined;
      c.ipc = undefined;
      notifier.botExited(c.bot.appId);
      records.invalidate();
      api?.invalidate();
      // In-flight requests are told what comes next: paused or a restart, once counted (each disk step only logs, so
      // every path below reaches a rejectAll).
      const exited = `Bot「${c.bot.name}」进程已退出（等待自动重启）`;
      if (shuttingDown || !c.enabled || c.stopping) { ipc.rejectAll(exited); return; }
      retryPauses();
      if (code === BOT_LOCK_BUSY_EXIT) {
        ipc.rejectAll(exited);
        const waiting = c.lockWait ??= { since: Date.now() };
        const waited = Date.now() - waiting.since;
        if (waited >= lockWarnMs) {
          const holder = tryDisk(c, 'lock-holder', undefined, () => readSingleInstanceHolder(c.bot.appId, botPaths(c.bot.appId).processesFile));
          if (!waiting.reported || (holder && holder.pid !== waiting.reported.pid)) {
            waiting.reported = { since: waiting.since, ...(holder ? { pid: holder.pid } : {}) };
            log.warn('supervisor', 'lock-held', { bot: c.bot.name, appId: c.bot.appId, holderPid: holder?.pid ?? null, waitedMs: waited });
            console.error(`[${c.bot.name}] 另一个进程${holder ? `（PID ${holder.pid}）` : ''}占着这个 Bot；它退出后会自动接上。`);
            api?.invalidate();
          }
        }
        const wait = waited >= lockWarnMs ? lockSlowMs : lockRetryMs;
        log.info('supervisor', 'lock-busy', { bot: c.bot.name, retryInMs: wait });
        c.restartTimer = setTimeout(() => spawnChild(c), wait);
        return;
      }
      c.lockWait = undefined;
      // Reset backoff if it had been healthy a while; otherwise grow it.
      const uptime = Date.now() - c.startedAt;
      if (uptime >= HEALTHY_UPTIME_MS) c.backoffMs = BACKOFF_MIN_MS;
      // 0 (an exit nobody asked for) is not a crash.
      if (code !== 0) {
        const pid = proc.pid ?? process.pid;
        const key = crashScopeKey('bot', c.bot.appId);
        let entry: CrashRecord | undefined;
        if (signal) entry = recordCrash(c, 'forced', signal, pid);
        else if (code !== CRASH_EXIT_CODE) entry = recordCrash(c, 'fatal', stderrReason(stderrTail) ?? `退出码 ${code}`, pid);
        else if (!tryDisk(c, 'crash-lookup', false, () => hasCrashRecordFor(root, key, pid, c.startedAt))) {
          entry = recordCrash(c, 'exception', '子进程出错退出，没留下记录', pid);
        } else entry = tryDisk(c, 'crash-read', undefined, () => crashRecordFor(root, key, pid, c.startedAt)); // the child's own
        const counted = countCrash(c);
        tellCrash(c, counted, entry ? crashText(entry) : NO_RECORD_REASON);
        if (counted.paused) { ipc.rejectAll(pausedWrite(c)); return; }
      }
      ipc.rejectAll(exited);
      restartLater(c, { code, signal }, `进程退出（code=${code ?? signal ?? '?'}）`);
    });
    proc.on('error', (err) => {
      log.fail('supervisor', err, { bot: c.bot.name, phase: 'spawn' });
      if (proc.pid === undefined && c.proc === proc) { c.proc = undefined; c.ipc = undefined; notifier.botExited(c.bot.appId); ipc.rejectAll(err.message); spawnFailed(c, err); }
    });
  };

  const spawnChild = (child: Child): void => {
    if (shuttingDown || child.bridgeChecking || child.proc || !child.enabled) return;
    child.bridgeChecking = true;
    void migration.guard(child.bot.appId).then(guard => {
      child.bridgeHeld = guard ? {...guard, by: 'bridge', since: child.bridgeHeld?.since ?? Date.now()} : undefined;
      if (!guard) spawnUnchecked(child);
      api?.invalidate();
    }).catch(() => {
      child.bridgeHeld = {by: 'bridge', since: Date.now(), message: '无法检查 Bridge 导入锁，Bot 暂不启动。'};
    }).finally(() => {child.bridgeChecking = false;});
  };

  const stopBot = (child: Child, reason?: StopReason): Promise<void> => {
    if (child.stopping) return child.stopping;
    const proc = child.proc;
    if (!proc) return Promise.resolve();
    const owned = ownership.get(proc);
    // One deadline for the whole stop: the child's own drain, then its exit; SIGKILL after it (stopChild).
    const deadline = Date.now() + botStopLimitMs;
    const left = (): number => Math.max(0, deadline - Date.now());
    const alive = (): boolean => proc.exitCode === null && proc.signalCode === null;
    const settling = settleOwnedChild(proc, () => Math.min(CHILD_SHUTDOWN_GRACE_MS, left()), false, async () => {
      while (alive() && !owned?.report?.settled) {
        if (left() <= 0) {
          log.warn('daemon-shutdown', 'bot_stop_limit', { bot: child.bot.name, pid: proc.pid, limitMs: botStopLimitMs, pids: owned?.report?.pids ?? [] });
          return;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, left())));
      }
    }, reason);
    // Killed past the deadline: the agents it had not closed run in their own groups and would outlive it.
    const stopping = settling.catch(error => {
      const report = owned?.report;
      if (report && !report.settled) {
        const reaped = reapReportedGroups([...report.pids, ...report.registered ?? []]);
        if (reaped.length) log.warn('daemon-shutdown', 'agent_groups_reaped', { bot: child.bot.name, pid: proc.pid, pids: reaped });
      }
      throw error;
    });
    child.stopping = stopping;
    const finished = (): void => {
      child.stopping = undefined;
      if (child.enabled) spawnChild(child);
    };
    void stopping.then(finished, finished);
    return stopping;
  };

  try {
    // Before startApi: a paused host whose port is taken still sends its pause message while it shuts down (D1).
    notifier.hostStarted(options.crash?.notice, {
      chainId, bots, paused, botPaused: appId => Boolean(children.get(appId)?.pause), ...(options.registryUnreadable ? { registryUnreadable: true } : {}),
    });
    // Disabled migrated Bots also belong to Vonvon: acquire all their legacy locks before starting children.
    // The paused recovery host deliberately exposes diagnostics even when bots.json is unreadable.
    // It starts no children; all normal starts still fail closed on a registry read error.
    if (!options.registryUnreadable) for (const bot of (await loadBots()).bots) await migration.guard(bot.appId);
    for (const c of children.values()) spawnChild(c);

    const byAppId = (botId: string): Child | undefined => children.get(botId);
    /** A Bot's channel for a Feishu read. Stopped, paused or draining: none, the same to whoever asked (7.3, "Bot B 没在运行"). */
    const reachable = (botId: string): AdminIpcCaller | undefined => {
      const child = byAppId(botId);
      return !child?.enabled || child.pause || child.stopping || !child.proc ? undefined : child.ipc;
    };
    const hostPause = paused ? options.crash?.pause ?? { since: supervisorStartedAt, crashes: CRASH_PAUSE_COUNT } : undefined;
    migration.bind({
      start: async (appId, fallback) => {
        if (fallback) importCodex.set(appId, fallback);
        const result = await adminService.setBotEnabled(appId, true);
        if (!result.ok) throw new Error('Imported bot activation failed');
      },
      stop: async appId => {
        const child = children.get(appId);
        if (!child) {
          if (readSingleInstanceHolder(appId, botPaths(appId).processesFile)) throw new Error('Bot process ownership is unknown');
          return;
        }
        child.enabled = false;
        if (child.restartTimer) clearTimeout(child.restartTimer);
        await stopBot(child); importCodex.delete(appId);
      },
      connection: async appId => {
        const child = children.get(appId);
        if (!child?.ipc) return 'unknown';
        const value = await child.ipc.call({kind: 'status'}, STATUS_IPC_TIMEOUT_MS).catch(() => undefined) as {connection?: string} | undefined;
        return value?.connection ?? 'unknown';
      },
    }, () => api?.invalidate());
    const checkBridgeLocks = async (): Promise<void> => {
      if (shuttingDown) return;
      try {
        const registry = await loadBots();
        migration.releaseRemoved(new Set(registry.bots.map(bot => bot.appId)));
        for (const bot of registry.bots) await migration.guard(bot.appId);
        for (const child of children.values()) {
          const wasBridgeHeld = child.bridgeHeld !== undefined;
          const guard = await migration.guard(child.bot.appId);
          child.bridgeHeld = guard ? {...guard, by: 'bridge', since: child.bridgeHeld?.since ?? Date.now()} : undefined;
          if (guard && child.proc) await stopBot(child);
          else if (wasBridgeHeld && !guard && child.enabled) spawnChild(child);
        }
        api?.invalidate();
      } catch { /* Unknown ownership is retried; spawnChild still checks before every launch. */ }
      if (!shuttingDown) bridgeTimer = setTimeout(() => void checkBridgeLocks(), lockSlowMs);
    };
    bridgeTimer = setTimeout(() => void checkBridgeLocks(), lockSlowMs);
    api = await startApi({
      startedAt: supervisorStartedAt,
      port: options.port,
      control,
      sessionTokens,
      // devices-4b 4.3: a session's ★ request goes to the process of its bot that is running now. A session of a process
      // that went is not there (its tokens went with it), and one that cannot answer is refused.
      askBot: (appId, sessionId, action) => {
        const child = children.get(appId);
        return askBotOver(child?.proc?.connected ? child.ipc : undefined, sessionId, action);
      },
      bridgeImport: migration.importer,
      diagnostics,
      crashes: { application: now => ({ ...(hostPause ? { paused: hostPause } : {}), records: records(now) }), paused: appId => children.get(appId)?.pause, lockHeld: appId => children.get(appId)?.bridgeHeld ?? children.get(appId)?.lockWait?.reported },
      service: adminService = createAdminService({
        applyBotActivation: async (appId, enabled) => {
          if (shuttingDown) throw new Error('daemon 正在退出。');
          let child = children.get(appId);
          if (child) {
            child.enabled = enabled;
            child.lockWait = undefined;
            if (child.restartTimer) clearTimeout(child.restartTimer);
            child.restartTimer = undefined;
          }
          if (!child?.proc) {
            const foreign = readSingleInstanceHolder(appId, botPaths(appId).processesFile);
            if (foreign) throw new Error(`这个 Bot 由其他进程运行（PID ${foreign.pid}），请先停止那个进程。`);
            if (!child && !enabled) return;
          }
          if (!child) {
            const bot = (await loadBots()).bots.find((entry) => entry.appId === appId);
            if (!bot) throw new Error('这个 Bot 不存在。');
            child = newChild(bot, enabled);
            children.set(appId, child);
          }
          if (!enabled) {
            notifier.botForget(appId);
            // A disable gives the pause up: enabling again is 恢复运行 anyway, and the CLI and the file stop calling it paused.
            if (child.pause) {
              log.info('supervisor', 'bot-pause-dropped', { bot: child.bot.name, appId });
              clearPause(child);
            }
            child.ipc?.rejectAll('Bot 已停用。');
            await stopBot(child);
            return;
          }
          if (paused) throw new Error(HOST_PAUSED_ACTIVATION);
          if (child.pause) {
            log.info('supervisor', 'bot-resumed', { bot: child.bot.name, appId });
            notifier.botForget(appId);
            clearPause(child);
          }
          if (child.stopping) await child.stopping;
          spawnChild(child);
          const deadline = Date.now() + 12_000;
          let lastError: unknown;
          while (!shuttingDown && child.enabled && !child.pause && Date.now() < deadline) {
            const proc = child.proc;
            const ipc = child.ipc;
            if (proc && ipc) {
              try {
                await ipc.call({ kind: 'status' }, STATUS_IPC_TIMEOUT_MS);
                if (child.proc === proc) return;
              } catch (error) { lastError = error; }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (child.pause) throw new Error(pausedWrite(child));
          throw new Error(`Bot 启动后未能及时响应，请查看状态与诊断。${lastError instanceof Error ? lastError.message : ''}`, { cause: lastError });
        },
        executeCollaboration: async (botId, request) => {
          const child = byAppId(botId);
          if (child?.enabled && child.pause) throw new AdminWriteError(pausedWrite(child));
          if (!child?.enabled || !child.proc || !child.ipc) throw new AdminWriteError('这个 Bot 没在运行');
          return child.ipc.call({ kind: 'collaboration', request }, 180_000);
        },
        richRecipe:async(botId,op)=>{const ipc=reachable(botId);if(!ipc)throw new AdminWriteError('请先启动此 Bot');return ipc.call(op,120000);},
        recipeAuthoring: async (botId, op) => {
          const ipc = reachable(botId);
          if (!ipc) throw new AdminWriteError('这个 Bot 没在运行');
          return ipc.call(op, 60000);
        },
        executeGroups: async (botId, op) => {
          const child = byAppId(botId);
          if (child?.enabled && child.pause) throw new AdminWriteError(pausedWrite(child));
          if (!child?.enabled || !child.proc || !child.ipc) throw new AdminWriteError('这个 Bot 没在运行');
          return child.ipc.call(op, 60_000);
        },
        executeSchedule: async (botId, actor, request) => {
          const child = byAppId(botId);
          // A crash-paused bot is not running either; its pause is shown on the bot itself. A stopping one drains and says no.
          if (!child?.enabled || child.pause || child.stopping || !child.proc || !child.ipc) return botNotRunning();
          return child.ipc.call({ kind: 'schedule', actor, request }) as Promise<ScheduleReply>;
        },
        executeFeishuRead: async (botId, request) => reachable(botId)?.call({ kind: 'feishuRead', request }, FEISHU_READ_IPC_MS),
        executeFeishuApi: async (botId, request) => reachable(botId)?.call({ kind: 'feishuApi', request }, FEISHU_READ_IPC_MS),
        firstHello: async (botId) => {
          const child = byAppId(botId);
          if (child?.enabled && !child.pause && !child.stopping && child.proc && child.ipc) await child.ipc.call({ kind: 'firstHello' });
        },
        executeSettingsRead: async (botId, op) => {
          const child = byAppId(botId);
          if (!child?.enabled || !child.proc || !child.ipc) throw new AdminWriteError('这个 Bot 没在运行');
          return child.ipc.call(op);
        },
        executeWrite: async (botId, op) => {
          const c = byAppId(botId);
          if (!c?.enabled) throw new AdminWriteError(`Bot「${botId}」已停用，请先启用。`);
          if (c.pause) throw new AdminWriteError(pausedWrite(c));
          if (!c.proc || !c.ipc) throw new AdminWriteError(`Bot「${c.bot.name}」的进程没在运行（正在崩溃后重启），稍后再试。`);
          return c.ipc.call(op);
        },
        executeLibrary: async (botId, op) => {
          const c = byAppId(botId);
          if (!c?.enabled) throw new AdminWriteError(`Bot「${botId}」已停用，请先启用。`);
          if (c.pause) throw new AdminWriteError(pausedWrite(c));
          if (!c.proc || !c.ipc) throw new AdminWriteError(`Bot「${c.bot.name}」的进程没在运行（正在崩溃后重启），稍后再试。`);
          return c.ipc.call(op, 60_000);
        },
        liveStatus: async (botId) => {
          const c = byAppId(botId);
          if (!c?.proc || !c.ipc) return undefined;
          const proc = c.proc;
          const r = (await c.ipc.call({ kind: 'status' }, STATUS_IPC_TIMEOUT_MS).catch(() => undefined)) as
            | { connection?: string }
            | undefined;
          if (c.proc !== proc) return undefined;
          return {
            running: true,
            pid: proc.pid,
            startedAt: c.startedAt,
            connection: r?.connection ?? 'unknown',
          };
        },
        daemonStartedAt: supervisorStartedAt,
        installBackend: installBackendDep,
        uninstallBackend: uninstallBackendDep,
        applyUpdate: performCoreUpdate,
      }),
    });
    await options.onListening?.(api.listen);
    console.log(`Daemon API listening on ${api.listen}`);

    console.log('vonvon daemon ready');
    await control.waitForRequest();
  } catch (error) { errors.push(error); }
  finally {
    if (bridgeTimer) clearTimeout(bridgeTimer);
    // Restore Bridge before stopping ordinary children. An uncommitted import cannot be abandoned on clean exit.
    try {await migration.shutdown();} catch (error) {errors.push(error);}
    // First: a 30 s wait must not end during the drain and tell the owner a bot "recovered" (s18b).
    const notices = notifier.close();
    shuttingDown = true;
    diagnostics.close();
    for (const child of children.values()) if (child.restartTimer) clearTimeout(child.restartTimer);
    if (pausesRetry) clearTimeout(pausesRetry);
    const cleanup = await Promise.allSettled([closeOwnedProviders(async () => {
      const drained = await Promise.allSettled([Promise.resolve().then(() => api?.beginDrain())]);
      // The Bots stop all at once, each told why: their cards say the server stopped, restarted or updated.
      drained.push(...await Promise.allSettled([...children.values()].map(child => stopBot(child, control.reason))));
      errors.push(...drained.filter(result => result.status === 'rejected').map(result => result.reason));
    }), notices]);
    cleanup.push(...await Promise.allSettled([control.completeShutdown(() => api?.release() ?? Promise.resolve())]));
    migration.dispose();
    if (!options.control) control.dispose();
    const failures = cleanup.filter(result => result.status === 'rejected');
    errors.push(...failures.map(failure => failure.reason));
    for (const error of errors) log.fail('daemon-shutdown', error, { phase: 'cleanup' });
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Supervisor cleanup failed.');
  }
}
