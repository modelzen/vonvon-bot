import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceActionMessage } from '@vonvon/protocol';
import { liveServiceActionRecord, type ServiceActionRecord } from '../../daemon/src/service/action-report.js';
import { classifyDistribution, isTranslocated } from '../../daemon/src/service/distribution.js';
import { isNewer } from '../../daemon/src/service/update.js';
import { daemonEnvironment } from './daemon-dependencies.js';
import type { Registration, VerifiedDaemon } from './daemon-manager.js';
import { ServiceActionError } from './service-error.js';

/** Where the app runs: the service may only point at a packaged app's own bundled daemon. */
export interface ServiceRuntime {
  platform: NodeJS.Platform;
  packaged: boolean;
  root: string;
  home: string;
  /** The app's own executable, the authoritative app location. */
  executable: string;
  resources: string;
}

export interface CliOptions {
  spawn?: typeof spawn;
  readReport?: (root: string) => ServiceActionRecord | null;
  timeoutMs?: number;
}

const HELPER_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 60_000;

/** The bundled `vonvon` entry, or the refusal the window shows. */
export function bundledServiceCli(runtime: ServiceRuntime): string {
  if (runtime.platform !== 'darwin') throw new ServiceActionError('unsupported');
  if (!runtime.packaged) throw new ServiceActionError('unpackaged');
  const distribution = classifyDistribution(join(runtime.resources, 'daemon'));
  if (distribution.kind !== 'bundled') throw new ServiceActionError('distribution');
  return distribution.cliPath;
}

type Exit = { pid: number | undefined; code: number | null; signal: NodeJS.Signals | null };

/**
 * Runs `<app> <bundled vonvon> ...args` the way the daemon is launched, logging to daemon.log. Resolves null when it
 * still runs after `timeoutMs`: it is left to finish, never killed, because it may be in the middle of a transaction.
 */
async function runCli(runtime: ServiceRuntime, cli: string, args: readonly string[], timeoutMs: number, start = spawn): Promise<Exit | null> {
  const log = await open(join(runtime.root, 'daemon.log'), 'a', 0o600);
  try {
    return await new Promise<Exit | null>((resolve, reject) => {
      const child = start(runtime.executable, [cli, ...args], {
        env: daemonEnvironment(runtime.root, runtime.home), stdio: ['ignore', log.fd, log.fd],
      });
      const timer = setTimeout(() => { child.unref(); resolve(null); }, timeoutMs);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ pid: child.pid, code, signal }); });
    });
  } finally { await log.close(); }
}

/** `vonvon service install|uninstall --keep-running`, judged by the report it wrote (`service-action.json`). */
export async function runServiceHelper(runtime: ServiceRuntime, action: 'install' | 'uninstall', options: CliOptions = {}): Promise<void> {
  const cli = bundledServiceCli(runtime);
  const started = Date.now();
  let exit: Exit | null;
  try { exit = await runCli(runtime, cli, ['service', action, '--keep-running'], options.timeoutMs ?? HELPER_TIMEOUT_MS, options.spawn); }
  catch { throw new ServiceActionError('exit'); }
  if (!exit) throw new ServiceActionError('timeout');
  const report = (options.readReport ?? liveServiceActionRecord)(runtime.root);
  if (!report || report.pid !== exit.pid) {
    if (exit.code === 0) return;
    // The service mutex refuses a helper before it writes anything while another one runs: that one's report is still
    // running, or finished after this one started. An older report says nothing about why this one failed.
    const another = report !== null && (report.phase === 'running' || (report.finishedAt ?? 0) >= started);
    throw new ServiceActionError(another ? 'busy' : 'exit');
  }
  if (report.phase !== 'done') throw new ServiceActionError('exit');
  if (!report.ok) throw new ServiceActionError('report', serviceActionMessage(report), report.reason);
}

