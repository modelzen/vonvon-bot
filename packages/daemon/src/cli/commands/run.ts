import { closeOwnedProviders, listenerCloseUnconfirmed, observeShutdown, type ShutdownControl } from '../../host/lifecycle';
import { ensureOnboarded, announceEventsWhenLive } from '../../bot/onboarding';
import { startBridge } from '../../bot/bridge';
import { runSupervisor, type SupervisorCrash } from '../../bot/supervisor';
import { BOT_LOCK_BUSY_EXIT } from '../../host/crash-store';
import { acquireSingleInstanceLock, BridgeAlreadyRunningError, readSingleInstanceHolder } from '../../core/single-instance';
import { botPaths } from '../../config/paths';
import { activeBots, ensureRegistry, type BotEntry } from '../../config/bots';
import { log } from '../../core/logger';
import { AdminWriteError } from '../../admin/ops';
import { createAdminIpcResponder } from '../../admin/ipc';
import { createAdminService } from '../../admin/service';
import { installBackendDep, uninstallBackendDep } from '../../agent';
import { performCoreUpdate } from '../../service/update';
import { startApi } from '../../server/http';
import { noteClaudeLoginFailed } from '../../agent/claude-agent/login';
import { createDiagnosticsStore, ipcDiagnosticsSink, setDiagnosticsSink } from '../../bot/diagnostics';

interface RunOptions {
  control?: ShutdownControl;
  managed?: boolean;
  port?: number;
  onListening?: (listen: string) => Promise<void>;
  /** 3 crashes in 10 minutes (3.10): the API and the page run, no bot does, until `vonvon daemon restart`. */
  paused?: boolean;
  /** The host's run and chain for the bot children's records, and its pause (s18a). */
  crash?: SupervisorCrash;
}

export async function runRun(botName?: string, options: RunOptions = {}): Promise<void> {
  const control = options.control ?? observeShutdown();
  const managed = Boolean(options.managed);
  if (options.paused) {
    // Paused mode must come up even when reading the registry is what crashed; no onboarding, no inline bot.
    // When it cannot be read, any bot with a folder may send the pause message: it may be the owner's only word (s18b D1).
    let bots: BotEntry[] = [];
    let registryUnreadable = false;
    try { bots = activeBots(await ensureRegistry()); }
    catch (error) { registryUnreadable = true; log.fail('daemon-crash', error, { phase: 'paused-registry' }); }
    await runSupervisor(bots, {
      control, managed, port: options.port, onListening: options.onListening, paused: true,
      ...(options.crash ? { crash: options.crash } : {}), ...(registryUnreadable ? { registryUnreadable: true } : {}),
    });
    return;
  }
  // Explicit selector always runs exactly that one bot inline (this is also how
  // the supervisor launches each child: `run --bot <appId>`).
  if (botName) {
    await runSingle(botName, control, options);
    return;
  }

  let registry = await ensureRegistry();
  if (registry.bots.length === 0 && process.stdout.isTTY) {
    const ready = await ensureOnboarded({ allowCreate: true });
    if (!ready) { process.exitCode = 1; return; }
    registry = await ensureRegistry();
  }
  await runSupervisor(activeBots(registry), { control, managed, port: options.port, onListening: options.onListening, ...(options.crash ? { crash: options.crash } : {}) });
}

/** Run a single bot inline in this process. `botName` undefined → the implicit
 *  current/default bot (with first-run onboarding allowed). */
