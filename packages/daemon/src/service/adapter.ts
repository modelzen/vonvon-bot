import { homedir } from 'node:os';
import { paths } from '../config/paths';
import { SERVICE_UNAVAILABLE } from '../host/service';
import type { Registration } from './registration';
import { serviceStderrPath, serviceStdoutPath, tailServiceLogs, type ServiceStatus } from './common';
import { serviceTarget } from './identity';
import { installWinStartup, restartWinStartup, uninstallWinStartup, winStartupRunning } from './win-startup';

export type { ServiceStatus };

export interface ServiceAdapter {
  install(): Promise<ServiceStatus>;
  uninstall(): Promise<void>;
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

export function getServiceAdapter(): ServiceAdapter {
  const refused = async (): Promise<never> => { throw new Error(SERVICE_UNAVAILABLE); };
  if (process.platform === 'darwin') {
    return {
      install: refused, uninstall: refused, restart: refused, logs: tailServiceLogs,
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
      install: installWinStartup,
      uninstall: uninstallWinStartup,
      status: async () => { throw new Error('Vonvon Windows service status is unavailable until the Run registration reader is integrated.'); },
      restart: restartWinStartup,
      logs: tailServiceLogs,
    };
  }
  if (process.platform === 'linux') {
    return {
      install: refused, uninstall: refused, restart: refused, logs: tailServiceLogs,
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

export function isServiceRunning(): boolean {
  try {
    if (process.platform === 'win32') return winStartupRunning();
  } catch {}
  return false;
}