/** `vonvon daemon stop`, waiting up to a minute; the error message completes "没能停下旧版本的 daemon：". */
export async function stopDaemon(runtime: ServiceRuntime, options: CliOptions = {}): Promise<void> {
  const exit = await runCli(runtime, bundledServiceCli(runtime), ['daemon', 'stop'], options.timeoutMs ?? STOP_TIMEOUT_MS, options.spawn);
  if (!exit) throw new Error('1 分钟内没停下');
  if (exit.code !== 0) throw new Error(`vonvon daemon stop 失败（${exit.signal ?? `退出码 ${exit.code}`}），详情在 daemon.log`);
}

export interface LoginItemHooks {
  readVerifiedDaemon(): Promise<VerifiedDaemon | null>;
  /** Makes sure a daemon runs (ensureReady), then hands the window a connection to it. */
  reattach(): Promise<void>;
  /** While true, a dropped daemon connection is part of the switch, not a failure to report. */
  expectDisconnect(expected: boolean): void;
  /** A quit or an update is closing the window: stop waiting for a helper. */
  cancelled(): boolean;
}

export interface FollowOptions {
  /** Whether a `vonvon service` helper still runs; by default, whether its report is running and its pid alive. */
  helperRunning?: () => boolean;
  pollMs?: number;
}

type DaemonIdentity = Pick<VerifiedDaemon, 'pid' | 'startedAt'>;
const sameDaemon = (daemon: DaemonIdentity, other: DaemonIdentity | null | undefined): boolean =>
  other !== null && other !== undefined && daemon.pid === other.pid && daemon.startedAt === other.startedAt;

/**
 * Reattaches a window whose daemon `previous` a helper may replace: to the daemon the helper hands over, or, once no
 * helper runs, to what ensureReady finds or starts. Nothing is started while a helper may still change the service.
 */
export async function followServiceHelper(runtime: ServiceRuntime, previous: DaemonIdentity | null | undefined,
  hooks: LoginItemHooks, options: FollowOptions = {}): Promise<void> {
  const helperRunning = options.helperRunning ?? (() => liveServiceActionRecord(runtime.root)?.phase === 'running');
  for (;;) {
    if (hooks.cancelled()) return;
    const current = await hooks.readVerifiedDaemon().catch(() => null);
    if ((current && !sameDaemon(current, previous)) || !helperRunning()) break;
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 250));
  }
  if (!hooks.cancelled()) await hooks.reattach();
}

/**
 * 登录电脑时启动 from the window. The helper may replace the daemon the window talks to (install hands a detached
 * daemon to launchd, uninstall boots the service's out and starts a detached one), so the window reattaches when the
 * verified daemon is not `previous` any more.
 */
export async function changeLoginItem(runtime: ServiceRuntime, enabled: boolean,
  previous: DaemonIdentity | null | undefined, hooks: LoginItemHooks, options: CliOptions & FollowOptions = {}): Promise<void> {
  // Refuse an unsupported app before the window expects its daemon to go.
  bundledServiceCli(runtime);
  hooks.expectDisconnect(true);
  let failure: unknown;
  try { await runServiceHelper(runtime, enabled ? 'install' : 'uninstall', options); }
  catch (error) { failure = error; }
  const current = await hooks.readVerifiedDaemon().catch(() => null);
  if (current && sameDaemon(current, previous)) hooks.expectDisconnect(false);
  else {
    // After a timeout or a busy refusal a helper, ours or the one holding the mutex, may still be draining the daemon.
    try { await followServiceHelper(runtime, previous, hooks, options); }
    catch { throw new ServiceActionError('reattach'); }
  }
  if (failure) throw failure;
}

/**
 * `stop`: no service and an older daemon; ensureReady then starts the bundled one. `stop-and-reinstall`: an older
 * daemon runs under a service of ours. `reinstall`: the service points at a moved app or is in an older format; a
 * running daemon is stopped only when the install says it is in the way.
 */
export type StartupRepair = 'none' | 'stop' | 'stop-and-reinstall' | 'reinstall';

export interface StartupRepairInput {
  platform: NodeJS.Platform;
  packaged: boolean;
  executable: string;
  registration: Registration;
  running: VerifiedDaemon | null;
  /** `Resources/daemon/package.json`; the app's own version is the stage package's. */
  bundledVersion: string | undefined;
  exists(path: string): boolean;
}