async function runSingle(botName: string | undefined, control: ShutdownControl, options: RunOptions): Promise<void> {
  if (process.send && botName?.startsWith('cli_')) {
    let holder: ReturnType<typeof readSingleInstanceHolder>;
    try { holder = readSingleInstanceHolder(botName, botPaths(botName).processesFile); }
    catch { /* The actual lock acquisition below remains authoritative. */ }
    if (holder) {
      console.error(`✗ ${new BridgeAlreadyRunningError(holder.pid).message}`);
      log.info('run', 'already-running', { pid: holder.pid, early: true });
      process.exitCode = BOT_LOCK_BUSY_EXIT;
      return;
    }
  }
  const ready = await ensureOnboarded({ allowCreate: !botName, bot: botName });
  if (!ready) {
    process.exitCode = 1;
    return;
  }
  const { cfg, secret } = ready;

  // Refuse to run alongside another bridge for the same app — two long
  // connections split card callbacks and make buttons flaky (see module doc).
  let releaseLock: () => void;
  try {
    releaseLock = acquireSingleInstanceLock(cfg.accounts.app.id);
  } catch (err) {
    if (err instanceof BridgeAlreadyRunningError) {
      console.error(`✗ ${err.message}`);
      log.info('run', 'already-running', { pid: err.pid });
      // Supervised, the holder is most likely the previous child still draining after its host died: not a crash (s18 D2).
      process.exitCode = process.send ? BOT_LOCK_BUSY_EXIT : 1;
      return;
    }
    throw err;
  }

  const fallbackCwd = process.env.FEISHU_CODEX_CWD || process.cwd();
  console.log('\n正在启动长连接 bot…');
  console.log('私聊我 `/new <名>` 建项目；在项目群里 @我 干活。Ctrl+C 退出。\n');
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  const errors: unknown[] = [];
  // Supervised: the records go to the supervisor, which keeps them across this child's restarts.
  const ownAppId = cfg.accounts.app.id;
  const diagnostics = process.send ? undefined : createDiagnosticsStore({ changed: () => api?.invalidate(), claudeSignedOut: noteClaudeLoginFailed });
  setDiagnosticsSink(diagnostics
    ? event => diagnostics.accept(ownAppId, event)
    : ipcDiagnosticsSink((message, callback) => { if (process.connected) process.send?.(message, undefined, undefined, callback); }));
  try {
    const handle = bridge = await startBridge({ cfg, appSecret: secret, fallbackCwd, onConnectionChange: () => {
      if (process.send) {
        if (process.connected) process.send({ fcb: 'fcb.connection' }, undefined, undefined, (error: Error | null) => { if (error && process.connected) log.fail('run', error, { phase: 'connection-notice' }); });
      }
      else api?.invalidate();
    } });
    void announceEventsWhenLive(ready);

    if (process.send) {
      const respond = createAdminIpcResponder(
        async (op) => {
          if (op.kind === 'status') {
            return { connection: handle.channel.getConnectionStatus?.()?.state ?? 'unknown' };
          }
          if (op.kind === 'collaboration') return handle.collaboration(op.request);
          if (op.kind === 'joinedGroups' || op.kind === 'bindGroup') return handle.adminGroups(op);
          if (op.kind === 'settingsRead') return handle.settings.read(op.scope);
          if (op.kind === 'settingsModels') return handle.settings.models(op.query);
          return handle.adminExecute(op);
        },
        (msg) => void process.send?.(msg),
      );
      process.on('message', respond);
    } else {
      const startedAt = Date.now();
      api = await startApi({
        port: options.port,
        control,
        ...(diagnostics ? { diagnostics } : {}),
        service: createAdminService({
          executeCollaboration: async (botId, request) => {
            if (botId !== ownAppId) throw new AdminWriteError('机器人不在本进程的活跃集里');
            return handle.collaboration(request);
          },
          executeGroups: async (botId, op) => {
            if (botId !== ownAppId) throw new AdminWriteError('机器人不在本进程的活跃集里');
            return handle.adminGroups(op);
          },
          executeSettingsRead: async (botId, op) => {
            if (botId !== ownAppId) throw new AdminWriteError('机器人不在本进程的活跃集里');
            return op.kind === 'settingsRead' ? handle.settings.read(op.scope) : handle.settings.models(op.query);
          },
          executeWrite: async (botId, op) => {
            if (botId !== ownAppId) {
              throw new AdminWriteError(
                '该机器人不归本进程管：当前是单 bot 运行模式，只能改本 bot 的项目。多 bot 请 `bot use` 勾选后重启，由 supervisor 聚合管理。',
              );
            }
            return handle.adminExecute(op);
          },
          liveStatus: async (botId) =>
            botId === ownAppId
              ? {
                  running: true,
                  pid: process.pid,
                  startedAt,
                  connection: handle.channel.getConnectionStatus?.()?.state ?? 'unknown',
                }
              : undefined,
          daemonStartedAt: startedAt,
          installBackend: installBackendDep,
          uninstallBackend: uninstallBackendDep,
          applyUpdate: performCoreUpdate,
        }),
      });
      await options.onListening?.(api.listen);
      console.log(`Daemon API listening on ${api.listen}`);
    }

    if (!process.send) console.log('vonvon daemon ready');
    await control.waitForRequest();
  } catch (error) { errors.push(error); }
  finally {
    setDiagnosticsSink(undefined);
    diagnostics?.close();
    const cleanup = await Promise.allSettled([closeOwnedProviders(async () => {
      const drained = await Promise.allSettled([Promise.resolve().then(() => api?.beginDrain())]);
      drained.push(...await Promise.allSettled([Promise.resolve().then(() => bridge?.shutdown())]));
      errors.push(...drained.filter(result => result.status === 'rejected').map(result => result.reason));
    })]);
    cleanup.push(...await Promise.allSettled([control.completeShutdown(() => api?.release() ?? Promise.resolve())]));
    const failures = cleanup.filter((result) => result.status === 'rejected');
    errors.push(...failures.map(failure => failure.reason));
    if (!errors.some(listenerCloseUnconfirmed)) {
      try { releaseLock(); } catch (error) { errors.push(error); }
    }
    if (!options.control) control.dispose();
    for (const error of errors) log.fail('daemon-shutdown', error, { phase: 'cleanup' });
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Single Bot cleanup failed.');
  }
}
