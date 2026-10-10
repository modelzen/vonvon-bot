import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PidLockInfo } from '../src/server/pid-lock';

const fixture = vi.hoisted(() => ({
  lock: null as PidLockInfo | null,
  alive: new Set<number>(),
  stop: vi.fn(async () => {}),
  signals: vi.fn(),
}));

vi.mock('../src/server/pid-lock', () => ({
  readRunningPidLock: async () => fixture.lock && fixture.alive.has(fixture.lock.pid) ? fixture.lock : null,
  getPidLockInfo: async () => fixture.lock,
  isPidLockOwnerRunning: (lock: PidLockInfo | null) => lock !== null && fixture.alive.has(lock.pid),
}));
vi.mock('../src/server/owner-verification', () => ({ stopVerifiedOwner: fixture.stop, verifyPidLockOwner: vi.fn() }));
vi.mock('../src/config/paths', () => ({ paths: { appDir: '/virtual/vonvon-stop' } }));

import { runStop } from '../src/cli/commands/daemon';

const owner = { pid: 74321, startedAt: '2026-10-10T00:00:00.000Z', listen: '127.0.0.1:43119' } satisfies PidLockInfo;
const replacement = { pid: 74322, startedAt: '2026-10-10T00:01:00.000Z', listen: '127.0.0.1:43119' } satisfies PidLockInfo;

beforeEach(() => {
  vi.useFakeTimers();
  fixture.lock = owner;
  fixture.alive.clear();
  fixture.alive.add(owner.pid);
  fixture.stop.mockClear();
  fixture.signals.mockClear();
  vi.spyOn(process, 'kill').mockImplementation(fixture.signals);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('rejects with cleanup uncertainty once an acknowledged owner dies but retains its lock', async () => {
  const result = runStop('/virtual/vonvon-stop');
  const outcome = { rejected: false, error: new Error('pending') };
  void result.then(() => {}, (error: unknown) => {
    outcome.rejected = true;
    outcome.error = error instanceof Error ? error : new Error(String(error));
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(fixture.stop).toHaveBeenCalledOnce();
  fixture.alive.delete(owner.pid);
  await vi.advanceTimersByTimeAsync(500);
  expect(outcome.rejected).toBe(true);
  if (outcome.rejected) expect(String(outcome.error)).toMatch(/cleanup|release|lock|unconfirm/i);
  expect(fixture.lock).toEqual(owner);
  expect(fixture.signals).not.toHaveBeenCalled();
});

it('returns true after the acknowledged owner dies and removes its lock', async () => {
  const result = runStop('/virtual/vonvon-stop');
  await vi.advanceTimersByTimeAsync(100);
  fixture.alive.delete(owner.pid);
  fixture.lock = null;
  await vi.advanceTimersByTimeAsync(100);
  await expect(result).resolves.toBe(true);
  expect(fixture.stop).toHaveBeenCalledOnce();
  expect(fixture.signals).not.toHaveBeenCalled();
});

it('rejects a live replacement after the acknowledged owner exits', async () => {
  const result = runStop('/virtual/vonvon-stop');
  const rejection = expect(result).rejects.toThrow(String(replacement.pid));
  await vi.advanceTimersByTimeAsync(100);
  fixture.alive.delete(owner.pid);
  fixture.lock = replacement;
  fixture.alive.add(replacement.pid);
  await vi.advanceTimersByTimeAsync(100);
  await rejection;
  expect(fixture.stop).toHaveBeenCalledOnce();
  expect(fixture.signals).not.toHaveBeenCalled();
});

it('does not signal a lock whose owner cannot authenticate', async () => {
  fixture.stop.mockRejectedValueOnce(new Error('Cannot verify daemon owner'));
  await expect(runStop('/virtual/vonvon-stop')).rejects.toThrow('Cannot verify daemon owner');
  expect(fixture.signals).not.toHaveBeenCalled();
});