function repairApplies(input: Pick<StartupRepairInput, 'platform' | 'packaged' | 'executable'>): boolean {
  return input.platform === 'darwin' && input.packaged && !isTranslocated(input.executable);
}

/**
 * Before the desktop attaches: an app that moved or was updated rewrites the service, a newer bundled daemon replaces
 * an older running one. An npm service or another root's is left alone, and nothing is ever downgraded.
 */
export function planStartupRepair(input: StartupRepairInput): StartupRepair {
  if (!repairApplies(input)) return 'none';
  const { registration, running, bundledVersion } = input;
  const older = running?.version !== undefined && bundledVersion !== undefined && isNewer(bundledVersion, running.version);
  switch (registration.kind) {
    case 'ours': {
      const definition = registration.definition;
      if (definition?.kind !== 'desktop') return 'none';
      if (older) return 'stop-and-reinstall';
      return !input.exists(definition.executable) || !input.exists(definition.entry) ? 'reinstall' : 'none';
    }
    // An older format of ours, which install rewrites; a symlink or directory under our name it refuses.
    case 'unrecognized': return registration.replaceable !== true ? 'none' : older ? 'stop-and-reinstall' : 'reinstall';
    case 'absent': return older ? 'stop' : 'none';
    case 'other-root': return 'none';
  }
}

function readBundledVersion(resources: string): string | undefined {
  try {
    const version: unknown = JSON.parse(readFileSync(join(resources, 'daemon', 'package.json'), 'utf8')).version;
    return typeof version === 'string' ? version : undefined;
  } catch { return undefined; }
}

function messageOf(error: unknown): string {
  if (error instanceof ServiceActionError) return error.safeMessage;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the repair planned for this start. Returns what the user should read: the fatal dialog shows it when the
 * desktop then cannot attach, otherwise it is a non-blocking notice. A failed stop skips the rest and keeps the old daemon.
 */
export async function repairServiceAtStartup(runtime: ServiceRuntime,
  read: { readRegistration(): Promise<Registration>; readVerifiedDaemon(): Promise<VerifiedDaemon | null> },
  options: { stop?: CliOptions; helper?: CliOptions; exists?: (path: string) => boolean } = {}): Promise<string | undefined> {
  if (!repairApplies(runtime)) return undefined;
  let registration: Registration;
  let running: VerifiedDaemon | null;
  // What cannot be read here, ensureReady reads again and reports.
  try { [registration, running] = await Promise.all([read.readRegistration(), read.readVerifiedDaemon()]); }
  catch { return undefined; }
  const plan = planStartupRepair({
    ...runtime, registration, running, bundledVersion: readBundledVersion(runtime.resources), exists: options.exists ?? existsSync,
  });
  if (plan === 'none') return undefined;
  const stop = async (): Promise<string | undefined> => {
    try { await stopDaemon(runtime, options.stop); return undefined; }
    catch (error) { return `没能停下旧版本的 daemon：${messageOf(error)}。先用着旧版本，稍后在「应用与启动」里重启 daemon。`; }
  };
  if (running && plan !== 'reinstall') {
    const failed = await stop();
    if (failed) return failed;
  }
  if (plan === 'stop') return undefined;
  const install = () => runServiceHelper(runtime, 'install', options.helper);
  try {
    try { await install(); }
    catch (error) {
      // The service's own daemon still runs the old definition. Stopping it only now keeps a refusal that lasts, such as
      // the service turned off in System Settings, from interrupting the bot at every launch.
      const inTheWay = error instanceof ServiceActionError && error.reportReason === 'replace-running';
      if (plan !== 'reinstall' || !running || !inTheWay) throw error;
      const failed = await stop();
      if (failed) return failed;
      await install();
    }
  } catch (error) { return `后台服务没能更新到这个位置的 Vonvon Bot：${messageOf(error)}`; }
  return undefined;
}
