import { expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ adapter: vi.fn(), spawn: vi.fn() }));
vi.mock('../src/service/adapter', () => ({ getServiceAdapter: f.adapter }));
vi.mock('../src/platform/spawn', () => ({ spawnProcess: f.spawn }));
import { runDaemonControl, spawnDaemonControl } from '../src/cli/commands/daemon-control';
import { SERVICE_UNAVAILABLE } from '../src/host/service';

it.each(['start', 'stop', 'restart', 'update', 'unknown'])('hidden control %s refuses without adapter or helper access', async action => {
  await expect(runDaemonControl(action)).rejects.toThrow(SERVICE_UNAVAILABLE);
  expect(f.adapter).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});
it.each(['start', 'stop', 'restart', 'update'] as const)('legacy helper spawn %s refuses synchronously', action => {
  expect(() => spawnDaemonControl(action)).toThrow(SERVICE_UNAVAILABLE);
  expect(f.adapter).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});
