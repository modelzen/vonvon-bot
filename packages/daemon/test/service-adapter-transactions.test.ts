import { afterEach, expect, it, vi } from 'vitest';
import { getServiceAdapter, type ServiceTransactionOutcome } from '../src/service/adapter';

const fixture = vi.hoisted(() => ({
  install: vi.fn(), uninstall: vi.fn(), status: vi.fn(), start: vi.fn(),
  launchd: vi.fn(), systemd: vi.fn(), windows: vi.fn(),
}));
vi.mock('../src/config/paths', () => ({ paths: { appDir: '/fixture/vonvon' } }));
vi.mock('../src/service/launchd', () => ({ createLaunchdService: fixture.launchd }));
vi.mock('../src/service/systemd', () => ({ createSystemdService: fixture.systemd }));
vi.mock('../src/service/windows', () => ({ createWindowsService: fixture.windows }));
vi.mock('../src/service/win-startup', () => ({ readVonvonRunValue: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it.each(['darwin', 'linux', 'win32'] satisfies NodeJS.Platform[])('%s public mutations preserve transaction outcomes without manager/status follow-up', async platform => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  const transaction = { install: fixture.install, uninstall: fixture.uninstall, status: fixture.status, start: fixture.start };
  const factory = platform === 'darwin' ? fixture.launchd : platform === 'linux' ? fixture.systemd : fixture.windows;
  factory.mockReturnValue(transaction);
  const result: ServiceTransactionOutcome = { kind: 'uninstalled', detail: 'Uninstalled', retained: { pid: 42, startedAt: 'same-owner' }, leftovers: [] };
  fixture.uninstall.mockResolvedValue(result);
  const adapter = getServiceAdapter();
  expect(await adapter.uninstall()).toBe(result);
  expect(factory).toHaveBeenCalledWith({ root: '/fixture/vonvon' });
  expect(fixture.uninstall).toHaveBeenCalledOnce();
  expect(fixture.status).not.toHaveBeenCalled();
  expect(fixture.start).not.toHaveBeenCalled();

  const refused: ServiceTransactionOutcome = { kind: 'install_refused', detail: 'Other root', retained: null, leftovers: [] };
  fixture.install.mockResolvedValue(refused);
  expect(await adapter.install({ port: 23456 })).toBe(refused);
  expect(fixture.install).toHaveBeenCalledWith({ port: 23456 });
  expect(fixture.status).not.toHaveBeenCalled();
  expect(fixture.start).not.toHaveBeenCalled();
});

it.each(['darwin', 'linux', 'win32'] satisfies NodeJS.Platform[])('%s legacy adapter restart stays refused', async platform => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  await expect(getServiceAdapter().restart()).rejects.toThrow('cannot manage an OS service');
  expect(fixture.launchd).not.toHaveBeenCalled();
  expect(fixture.systemd).not.toHaveBeenCalled();
  expect(fixture.windows).not.toHaveBeenCalled();
});
