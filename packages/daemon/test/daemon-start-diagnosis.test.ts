import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PidLockInfo } from '../src/server/pid-lock';

const fixture = vi.hoisted(() => {
  const forbid = (operation: string) => vi.fn((): never => {
    throw new Error(`Isolation violation: ${operation}`);
  });
  return {
    home: '/__vonvon_bug233_mock_home__',
    read: vi.fn<(home: string) => Promise<PidLockInfo | null>>(),
    verify: vi.fn<typeof import('../src/server/owner-verification').verifyPidLockOwner>(),
    forbidden: {
      spawn: forbid('child_process.spawn'),
      open: forbid('fs.promises.open'),
      readStartupRegistration: forbid('readStartupRegistration'),
      startRegisteredDaemon: forbid('startRegisteredDaemon'),
      readRecentLogs: forbid('readRecentLogs'),
      stopVerifiedOwner: forbid('stopVerifiedOwner'),
      getPidLockInfo: forbid('getPidLockInfo'),
      isPidLockOwnerRunning: forbid('isPidLockOwnerRunning'),
      kill: forbid('process.kill'),
    },
  };
});

// The crash store (macOS boot id) and the RPC client (status probe) import these too; neither may run here.
vi.mock('node:child_process', () => ({ spawn: fixture.forbidden.spawn, execFile: fixture.forbidden.spawn, execFileSync: fixture.forbidden.spawn }));
vi.mock('node:fs/promises', () => ({ open: fixture.forbidden.open }));
vi.mock('../src/config/paths', () => ({ paths: { appDir: fixture.home } }));
vi.mock('../src/core/logger', () => ({ readRecentLogs: fixture.forbidden.readRecentLogs }));
vi.mock('../src/server/pid-lock', () => ({
  readRunningPidLock: fixture.read,
  getPidLockInfo: fixture.forbidden.getPidLockInfo,
  isPidLockOwnerRunning: fixture.forbidden.isPidLockOwnerRunning,
  PidLockError: class PidLockError extends Error {},
}));
vi.mock('../src/server/owner-verification', () => ({
  verifyPidLockOwner: fixture.verify,
  stopVerifiedOwner: fixture.forbidden.stopVerifiedOwner,
}));
vi.mock('../src/service/startup', () => ({
  readStartupRegistration: fixture.forbidden.readStartupRegistration,
  startRegisteredDaemon: fixture.forbidden.startRegisteredDaemon,
}));

import { runStart } from '../src/cli/commands/daemon';

const readyLock = {
  pid: 42333,
  startedAt: '2026-10-13T00:00:00.000Z',
  listen: '127.0.0.1:42333',
  version: '0.7.0',
} satisfies PidLockInfo;

beforeEach(() => {
  vi.clearAllMocks();
  fixture.read.mockReset().mockImplementation(() => {
    throw new Error('Isolation violation: unexpected PID-lock read');
  });
  fixture.verify.mockReset().mockResolvedValue(undefined);
  vi.spyOn(process, 'kill').mockImplementation(fixture.forbidden.kill);
});

afterEach(() => {
  try {
    for (const [operation, mock] of Object.entries(fixture.forbidden)) {
      expect(mock, `${operation} must remain unused`).not.toHaveBeenCalled();
    }
    console.info('Isolation checks passed: no process, service, log, or filesystem operation.');
  } finally {
    vi.restoreAllMocks();
  }
});

it('returns the authenticated running owner when every read retains the ready lock', async () => {
  fixture.read.mockResolvedValue(readyLock);

  await expect(runStart(0)).resolves.toEqual({
    running: true,
    pid: 42333,
    listen: '127.0.0.1:42333',
    version: '0.7.0',
    startedAt: '2026-10-13T00:00:00.000Z',
  });
  expect(fixture.read.mock.calls).toEqual([[fixture.home], [fixture.home], [fixture.home]]);
  expect(fixture.verify).toHaveBeenCalledExactlyOnceWith(fixture.home, readyLock);
});

it('rejects lost readiness when the ready owner disappears before status', async () => {
  fixture.read
    .mockResolvedValueOnce(readyLock)
    .mockResolvedValueOnce(readyLock)
    .mockResolvedValueOnce(null);

  await expect(runStart(0)).rejects.toEqual(new Error('Daemon lost readiness before startup completed.'));

  expect(fixture.read.mock.calls).toEqual([[fixture.home], [fixture.home], [fixture.home]]);
  expect(fixture.verify).not.toHaveBeenCalled();
});
