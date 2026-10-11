import type { ServiceStatus } from './common';
import { SERVICE_UNAVAILABLE } from '../host/service';
import {
  installWinStartup,
  restartWinStartup,
  statusWinStartup,
  uninstallWinStartup,
  winStartupRunning,
} from './win-startup';
import { tailServiceLogs } from './common';

export type { ServiceStatus };

export interface ServiceAdapter {
  install(): Promise<ServiceStatus>;
  uninstall(): Promise<void>;
  status(): Promise<ServiceStatus>;
  restart(): Promise<ServiceStatus>;
  logs(follow: boolean): Promise<void>;
}

export function getServiceAdapter(): ServiceAdapter {
  if (process.platform === 'darwin') {
    const refused = async (): Promise<never> => { throw new Error(SERVICE_UNAVAILABLE); };
    return { install: refused, uninstall: refused, status: refused, restart: refused, logs: tailServiceLogs };
  }

  if (process.platform === 'win32') {
    return {
      install: installWinStartup,
      uninstall: uninstallWinStartup,
      status: async () => statusWinStartup(),
      restart: restartWinStartup,
      logs: tailServiceLogs,
    };
  }

  if (process.platform === 'linux') {
    const refused = async (): Promise<never> => { throw new Error(SERVICE_UNAVAILABLE); };
    return { install: refused, uninstall: refused, status: refused, restart: refused, logs: tailServiceLogs };
  }

  throw new Error(
    'service：当前平台暂不支持后台服务（仅 macOS launchd / Windows 计划任务 / Linux systemd）。' +
      '请用 `feishu-codex-bridge run` 前台运行。',
  );
}

/**
 * Sync check: is the OS background service currently running? Used by the update
 * flow to decide whether to restart the daemon. Returns false on platforms
 * without a service implementation (where there's nothing to restart).
 */
export function isServiceRunning(): boolean {
  try {
    if (process.platform === 'darwin') return false;
    if (process.platform === 'win32') return winStartupRunning();
    if (process.platform === 'linux') return false;
  } catch {
    /* service manager unavailable → treat as not running */
  }
  return false;
}
