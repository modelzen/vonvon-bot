import { readSingleInstanceHolder } from '../core/single-instance';
import { botPaths, paths } from '../config/paths';
import { CHILD_SHUTDOWN_GRACE_MS, closeOwnedProviders, observeShutdown, settleOwnedChild, type ShutdownControl } from '../host/lifecycle';
import type { ChildProcess } from 'node:child_process';
import { spawnProcess } from '../platform/spawn';
import { SERVICE_ENV_FLAG } from '../service/win-startup';
import { log } from '../core/logger';
import { loadBots, type BotEntry } from '../config/bots';
import { createAdminIpcCaller, type AdminIpcCaller } from '../admin/ipc';
import { AdminWriteError } from '../admin/ops';
import { createAdminService } from '../admin/service';
import { installBackendDep, uninstallBackendDep } from '../agent';
import { performCoreUpdate } from '../service/update';
import { startApi } from '../server/http';
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
}

/** 实时状态查询（{kind:'status'}）的短超时：/api/state 是 5s 轮询，不能被一个
 * 假死子进程拖住整页——超时按 connection:'unknown' 渲染。 */
const STATUS_IPC_TIMEOUT_MS = 2_000;

export async function runSupervisor(bots: BotEntry[], options: { control?: ShutdownControl; managed?: boolean; port?: number; onListening?: (listen: string) => Promise<void> } = {}): Promise<void> {
  const control = options.control ?? observeShutdown();
  const supervisorStartedAt = Date.now();
  const cliEntry = process.argv[1];
  if (!cliEntry) throw new Error('supervisor: 无法解析 CLI 入口（process.argv[1] 为空）');

  const childEnv: NodeJS.ProcessEnv = { ...process.env, VONVON_HOME: paths.appDir };
  delete childEnv[SERVICE_ENV_FLAG];

  let shuttingDown = false;
  const ownership = new WeakMap<ChildProcess, ChildOwnership>();
  const errors: unknown[] = [];
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  const children = new Map<string, Child>(bots.map((bot) => [bot.appId, { bot, enabled: true, backoffMs: BACKOFF_MIN_MS, startedAt: 0 } satisfies Child]));

  console.log(`\n正在启动 ${bots.length} 个机器人（各自独立进程）：`);
  for (const b of bots) console.log(`  • ${b.name}  (${b.appId})  [${b.tenant}]`);
  console.log('Ctrl+C 退出（关闭全部）。\n');

  const prefixPipe = (name: string, src: NodeJS.ReadableStream | null, dst: NodeJS.WriteStream): void => {
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
      }
    });
    src.on('end', () => {
      if (buf) dst.write(`\x1b[2m[${name}]\x1b[0m ${buf}\n`);
    });
  };

  const spawnChild = (c: Child): void => {
    if (shuttingDown || !c.enabled || c.proc || c.stopping) return;
    c.restartTimer = undefined;
    c.startedAt = Date.now();
    // 'ipc' 通道：子进程据此识别自己被 supervisor 托管（不自己挂 Web 控制台），
    // 并接收管理面写请求（admin/ipc.ts 协议）。
    const proc = spawnProcess(process.execPath, [cliEntry, 'daemon', 'run', '--bot', c.bot.appId], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: childEnv,
    });
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
    });
    log.info('supervisor', 'child-start', { bot: c.bot.name, appId: c.bot.appId, pid: proc.pid ?? null });
    prefixPipe(c.bot.name, proc.stdout, process.stdout);
    prefixPipe(c.bot.name, proc.stderr, process.stderr);

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
      const wait = c.backoffMs;
      c.backoffMs = Math.min(c.backoffMs * 2, BACKOFF_MAX_MS);
      log.warn('supervisor', 'child-exit', { bot: c.bot.name, code, signal, restartInMs: wait });
      console.error(
        `\x1b[2m[${c.bot.name}]\x1b[0m 进程退出（code=${code ?? signal ?? '?'}），${Math.round(wait / 1000)}s 后重启…`,
      );
      c.restartTimer = setTimeout(() => spawnChild(c), wait);
    });
    proc.on('error', (err) => {
      log.fail('supervisor', err, { bot: c.bot.name, phase: 'spawn' });
      if (proc.pid === undefined && c.proc === proc) { c.proc = undefined; c.ipc = undefined; ipc.rejectAll(err.message); }
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
    api = await startApi({
      port: options.port,
      control,
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
            child = { bot, enabled, backoffMs: BACKOFF_MIN_MS, startedAt: 0 };
            children.set(appId, child);
          }
          if (!enabled) {
            child.ipc?.rejectAll('Agent 已停用。');
            await stopBot(child);
            return;
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
