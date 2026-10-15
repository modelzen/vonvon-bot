import { expect, it, vi } from 'vitest';
import { controlDesktopService, SERVICE_UNAVAILABLE } from '../src/host/service';

it('status reads the service adapter', async () => {
  const status = { platformName: 'systemd (Linux)', state: 'stopped', installed: true, running: false, name: 'vonvon-bot.service', servicePath: '/u', stdoutPath: '/o', stderrPath: '/e', detail: 'd' } as const;
  expect(await controlDesktopService('status', { status: async () => status })).toEqual({ supported: true, ...status });
});
it('a status that cannot be read is unknown, not an error', async () => {
  expect(await controlDesktopService('status', { status: async () => { throw new Error('no bus'); } })).toMatchObject({ supported: true, installed: false, running: false, state: 'unknown', detail: 'no bus' });
});
it.each(['install', 'start', 'stop', 'uninstall', 'restart; rm'])('refuses desktop service %s without adapter or inspection calls', async action => {
  const adapter = { status: vi.fn() }; const inspect = vi.fn();
  await expect(controlDesktopService(action, adapter, inspect)).rejects.toThrow(SERVICE_UNAVAILABLE);
  expect(inspect).not.toHaveBeenCalled(); expect(adapter.status).not.toHaveBeenCalled();
});
