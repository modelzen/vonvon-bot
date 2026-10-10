import { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../src/platform/spawn', () => ({ spawnProcess: f.spawn }));
vi.mock('../src/service/distribution', () => ({ runtimeDistribution: async () => ({ kind: 'global-npm' }) }));
import { installLatest, latestVersion } from '../src/service/update';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function heldChild() {
  const child = new ChildProcess(); Object.defineProperty(child, 'pid', { value: 76543 });
  child.kill = vi.fn(() => true); f.spawn.mockReturnValue(child);
  return child;
}
it('a postbirth npm error retains update installation until physical child close', async () => {
  const child = heldChild(); let settled = false;
  const done = installLatest().then(result => { settled = true; return result; });
  await Promise.resolve();
  child.emit('error', new Error('fixture IPC error'));
  await Promise.resolve(); expect(settled).toBe(false);
  child.emit('close', 1, null);
  expect(await done).toEqual({ ok: false, message: 'fixture IPC error' });
});
it('a failed npm spawn with no child can settle without an exit', async () => {
  const child = new ChildProcess(); f.spawn.mockReturnValue(child);
  const done = installLatest(); await Promise.resolve();
  child.emit('error', new Error('ENOENT'));
  expect(await done).toEqual({ ok: false, message: 'ENOENT' });
});
it('a registry query deadline requests termination but keeps ownership until close', async () => {
  vi.useFakeTimers(); const child = heldChild(); let settled = false;
  const done = latestVersion().then(result => { settled = true; return result; });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(child.kill).toHaveBeenCalledTimes(1); expect(settled).toBe(false);
  child.emit('close', 0, null);
  expect(await done).toBeNull();
});
