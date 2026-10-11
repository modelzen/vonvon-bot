import { homedir } from 'node:os';
import { lstat } from 'node:fs/promises';
import { paths } from '../config/paths';
import { SERVICE_UNAVAILABLE } from '../host/service';
import { readRunningPidLock } from '../server/pid-lock';
import { verifyPidLockOwner } from '../server/owner-verification';
import { readRegistration, type Registration } from './registration';
import { serviceStderrPath, serviceStdoutPath, tailServiceLogs, type ServiceStatus } from './common';
import { resolveServiceRoot, serviceTarget, WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE } from './identity';
import { readVonvonRunValue } from './win-startup';
import type { createLaunchdService } from './launchd';

export type { ServiceStatus };
export type ServiceTransactionOutcome = Awaited<ReturnType<ReturnType<typeof createLaunchdService>['install']>>;

export interface ServiceAdapter {
  install(options?: { port?: number }): Promise<ServiceTransactionOutcome>;
  uninstall(): Promise<ServiceTransactionOutcome>;
  status(): Promise<ServiceStatus>;
  restart(): Promise<ServiceStatus>;
  logs(follow: boolean): Promise<void>;
}

function registrationDetail(registration: Registration): string {
  switch (registration.kind) {
    case 'absent': return 'No Vonvon service registration.';
    case 'ours': return 'Vonvon service registration belongs to this data root.';
    case 'other-root': return `Vonvon service registration belongs to ${registration.recordedRoot}.`;
    case 'unrecognized': return `Unrecognized Vonvon service registration ${registration.location}: ${registration.reason}`;
  }
}

function statusFields(platformName: string, servicePath: string, registration: Registration, managerPid: number | null, ownerPid: number | null, diagnostic: string): ServiceStatus {
  const running = registration.kind === 'ours' && managerPid !== null && managerPid === ownerPid;
  return {
    platformName,
    installed: registration.kind !== 'absent',
    running,
    servicePath,
    stdoutPath: serviceStdoutPath(),
    stderrPath: serviceStderrPath(),
    ...(running ? { pid: String(managerPid) } : {}),
    raw: `${registrationDetail(registration)} ${diagnostic}`.trim(),
  };
}

