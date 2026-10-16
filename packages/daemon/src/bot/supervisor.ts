import { readSingleInstanceHolder } from '../core/single-instance';
import { botPaths, paths } from '../config/paths';
import { CHILD_SHUTDOWN_GRACE_MS, closeOwnedProviders, observeShutdown, settleOwnedChild, type ShutdownControl } from '../host/lifecycle';
import type { ChildProcess } from 'node:child_process';
import { spawnProcess } from '../platform/spawn';
import { log } from '../core/logger';
import { loadBots, type BotEntry } from '../config/bots';
import { createAdminIpcCaller, type AdminIpcCaller } from '../admin/ipc';
import { AdminWriteError } from '../admin/ops';
import { createAdminService } from '../admin/service';
import { installBackendDep, uninstallBackendDep } from '../agent';
import { performCoreUpdate } from '../service/update';
import { startApi } from '../server/http';
import { noteClaudeLoginFailed } from '../agent/claude-agent/login';
import { createDiagnosticsStore, parseDiagnosticsIpc } from './diagnostics';
import { bridgeVersion } from '../core/version';
import {
  BOT_LOCK_BUSY_EXIT, countInWindow, CRASH_EXIT_CODE, CRASH_PAUSE_COUNT, CRASH_WINDOW_MS, crashScopeKey, createCrashRecordCache, hasCrashRecordFor,
  listCrashRecords, pruneCrashRecords, readBotPauses, sanitizeReason, systemClock, writeBotPausesSync, writeCrashRecordSync, type BotPauseState,
} from '../host/crash-store';
import type { CrashKind, CrashPause } from '@vonvon/protocol';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const ownedWorkSchema = z.object({
  fcb: z.literal('fcb.owned-work'),
  pids: z.array(z.number().int().positive()),
  settled: z.boolean(),
});
type OwnedWorkReport = z.infer<typeof ownedWorkSchema>;
type ChildOwnership = { report?: OwnedWorkReport };


const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** A child that stays up at least this long resets its backoff to the minimum. */
const HEALTHY_UPTIME_MS = 60_000;

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
}

/** The host's run and chain, under which the children's records go, and its own pause (s18a). */
export type SupervisorCrash = { runId?: string; chainId?: string; pause?: CrashPause };

/** 实时状态查询（{kind:'status'}）的短超时：/api/state 是 5s 轮询，不能被一个
 * 假死子进程拖住整页——超时按 connection:'unknown' 渲染。 */
const STATUS_IPC_TIMEOUT_MS = 2_000;
export const HOST_PAUSED_ACTIVATION = 'daemon 已暂停（10 分钟内崩溃了 3 次），这个 bot 恢复运行后才会启动。运行 vonvon daemon restart 恢复。';

