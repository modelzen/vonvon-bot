import type { ServiceAdapter } from '../service/adapter';
import type { ServiceStatus } from '../service/common';
import type { HostInspection } from './client';

export const SERVICE_UNAVAILABLE = 'Vonvon Bot cannot manage an OS service in this version. Use vonvon daemon start and vonvon daemon stop.';

export async function controlDesktopService(action: string, adapter?: ServiceAdapter, _inspect?: () => Promise<HostInspection>): Promise<Partial<ServiceStatus> & Pick<ServiceStatus, 'installed' | 'running'> & { supported: boolean }> {
  if (action === 'status') {
    const status = await (adapter ?? (await import('../service/adapter')).getServiceAdapter()).status();
    return { supported: true, ...status };
  }
  throw new Error(SERVICE_UNAVAILABLE);
}
