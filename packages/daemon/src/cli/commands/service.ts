import type { ServiceAdapter } from '../../service/adapter';
import { serviceStatusSchema } from '@vonvon/protocol';

export async function runServiceCommand(action: 'install' | 'uninstall', adapter?: Pick<ServiceAdapter, 'install' | 'uninstall'>, options: { port?: number } = {}): Promise<void> {
  const service = adapter ?? (await import('../../service/adapter')).getServiceAdapter();
  const result = action === 'install' ? await service.install(options) : await service.uninstall();
  const diagnostics = [`${result.kind}: ${result.detail}`];
  if (result.retained !== null) diagnostics.push(`Retained PID ${result.retained.pid} (startedAt ${result.retained.startedAt}).`);
  for (const leftover of result.leftovers) diagnostics.push(`Leftover: ${leftover}`);
  const kind = result.kind;
  switch (kind) {
    case 'installed':
    case 'already-installed':
    case 'uninstalled':
    case 'not-installed':
      process.stdout.write(`${diagnostics.join('\n')}\n`);
      return;
    case 'install_refused':
    case 'install_rolled_back':
    case 'install_incomplete':
    case 'uninstall_refused':
    case 'uninstall_rolled_back':
    case 'uninstall_incomplete':
      if (result.detail.includes('stop_unconfirmed')) diagnostics.push('Next step: vonvon service uninstall');
      throw new Error(diagnostics.join('\n'));
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown service result: ${exhaustive}`);
    }
  }
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
