import type { ServiceAdapter, ServiceStatus } from '../service/adapter';
import type { HostInspection } from './client';

export const SERVICE_UNAVAILABLE = 'Vonvon Bot cannot manage the OS service from here. Use vonvon service install, vonvon service uninstall, vonvon daemon start and vonvon daemon stop.';

export type DesktopServiceStatus = Partial<ServiceStatus> & Pick<ServiceStatus, 'installed' | 'running'> & { supported: boolean };

/** Only `status` is served: installing and removing the service goes through the CLI (s08 wires the desktop to it). */
export async function controlDesktopService(action: string, adapter?: Pick<ServiceAdapter, 'status'>, _inspect?: () => Promise<HostInspection>): Promise<DesktopServiceStatus> {
  if (action !== 'status') throw new Error(SERVICE_UNAVAILABLE);
  if (!adapter && process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') return { supported: false, installed: false, running: false };
  try {
    return { supported: true, ...await (adapter ?? (await import('../service/adapter')).getServiceAdapter()).status() };
  } catch (error) {
    return { supported: true, installed: false, running: false, state: 'unknown', detail: error instanceof Error ? error.message : String(error) };
  }
}
