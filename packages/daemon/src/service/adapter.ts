import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { paths } from '../config/paths';
import { runtimeDistribution, type Distribution } from './distribution';
import { serviceTarget } from './identity';
import { readDefinitionBytes, type Registration } from './registration';
import { serviceStderrPath, serviceStdoutPath, type ServiceState, type ServiceStatus } from './common';
import type { LaunchdTransactionOutcome } from './launchd';

export type { ServiceStatus };
export type ServiceTransactionOutcome = LaunchdTransactionOutcome;

export interface ServiceAdapter {
  install(options?: { port?: number }): Promise<ServiceTransactionOutcome>;
  uninstall(): Promise<ServiceTransactionOutcome>;
  status(): Promise<ServiceStatus>;
}

type Observed = {
  platformName: string;
  name: string;
  servicePath: string;
  registration: Registration;
  /** The manager's job or unit: absent, loaded and enabled with its PID, loaded but not enabled, or unknown. */
  manager: { kind: 'absent' } | { kind: 'enabled'; pid: number | null } | { kind: 'not-enabled' } | { kind: 'unknown'; detail: string };
  owner: { pid: number } | null;
  running: boolean;
  ownerError: string | null;
};

/** Folds what the definition, the manager and the data root's lock say into one state. Exported for tests. */
export function serviceStatus(o: Observed): ServiceStatus {
  const { registration: r, manager: m } = o;
  const state = ((): [ServiceState, string] => {
    if (m.kind === 'unknown') return ['unknown', `Cannot ask ${o.platformName}: ${m.detail}`];
    if (r.kind === 'unrecognized') return ['conflict', `The service definition is not in the format this version writes (${r.reason}). Run vonvon service install to rewrite it.`];
    if (r.kind === 'other-root') return ['conflict', `The service belongs to another data directory, ${r.recordedRoot}.`];
    if (o.ownerError !== null) return ['conflict', `Daemon PID ${o.owner?.pid} did not authenticate: ${o.ownerError}`];
    if (r.kind === 'absent') {
      if (m.kind !== 'absent') return ['conflict', 'An uninstall did not finish. Run vonvon service uninstall.'];
      return ['not-installed', o.running ? 'Not installed; a daemon started with vonvon daemon start is running. Run vonvon service install to hand it to the service.' : 'Not installed. Run vonvon service install.'];
    }
    if (m.kind === 'absent' || m.kind === 'not-enabled') {
      return ['disabled', o.platformName.startsWith('launchd')
        ? 'Turned off in System Settings > General > Login Items & Extensions (App Background Activity), or unloaded with launchctl. Turn it on there, or run vonvon service install.'
        : 'The unit is not enabled. Run vonvon service install.'];
    }
    if (o.running && o.owner !== null && m.pid === o.owner.pid) return ['running', 'Running under the service manager.'];
    if (o.running) return ['detached', `Daemon PID ${o.owner?.pid} was not started by the service manager. Run vonvon daemon stop, then vonvon daemon start.`];
    return ['stopped', 'Installed, not running. Run vonvon daemon start.'];
  })();
  return {
    platformName: o.platformName, state: state[0], detail: state[1],
    installed: r.kind !== 'absent', running: o.running,
    name: o.name, servicePath: o.servicePath,
    stdoutPath: serviceStdoutPath(), stderrPath: serviceStderrPath(),
    ...(o.running && o.owner ? { pid: String(o.owner.pid) } : {}),
  };
}

type Outcome = ServiceTransactionOutcome;
const result = (kind: Outcome['kind'], detail: string): Outcome => ({ kind, detail, retained: null, leftovers: [] });

async function rootExists(): Promise<boolean> {
  try { await stat(paths.appDir); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}

export function getServiceAdapter(): ServiceAdapter {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux') throw new Error(`The background service is not supported on ${platform}.`);
  const platformName = platform === 'darwin' ? 'launchd (macOS)' : 'systemd (Linux)';
  // Without a data directory nothing is resolved; the names still follow its path.
  const plannedTarget = () => serviceTarget(platform === 'darwin'
    ? { platform, home: homedir(), root: paths.appDir }
    : { platform, home: homedir(), root: paths.appDir, xdgConfigHome: process.env.XDG_CONFIG_HOME });
  const launchd = async (distribution?: Distribution) => (await import('./launchd')).createLaunchdService({ root: paths.appDir }, distribution ? { distribution: async () => distribution } : {});
  const systemd = async (distribution?: Distribution) => (await import('./systemd')).createSystemdService({ root: paths.appDir }, distribution ? { distribution: async () => distribution } : {});
  return {
    async install(options) {
      // Refuse a development checkout before creating the data directory the services resolve.
      const distribution = await runtimeDistribution();
      if (distribution.kind !== 'bundled' && distribution.kind !== 'global-npm') return result('install_refused', 'Distribution cannot install a service');
      await mkdir(paths.appDir, { recursive: true, mode: 0o700 });
      return (platform === 'darwin' ? await launchd(distribution) : await systemd(distribution)).install(options);
    },
    async uninstall() {
      if (!(await rootExists())) {
        const target = plannedTarget();
        if (await readDefinitionBytes(target) === null) return result('not-installed', `No data directory at ${paths.appDir}`);
        return result('uninstall_refused', `${target.platform === 'darwin' ? target.plistPath : target.unitPath} names ${paths.appDir}, which no longer exists. Remove the file by hand.`);
      }
      return (platform === 'darwin' ? await launchd() : await systemd()).uninstall();
    },
    async status() {
      if (!(await rootExists())) {
        const target = plannedTarget();
        const present = await readDefinitionBytes(target) !== null;
        return serviceStatus({
          platformName, name: target.platform === 'darwin' ? target.label : target.unitName, servicePath: target.platform === 'darwin' ? target.plistPath : target.unitPath,
          registration: present ? { kind: 'unrecognized', location: 'definition', reason: `its data directory ${paths.appDir} is missing` } : { kind: 'absent' },
          manager: { kind: 'absent' }, owner: null, running: false, ownerError: null,
        });
      }
      if (platform === 'darwin') {
        const status = await (await launchd()).status();
        const job = status.manager;
        return serviceStatus({
          platformName, name: status.target.label, servicePath: status.target.plistPath,
          registration: status.registration, owner: status.owner, running: status.running, ownerError: status.ownerError,
          manager: job.kind === 'loaded' ? { kind: 'enabled', pid: job.pid } : job,
        });
      }
      const status = await (await systemd()).status();
      const unit = status.manager;
      const manager: Observed['manager'] = unit.kind === 'unknown' ? unit
        : status.enabled.kind === 'unknown' ? { kind: 'unknown', detail: `is-enabled: ${status.enabled.detail}` }
        : unit.kind === 'absent' ? (status.enabled.kind === 'enabled' ? { kind: 'unknown', detail: 'enabled but not loaded' } : { kind: 'absent' })
        : status.enabled.kind === 'enabled' ? { kind: 'enabled', pid: unit.mainPid } : { kind: 'not-enabled' };
      return serviceStatus({
        platformName, name: status.target.unitName, servicePath: status.target.unitPath,
        registration: status.registration, owner: status.owner, running: status.running, ownerError: status.ownerError, manager,
      });
    },
  };
}
