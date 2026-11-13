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
import { createAdminIpcResponder, createHostIpcCaller, sessionTurnEnded, type HostApi } from '../../admin/ipc';
import { hostFeishuApi, hostFeishuRead } from '../../admin/feishu-route';
import { createSessionTokens, type SessionTokens } from '../../host/session-tokens';
import { createAdminService } from '../../admin/service';
import { botNotRunning } from '../../admin/schedule-commands';
import { installBackendDep, uninstallBackendDep } from '../../agent';
import { performCoreUpdate } from '../../service/update';
import { startApi } from '../../server/http';
import { noteClaudeLoginFailed } from '../../agent/claude-agent/login';
import { toolCommand } from '../../environment/tool-command';
import { createDiagnosticsStore, ipcDiagnosticsSink, setDiagnosticsSink } from '../../bot/diagnostics';
import {bridgeImportRuntime} from '../../import/bridge/runtime';
import { fallbackWorkingDirectory } from '../../platform/fallback-cwd';

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
    if (!process.send) {
      const registry = await ensureRegistry();
      const entry = registry.bots.find(bot => bot.appId === botName || bot.name === botName);
      if (entry) {const guard = await bridgeImportRuntime().guard(entry.appId); if (guard) throw new Error(guard.message);}
    }
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

  const fallbackCwd = fallbackWorkingDirectory();
  console.log('\n正在启动 Bot 的长连接…');
  console.log('私聊我 `/new <名>` 建项目；在项目群里 @我 干活。Ctrl+C 退出。\n');
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  const errors: unknown[] = [];
  // Supervised: the records go to the supervisor, which keeps them across this child's restarts.
  const ownAppId = cfg.accounts.app.id;
  const diagnostics = process.send ? undefined : createDiagnosticsStore({ changed: () => api?.invalidate(), claudeSignedOut: at => noteClaudeLoginFailed(at, toolCommand('claude')) });
  setDiagnosticsSink(diagnostics
    ? event => diagnostics.accept(ownAppId, event)
    : ipcDiagnosticsSink((message, callback) => { if (process.connected) process.send?.(message, undefined, undefined, callback); }));
  // devices-4a 4.2: a supervised child asks the host for its sessions' tokens; alone, this process is the host and keeps them.
  let tokens: SessionTokens | undefined;
  let host: HostApi;
  let adminService: ReturnType<typeof createAdminService> | undefined;
  if (process.send) {
    const caller = createHostIpcCaller(msg => {
      if (!process.connected) throw new Error('IPC 通道已关闭');
      process.send?.(msg);
    });
    process.on('message', caller.onMessage);
    host = caller;
  } else {
    const own = tokens = createSessionTokens();
    host = {
      issueSessionToken: async input => {
        if (input.appId !== ownAppId) throw new Error('这个 Bot 不归本进程管');
        return own.issue(input);
      },
      revokeSessionToken: async sessionId => { own.revoke(sessionId); },
      // Alone, the only Bot here is this one: any other is not running, which the same route says.
      feishuRead: (bot, request) => hostFeishuRead({ appId: ownAppId, tokens: own, read: async (reach, read) => {
        if (!adminService?.feishuRead) throw new Error('The daemon is still starting');
        return adminService.feishuRead(reach, read);
      } }, bot, request),
      feishuApi: (bot, request) => hostFeishuApi({ appId: ownAppId, tokens: own, api: async (target, call) => {
        if (!adminService?.feishuApi) throw new Error('The daemon is still starting');
        return adminService.feishuApi(target, call);
      } }, bot, request),
    };
  }
  try {
    const handle = bridge = await startBridge({ identity: ready.identity, cfg, appSecret: secret, fallbackCwd, droppedFile: botPaths(ownAppId).droppedFile, judgeUsageFile: botPaths(ownAppId).judgeUsageFile, host, onConnectionChange: () => {
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
          if (op.kind === 'recipeAuthoring' || op.kind === 'recipeAuthoringDisconnect') return handle.authoring(op);
          if (op.kind === 'firstHello') return handle.firstHello();
          if (op.kind === 'collaboration') return handle.collaboration(op.request);
          if (op.kind === 'joinedGroups' || op.kind === 'groupMembers' || op.kind === 'groupMembership' || op.kind === 'groupIdentity' || op.kind === 'bindGroup') return handle.adminGroups(op);
          if (op.kind === 'settingsRead') return handle.settings.read(op.scope);
          if (op.kind === 'settingsModels') return handle.settings.models(op.query);
          if (op.kind === 'libraryWorkspaceChanged' || op.kind === 'libraryWorkspaceCheck') return handle.libraryExecute(op);
          if (op.kind === 'schedule') return handle.schedule(op.actor, op.request);
          if (op.kind === 'authorizeSessionCall') return handle.entries.authorizeSessionCall(op.sessionId, op.action);
          if (op.kind === 'feishuRead') return handle.feishuRead(op.request);
          if (op.kind === 'feishuApi') return handle.feishuApi(op.request);
          return handle.adminExecute(op);
        },
        (msg) => void process.send?.(msg),
      );
      process.on('message', respond);
    } else {
      const startedAt = Date.now();
      api = await startApi({
        startedAt,
        port: options.port,
        control,
        ...(tokens ? { sessionTokens: tokens } : {}),
        // This process is the bot's: a session's ★ request is judged here, by the same entries its tools use.
        askBot: async (appId, sessionId, action) => (appId === ownAppId ? handle.entries.authorizeSessionCall(sessionId, action) : sessionTurnEnded()),
        ...(diagnostics ? { diagnostics } : {}),
        service: adminService = createAdminService({
          executeCollaboration: async (botId, request) => {
            if (botId !== ownAppId) throw new AdminWriteError('这个 Bot 不归本进程管');
            return handle.collaboration(request);
          },
          recipeAuthoring: async (botId, op) => {
            if (botId !== ownAppId) throw new AdminWriteError('这个 Bot 不归本进程管');
            return handle.authoring(op);
          },
          executeGroups: async (botId, op) => {
            if (botId !== ownAppId) throw new AdminWriteError('这个 Bot 不归本进程管');
            return handle.adminGroups(op);
          },
          firstHello: async (botId) => { if (botId === ownAppId) await handle.firstHello(); },
          executeSettingsRead: async (botId, op) => {
            if (botId !== ownAppId) throw new AdminWriteError('这个 Bot 不归本进程管');
            return op.kind === 'settingsRead' ? handle.settings.read(op.scope) : handle.settings.models(op.query);
          },
          executeWrite: async (botId, op) => {
            if (botId !== ownAppId) {
              throw new AdminWriteError(
                '这个 Bot 不归本进程管：当前只运行一个 Bot，只能改它的设置。要同时管几个 Bot，用 `vonvon daemon start` 启动 daemon。',
              );
            }
            return handle.adminExecute(op);
          },
          executeLibrary: async (botId, op) => {
            if (botId !== ownAppId) throw new AdminWriteError('这个 Bot 不归本进程管');
            return handle.libraryExecute(op);
          },
          // Another registered bot is not running here: the same refusal the supervisor gives.
          executeSchedule: async (botId, actor, request) => (botId === ownAppId ? handle.schedule(actor, request) : botNotRunning()),
          executeFeishuRead: async (botId, request) => (botId === ownAppId ? handle.feishuRead(request) : undefined),
          executeFeishuApi: async (botId, request) => (botId === ownAppId ? handle.feishuApi(request) : undefined),
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
    const cleanup = await Promise.allSettled([closeOwnedProviders(async () => {
      const drained = await Promise.allSettled([Promise.resolve().then(() => api?.beginDrain())]);
      // The cards of the turns this stop cuts short say why: the host's message says a stop, restart or update.
      const closing = Promise.resolve().then(() => bridge?.shutdown(() => control.reason ?? 'stop'));
      drained.push(...await Promise.allSettled([withinStopLimit(closing, BRIDGE_STOP_LIMIT_MS)]));
      errors.push(...drained.filter(result => result.status === 'rejected').map(result => result.reason));
    })]);
    // Only once the bridge is closed: a dropped message's reply settled during the close still reaches the page (s18c).
    setDiagnosticsSink(undefined);
    diagnostics?.close();
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

/**
 * The longest the Bot's own close is waited for (owner 2026-11-02): its turns are interrupted and their cards updated
 * within 3 + 8 seconds (bot/handle-message.ts) and the scheduled runs' records follow; a Feishu call or an agent that
 * hangs past this does not hold the stop up. The agents are closed right after either way (closeOwnedProviders).
 */
export const BRIDGE_STOP_LIMIT_MS = 12_000;

/** Waits for `closing` at most `ms`; past it the stop goes on and the late close is only logged. */
export async function withinStopLimit(closing: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>(resolve => { timer = setTimeout(resolve, ms, 'late'); });
  try {
    const outcome = await Promise.race([closing.then(() => 'closed' as const), late]);
    if (outcome === 'late') {
      log.warn('daemon-shutdown', 'bridge_stop_limit', { pid: process.pid, limitMs: ms });
      closing.catch(error => log.fail('daemon-shutdown', error, { phase: 'bridge-late' }));
    }
  } finally { clearTimeout(timer); }
}