async function launcherLeftovers(files: string[]): Promise<string> {
  const present: string[] = [];
  for (const path of files) {
    try { await lstat(path); present.push(path); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return present.length ? `Leftover launcher files: ${present.join(', ')}.` : 'No leftover launcher files.';
}

export function getServiceAdapter(): ServiceAdapter {
  const refused = async (): Promise<never> => { throw new Error(SERVICE_UNAVAILABLE); };
  if (process.platform === 'darwin') {
    return {
      async install(options) {
        const { createLaunchdService } = await import('./launchd');
        return createLaunchdService({ root: paths.appDir }).install(options);
      },
      async uninstall() {
        const { createLaunchdService } = await import('./launchd');
        return createLaunchdService({ root: paths.appDir }).uninstall();
      },
      restart: refused, logs: tailServiceLogs,
      async status() {
        const { createLaunchdService } = await import('./launchd');
        const result = await createLaunchdService({ root: paths.appDir }).status();
        if (result.registration.kind === 'other-root' || result.registration.kind === 'unrecognized') throw new Error(registrationDetail(result.registration));
        const target = serviceTarget({ platform: 'darwin', home: homedir() });
        if (target.platform !== 'darwin') throw new Error('Invalid launchd target');
        if (result.manager.kind === 'unknown') throw new Error(`launchd query failed: ${result.manager.detail}`);
        const managerPid = result.manager.kind === 'loaded' ? result.manager.pid : null;
        const diagnostic = `launchd job ${result.manager.kind}${managerPid === null ? '' : ` PID ${managerPid}`}; ${result.running ? 'verified' : 'unverified'} data-root owner${result.owner === null ? ' absent' : ` PID ${result.owner.pid}`}.`;
        return statusFields('launchd (macOS)', target.plistPath, result.registration, managerPid, result.running ? result.owner?.pid ?? null : null, diagnostic);
      },
    };
  }
  if (process.platform === 'win32') {
    return {
      async install(options) {
        const { createWindowsService } = await import('./windows');
        return createWindowsService({ root: paths.appDir }).install(options);
      },
      async uninstall() {
        const { createWindowsService } = await import('./windows');
        return createWindowsService({ root: paths.appDir }).uninstall();
      },
      async status() {
        const root = await resolveServiceRoot(paths.appDir);
        const target = serviceTarget({ platform: 'win32', root });
        if (target.platform !== 'win32') throw new Error('Invalid Windows service target');
        const windowsRun = readVonvonRunValue();
        const registration = await readRegistration({ target, requestedRoot: root, windowsRun });
        if (registration.kind === 'other-root' || registration.kind === 'unrecognized') throw new Error(registrationDetail(registration));
        const owner = await readRunningPidLock(root);
        let verified: number | null = null;
        if (registration.kind === 'ours' && owner?.listen) {
          await verifyPidLockOwner(root, owner);
          verified = owner.pid;
        }
        const leftovers = registration.kind === 'absent' ? await launcherLeftovers([target.vbsPath, target.cmdPath]) : '';
        const diagnostic = `${verified === null ? 'No verified data-root owner.' : `Verified data-root owner PID ${verified}.`} ${leftovers}`;
        return statusFields('Windows login startup (HKCU Run)', `${WINDOWS_RUN_KEY}\\${WINDOWS_RUN_VALUE}`, registration, verified, verified, diagnostic);
      },
      restart: refused,
      logs: tailServiceLogs,
    };
  }
  if (process.platform === 'linux') {
    return {
      async install(options) {
        const { createSystemdService } = await import('./systemd');
        return createSystemdService({ root: paths.appDir }).install(options);
      },
      async uninstall() {
        const { createSystemdService } = await import('./systemd');
        return createSystemdService({ root: paths.appDir }).uninstall();
      },
      restart: refused, logs: tailServiceLogs,
      async status() {
        const { createSystemdService } = await import('./systemd');
        const result = await createSystemdService({ root: paths.appDir }).status();
        if (result.registration.kind === 'other-root' || result.registration.kind === 'unrecognized') throw new Error(registrationDetail(result.registration));
        const target = serviceTarget({ platform: 'linux', home: homedir(), xdgConfigHome: process.env.XDG_CONFIG_HOME });
        if (target.platform !== 'linux') throw new Error('Invalid systemd target');
        if (result.manager.kind === 'unknown') throw new Error(`systemd query failed: ${result.manager.detail}`);
        if (result.enabled.kind === 'unknown') throw new Error(`is-enabled query failed: ${result.enabled.detail}`);
        if (result.manager.kind === 'present' && result.manager.fragmentPath !== target.unitPath) {
          throw new Error(`systemd unexpected unit path: ${result.manager.fragmentPath}`);
        }
        const managerPid = result.manager.kind === 'present' ? result.manager.mainPid : null;
        const managerDiagnostic = result.manager.kind === 'present' ? `systemd unit ${result.manager.loadState} at ${result.manager.fragmentPath}, PID ${result.manager.mainPid ?? 'none'}.`
            : 'systemd unit absent.';
        const enabledDiagnostic = result.enabled.kind === 'enabled' ? 'Enabled.' : `Not enabled (${result.enabled.state}).`;
        const ownerDiagnostic = `${result.running ? 'Verified' : 'Unverified'} data-root owner${result.owner === null ? ' absent' : ` PID ${result.owner.pid}`}.`;
        return statusFields('systemd (Linux)', target.unitPath, result.registration, managerPid, result.running ? result.owner?.pid ?? null : null, `${managerDiagnostic} ${enabledDiagnostic} ${ownerDiagnostic}`);
      },
    };
  }
  throw new Error(`service: unsupported platform ${process.platform}.`);
}