export async function runSupervisor(bots: BotEntry[], options: { control?: ShutdownControl; managed?: boolean; port?: number; onListening?: (listen: string) => Promise<void>; paused?: boolean; crash?: SupervisorCrash } = {}): Promise<void> {
  const control = options.control ?? observeShutdown();
  const supervisorStartedAt = Date.now();
  const cliEntry = process.argv[1];
  if (!cliEntry) throw new Error('supervisor: 无法解析 CLI 入口（process.argv[1] 为空）');

  // An untracked host (no run marker) still gets its bots' records, under ids of its own.
  const runId = options.crash?.runId ?? randomUUID();
  const chainId = options.crash?.chainId ?? randomUUID();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, VONVON_HOME: paths.appDir, VONVON_HOST_RUN_ID: runId, VONVON_HOST_CHAIN_ID: chainId };
  const paused = Boolean(options.paused);
  const root = paths.appDir;
  const clock = systemClock;
  const version = bridgeVersion().slice(0, 40) || '0.0.0';
  const managed = process.env.VONVON_SERVICE?.slice(0, 20) || null;
  // Same chain after a host crash: a paused bot stays paused. A new chain (restart, stop and start) starts them all.
  const saved = readBotPauses(root, chainId);
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
  const children = new Map<string, Child>(bots.map((bot) => [bot.appId, newChild(bot, true)]));
  // Lives here, not in the child: a bot's records survive its restarts and go with the daemon's.
  const diagnostics = createDiagnosticsStore({ changed: () => api?.invalidate(), claudeSignedOut: noteClaudeLoginFailed });

  console.log(paused ? `\ndaemon 已暂停，${bots.length} 个机器人都不启动：` : `\n正在启动 ${bots.length} 个机器人（各自独立进程）：`);
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
  const savePauses = (c: Child): void => {
    const states: Record<string, BotPauseState> = {};
    for (const [appId, each] of children) {
      if (!each.pause && each.resumedUptimeMs === undefined) continue;
      states[appId] = {
        ...(each.pause ? { pausedAt: new Date(each.pause.since).toISOString(), pauseCrashes: each.pause.crashes } : {}),
        ...(each.resumedUptimeMs !== undefined ? { resumedUptimeMs: each.resumedUptimeMs } : {}),
      };
    }
    tryDisk(c, 'bot-pauses', undefined, () => writeBotPausesSync(root, chainId, states));
  };
  /** What the child could not record itself: a signal, a handler that failed to write, a fatal exit, a failed spawn. */
  const recordCrash = (c: Child, kind: CrashKind, reason: string, pid: number): void => {
    const bootId = clock.bootId();
    tryDisk(c, 'crash-record', '', () => writeCrashRecordSync(root, {
      v: 1, at: new Date(clock.now()).toISOString(), sysUptimeMs: clock.uptimeMs(), ...(bootId ? { bootId } : {}), kind, scope: 'bot', appId: c.bot.appId,
      pid, runId, chainId, startedAt: new Date(c.startedAt).toISOString(), uptimeMs: Math.max(0, Date.now() - c.startedAt), version, managed,
      during: 'run', reason: sanitizeReason(reason),
    }));
  };
  /** Counts a crash: the larger of the disk's count (it outlives a host crash) and memory's. True when it paused the bot. */
  const countCrash = (c: Child): boolean => {
    const up = clock.uptimeMs();
    const since = c.resumedUptimeMs;
    c.crashTimes = [...c.crashTimes.filter(at => up - at <= CRASH_WINDOW_MS && (since === undefined || at > since)), up];
    const key = crashScopeKey('bot', c.bot.appId);
    const onDisk = tryDisk(c, 'crash-count', 0, () => countInWindow(listCrashRecords(root, { scope: key, limit: 10 }),
      { chainId, nowUptimeMs: up, appId: c.bot.appId, ...(since !== undefined ? { sinceUptimeMs: since } : {}) }));
    // A bot that keeps crashing is pruned at most once a minute; a paused one writes no more.
    if (!(Date.now() - (c.prunedAt ?? 0) < 60_000)) { c.prunedAt = Date.now(); tryDisk(c, 'crash-prune', 0, () => pruneCrashRecords(root, { now: clock.now(), scope: key })); }
    api?.invalidate();
    const crashes = Math.max(onDisk, c.crashTimes.length);
    if (crashes < CRASH_PAUSE_COUNT) return false;
    c.pause = { since: clock.now(), crashes };
    savePauses(c);
    log.warn('supervisor', 'bot-paused', { bot: c.bot.name, appId: c.bot.appId, crashes });
    console.error(`\x1b[2m[${c.bot.name}]\x1b[0m 10 分钟内崩溃了 ${crashes} 次，已停止自动重启。查完原因后在状态与诊断页点「恢复运行」，或运行 vonvon daemon restart。`);
    return true;
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
    const code = String((error as NodeJS.ErrnoException | undefined)?.code ?? (error instanceof Error ? error.message : error));
    if (Date.now() - (c.spawnRecordedAt ?? 0) >= 60_000) { c.spawnRecordedAt = Date.now(); recordCrash(c, 'fatal', `spawn ${code}`, process.pid); }
    if ((code === 'ENOENT' || code === 'EACCES') && countCrash(c)) return;
    restartLater(c, { spawn: code }, `起不来（spawn ${code}）`);
  };

  const spawnChild = (c: Child): void => {
    if (shuttingDown || paused || !c.enabled || c.proc || c.stopping || c.pause) return;
    c.restartTimer = undefined;
    c.startedAt = Date.now();
    // 'ipc' 通道：子进程据此识别自己被 supervisor 托管（不自己挂 Web 控制台），
    // 并接收管理面写请求（admin/ipc.ts 协议）。
    let proc: ChildProcess;
    try {
      proc = spawnProcess(process.execPath, [cliEntry, 'daemon', 'run', '--bot', c.bot.appId], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: childEnv,
      });
    } catch (error) { // ENOMEM and the like throw instead of emitting 'error'
      log.fail('supervisor', error, { bot: c.bot.name, phase: 'spawn' });
      spawnFailed(c, error);
      return;
    }
    c.proc = proc;
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
    proc.on('message', (message: unknown) => {
      if (c.proc !== proc) return;
      const parsed = ownedWorkSchema.safeParse(message);
      if (parsed.success && !owned.report?.settled) owned.report = parsed.data;
      if (message && typeof message === 'object' && 'fcb' in message && message.fcb === 'fcb.connection') api?.invalidate();
      const event = parseDiagnosticsIpc(message);
      if (event) diagnostics.accept(c.bot.appId, event);
    });
    log.info('supervisor', 'child-start', { bot: c.bot.name, appId: c.bot.appId, pid: proc.pid ?? null });
    // The reason of a fatal exit the child did not record; best effort, as the last line may arrive after 'exit' ('close'
    // would wait for a Codex grandchild holding the same stderr).
    let lastStderr: string | undefined;
    prefixPipe(c.bot.name, proc.stdout, process.stdout);
    prefixPipe(c.bot.name, proc.stderr, process.stderr, line => { if (line.trim()) lastStderr = line.slice(0, 300); });

    proc.on('exit', (code, signal) => {
      if (c.proc !== proc) return;
      c.proc = undefined;
      c.ipc = undefined;
      api?.invalidate();
      ipc.rejectAll(`机器人「${c.bot.name}」进程已退出（等待自动重启）`);
      if (shuttingDown || !c.enabled || c.stopping) return;
      // Reset backoff if it had been healthy a while; otherwise grow it.
      const uptime = Date.now() - c.startedAt;
      if (uptime >= HEALTHY_UPTIME_MS) c.backoffMs = BACKOFF_MIN_MS;
      // 0 (an exit nobody asked for) and 75 (the lock still held by the child before it, s18 D2) are not crashes.
      if (code !== 0 && code !== BOT_LOCK_BUSY_EXIT) {
        const pid = proc.pid ?? process.pid;
        if (signal) recordCrash(c, 'forced', signal, pid);
        else if (code !== CRASH_EXIT_CODE) recordCrash(c, 'fatal', lastStderr ?? `退出码 ${code}`, pid);
        else if (!tryDisk(c, 'crash-lookup', false, () => hasCrashRecordFor(root, crashScopeKey('bot', c.bot.appId), pid, c.startedAt))) {
          recordCrash(c, 'exception', '子进程出错退出，没留下记录', pid);
        }
        if (countCrash(c)) return;
      }
      restartLater(c, { code, signal }, `进程退出（code=${code ?? signal ?? '?'}）`);
    });
    proc.on('error', (err) => {
      log.fail('supervisor', err, { bot: c.bot.name, phase: 'spawn' });
      if (proc.pid === undefined && c.proc === proc) { c.proc = undefined; c.ipc = undefined; ipc.rejectAll(err.message); spawnFailed(c, err); }
    });
  };

  const stopBot = (child: Child): Promise<void> => {
    if (child.stopping) return child.stopping;
    const proc = child.proc;
    if (!proc) return Promise.resolve();
    const owned = ownership.get(proc);
    const stopping = settleOwnedChild(proc, CHILD_SHUTDOWN_GRACE_MS, false, async () => {
      const graceEnds = Date.now() + CHILD_SHUTDOWN_GRACE_MS;
      while (proc.exitCode === null && proc.signalCode === null && !owned?.report?.settled) {
        if (Date.now() >= graceEnds) {
          log.warn('daemon-shutdown', 'owned_work_unconfirmed', { pid: proc.pid, pids: owned?.report?.pids ?? [] });
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
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
    for (const c of children.values()) spawnChild(c);

    const byAppId = (botId: string): Child | undefined => children.get(botId);
    const records = createCrashRecordCache(root);
    const hostPause = paused ? options.crash?.pause ?? { since: supervisorStartedAt, crashes: CRASH_PAUSE_COUNT } : undefined;
    api = await startApi({
      port: options.port,
      control,
      diagnostics,
      crashes: { application: now => ({ ...(hostPause ? { paused: hostPause } : {}), records: records(now) }), paused: appId => children.get(appId)?.pause },
      service: createAdminService({
        applyBotActivation: async (appId, enabled) => {
          if (shuttingDown) throw new Error('Host 正在退出。');
          let child = children.get(appId);
          if (child) {
            child.enabled = enabled;
            if (child.restartTimer) clearTimeout(child.restartTimer);
            child.restartTimer = undefined;
          }
          if (!child?.proc) {
            const foreign = readSingleInstanceHolder(appId, botPaths(appId).processesFile);
            if (foreign) throw new Error(`Agent 由其他进程运行（PID ${foreign.pid}），请先停止该独立进程。`);
            if (!child && !enabled) return;
          }
          if (!child) {
            const bot = (await loadBots()).bots.find((entry) => entry.appId === appId);
            if (!bot) throw new Error('机器人不存在。');
            child = newChild(bot, enabled);
            children.set(appId, child);
          }
          if (!enabled) {
            child.ipc?.rejectAll('Agent 已停用。');
            await stopBot(child);
            return;
          }
          if (paused) throw new Error(HOST_PAUSED_ACTIVATION);
          if (child.pause) {
            // 恢复运行 of this bot alone (s18a): the crashes before it no longer count, on disk either.
            log.info('supervisor', 'bot-resumed', { bot: child.bot.name, appId });
            child.pause = undefined;
            child.crashTimes = [];
            child.resumedUptimeMs = clock.uptimeMs();
            child.backoffMs = BACKOFF_MIN_MS;
            savePauses(child);
            api?.invalidate();
          }
          if (child.stopping) await child.stopping;
          spawnChild(child);
          const deadline = Date.now() + 12_000;
          let lastError: unknown;
          while (!shuttingDown && child.enabled && Date.now() < deadline) {
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
          throw new Error(`Agent 启动后未能及时响应，请检查状态与诊断。${lastError instanceof Error ? lastError.message : ''}`, { cause: lastError });
        },
        executeCollaboration: async (botId, request) => {
          const child = byAppId(botId);
          if (!child?.enabled || !child.proc || !child.ipc) throw new AdminWriteError('机器人不在运行中的活跃集里');
          return child.ipc.call({ kind: 'collaboration', request }, 180_000);
        },
        executeGroups: async (botId, op) => {
          const child = byAppId(botId);
          if (!child?.enabled || !child.proc || !child.ipc) throw new AdminWriteError('机器人不在运行中的活跃集里');
          return child.ipc.call(op, 60_000);
        },
        executeSettingsRead: async (botId, op) => {
          const child = byAppId(botId);
          if (!child?.enabled || !child.proc || !child.ipc) throw new AdminWriteError('机器人不在运行中的活跃集里');
          return child.ipc.call(op);
        },
        executeWrite: async (botId, op) => {
          const c = byAppId(botId);
          if (!c?.enabled) throw new AdminWriteError(`机器人「${botId}」已停用，请先启用。`);
          if (c.pause) throw new AdminWriteError(`机器人「${c.bot.name}」10 分钟内崩溃了 ${c.pause.crashes} 次，已暂停。在状态与诊断页点「恢复运行」后再试。`);
          if (!c.proc || !c.ipc) throw new AdminWriteError(`机器人「${c.bot.name}」进程未在运行（崩溃重启中），稍后重试。`);
          return c.ipc.call(op);
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
    shuttingDown = true;
    diagnostics.close();
    for (const child of children.values()) if (child.restartTimer) clearTimeout(child.restartTimer);
    const cleanup = await Promise.allSettled([closeOwnedProviders(async () => {
      const drained = await Promise.allSettled([Promise.resolve().then(() => api?.beginDrain())]);
      drained.push(...await Promise.allSettled([...children.values()].map(stopBot)));
      errors.push(...drained.filter(result => result.status === 'rejected').map(result => result.reason));
    })]);
    cleanup.push(...await Promise.allSettled([control.completeShutdown(() => api?.release() ?? Promise.resolve())]));
    if (!options.control) control.dispose();
    const failures = cleanup.filter(result => result.status === 'rejected');
    errors.push(...failures.map(failure => failure.reason));
    for (const error of errors) log.fail('daemon-shutdown', error, { phase: 'cleanup' });
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Supervisor cleanup failed.');
  }
}
