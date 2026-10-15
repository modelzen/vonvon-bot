import type { ServiceAdapter } from '../../service/adapter';

const STATE_TEXT = {
  'not-installed': 'not installed', running: 'running', stopped: 'installed, stopped', disabled: 'turned off',
  detached: 'installed, daemon running outside the service', conflict: 'needs attention', unknown: 'unknown',
} as const;

/** Prints the outcome; anything but a completed install or uninstall exits 1 with the detail and leftovers. */
export async function runServiceCommand(action: 'install' | 'uninstall', adapter?: Pick<ServiceAdapter, 'install' | 'uninstall'>, options: { port?: number } = {}): Promise<void> {
  const service = adapter ?? (await import('../../service/adapter')).getServiceAdapter();
  const result = action === 'install' ? await service.install(options) : await service.uninstall();
  const lines = [`${result.kind}: ${result.detail}`];
  if (result.retained !== null) lines.push(`Daemon PID ${result.retained.pid} is still running.`);
  for (const leftover of result.leftovers) lines.push(`Left behind: ${leftover}`);
  switch (result.kind) {
    case 'installed':
    case 'already-installed':
    case 'uninstalled':
    case 'not-installed':
      process.stdout.write(`${lines.join('\n')}\n`);
      return;
    case 'install_refused':
    case 'install_rolled_back':
    case 'install_incomplete':
    case 'uninstall_refused':
    case 'uninstall_rolled_back':
    case 'uninstall_incomplete':
      if (result.detail.includes('stop_unconfirmed')) lines.push('Next step: vonvon service uninstall');
      throw new Error(lines.join('\n'));
    default: {
      const exhaustive: never = result.kind;
      throw new Error(`Unknown service result: ${String(exhaustive)}`);
    }
  }
}

export async function runServiceStatus(json: boolean, adapter?: Pick<ServiceAdapter, 'status'>): Promise<void> {
  const status = await (adapter ?? (await import('../../service/adapter')).getServiceAdapter()).status();
  if (json) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  process.stdout.write([
    `${status.platformName} ${status.name}: ${STATE_TEXT[status.state]}${status.running && status.pid ? ` (PID ${status.pid})` : ''}`,
    status.detail,
    `Definition: ${status.servicePath}`,
    `Logs: ${status.stdoutPath}, ${status.stderrPath}`,
  ].join('\n') + '\n');
}
