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

import { RELEASED_EXIT_GRACE_MS, runStop } from '../src/cli/commands/daemon';

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
  const diagnostics: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { diagnostics.push(String(chunk)); return true; });
  const original = JSON.stringify(fixture.lock);
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
  if (outcome.rejected) expect(outcome.error.message).toBe(`Daemon ${owner.pid} exited without releasing daemon.pid. Cleanup was not confirmed; see vonvon daemon logs.`);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(diagnostics.filter(line => /Waiting for daemon/.test(line))).toHaveLength(0);
  expect(JSON.stringify(fixture.lock)).toBe(original);
  expect(fixture.signals).not.toHaveBeenCalled();
});

it('succeeds when the acknowledged owner dies and a different dead owner is named by the lock', async () => {
  const result = runStop('/virtual/vonvon-stop');
  await vi.advanceTimersByTimeAsync(100);
  fixture.alive.delete(owner.pid);
  fixture.lock = replacement;
  await vi.advanceTimersByTimeAsync(100);
  await expect(result).resolves.toBe(true);
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

it('returns true when the owner released its lock but its PID stays, as a zombie under a parent that does not reap it', async () => {
  let done = false;
  const result = runStop('/virtual/vonvon-stop').then(value => { done = true; return value; });
  await vi.advanceTimersByTimeAsync(100);
  fixture.lock = null;
  await vi.advanceTimersByTimeAsync(RELEASED_EXIT_GRACE_MS - 500);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(result).resolves.toBe(true);
  expect(fixture.signals).not.toHaveBeenCalled();
});

it('keeps waiting while the owner still holds its lock', async () => {
  let done = false;
  void runStop('/virtual/vonvon-stop').then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(RELEASED_EXIT_GRACE_MS * 4);
  expect(done).toBe(false);
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
