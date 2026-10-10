import type { DaemonControlAction } from '../../admin/host';
import { SERVICE_UNAVAILABLE } from '../../host/service';

export function spawnDaemonControl(_action: DaemonControlAction): void {
  throw new Error(SERVICE_UNAVAILABLE);
}

export async function runDaemonControl(_action: string): Promise<void> {
  throw new Error(SERVICE_UNAVAILABLE);
}
