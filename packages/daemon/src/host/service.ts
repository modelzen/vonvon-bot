import type { ServiceAdapter } from '../service/adapter';
import type { HostInspection } from './client';

export const SERVICE_UNAVAILABLE = 'Vonvon Bot cannot manage an OS service in this version. Use vonvon daemon start and vonvon daemon stop.';

export async function controlDesktopService(action: string, adapter?: ServiceAdapter, _inspect?: () => Promise<HostInspection>) {
  if (action === 'status') {
    if (process.platform === 'win32') return { supported: false, installed: false, running: false };
    const status = await (adapter ?? (await import('../service/adapter')).getServiceAdapter()).status();
    if (/query failed|unexpected unit path|Unrecognized Vonvon service registration|registration belongs to (?!this data root)/.test(status.raw)) {
      throw new Error(status.raw);
    }
    return { supported: true, ...status };
  }
  throw new Error(SERVICE_UNAVAILABLE);
}
