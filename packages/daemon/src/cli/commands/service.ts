import type { ServiceAdapter } from '../../service/adapter';
import { SERVICE_UNAVAILABLE } from '../../host/service';
import { serviceStatusSchema } from '@vonvon/protocol';

export async function runServiceCommand(_action: 'install' | 'uninstall', _adapter?: Pick<ServiceAdapter, 'install' | 'uninstall'>): Promise<void> {
  throw new Error(SERVICE_UNAVAILABLE);
}

export async function runServiceStatus(json: boolean, adapter?: Pick<ServiceAdapter, 'status'>): Promise<void> {
  const service = adapter ?? (await import('../../service/adapter')).getServiceAdapter();
  const status = await service.status();
  const wire = serviceStatusSchema.parse(status);
  if (json) {
    process.stdout.write(`${JSON.stringify(wire)}\n`);
    return;
  }
  const running = status.running ? `running PID ${status.pid}` : 'not running';
  process.stdout.write(`${status.platformName}: ${status.installed ? 'registered' : 'not registered'}, ${running}\n`);
  process.stdout.write(`Definition: ${status.servicePath}\n`);
  process.stdout.write(`Logs: ${status.stdoutPath}, ${status.stderrPath}\n`);
  process.stderr.write(`${status.raw}\n`);
}
