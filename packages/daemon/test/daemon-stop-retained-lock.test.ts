import { ChildProcess } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import type { PidLockInfo } from '../src/server/pid-lock';

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(),
  stop: vi.fn(async (_home: string, _lock: PidLockInfo) => {}),
  verify: vi.fn(async () => {}),
  alive: new Set<number>(),
}));

vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: fixture.spawn,
}));
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { paths: { appDir: mkdtempSync(join(tmpdir(), 'vonvon-retained-stop-')) } };
});
vi.mock('../src/service/startup', () => ({ readStartupRegistration: async () => ({ kind: 'absent' }), startRegisteredDaemon: async () => { throw new Error('unexpected service start'); } }));
vi.mock('../src/server/owner-verification', () => ({
  stopVerifiedOwner: fixture.stop,
  verifyPidLockOwner: fixture.verify,
}));
vi.mock('../src/config/data-access', async original => ({
  ...await original<typeof import('../src/config/data-access')>(),
  enterDataAccess: async () => ({ release() {} }),
}));

import { paths } from '../src/config/paths';
import { runStart, runStop } from '../src/cli/commands/daemon';
import { acquirePidLock, getPidLockInfo, publishPidLock } from '../src/server/pid-lock';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fixture.alive.clear();
});
afterAll(async () => { await rm(paths.appDir, { recursive: true, force: true }); });

it('retains exact lock bytes when an acknowledged stop loses its owner, then replaces that lock on start', async () => {
  const oldOwner = {
    pid: 74321,
    startedAt: new Date().toISOString(),
    listen: '127.0.0.1:43119',
  } satisfies PidLockInfo;
  const lockFile = join(paths.appDir, 'daemon.pid');
  const originalBytes = Buffer.from(` {\n  "extra": "preserve these bytes",\n  "listen": "${oldOwner.listen}",\n  "startedAt": "${oldOwner.startedAt}",\n  "pid": ${oldOwner.pid}\n}\n`);
  await writeFile(lockFile, originalBytes);
  fixture.alive.add(oldOwner.pid);

  const probes: Array<[number, string | number | undefined]> = [];
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    probes.push([pid, signal]);
    if (signal !== 0) throw new Error('test attempted to send an OS signal');
    if (fixture.alive.has(pid)) return true;
    throw Object.assign(new Error('simulated process exit'), { code: 'ESRCH' });
  });
  const diagnostics: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { diagnostics.push(String(chunk)); return true; });
  fixture.stop.mockImplementationOnce(async (home, lock) => {
    expect(home).toBe(paths.appDir);
    expect(lock).toEqual(oldOwner);
    expect(await readFile(lockFile)).toEqual(originalBytes);
    fixture.alive.delete(oldOwner.pid);
  });

  await expect(runStop(paths.appDir)).rejects.toThrow(
    `Daemon ${oldOwner.pid} exited without releasing daemon.pid. Cleanup was not confirmed; see vonvon daemon logs.`,
  );
  expect(fixture.stop).toHaveBeenCalledOnce();
  expect(await readFile(lockFile)).toEqual(originalBytes);
  expect(diagnostics).toEqual([]);
  expect(probes.every(([, signal]) => signal === 0)).toBe(true);
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(diagnostics).toEqual([]);
  expect(await readFile(lockFile)).toEqual(originalBytes);
  vi.useRealTimers();

  fixture.alive.add(oldOwner.pid);
  fixture.stop.mockImplementationOnce(async () => { fixture.alive.delete(oldOwner.pid); });
  const errors: unknown[] = [];
  const exits: number[] = [];
  vi.spyOn(console, 'error').mockImplementation(error => { errors.push(error); });
  const cliProcess = Object.create(process);
  Object.defineProperties(cliProcess, {
    argv: { value: [process.execPath, '/owned/fixture/vonvon.mjs', 'daemon', 'stop'] },
    exit: { value: (code: number) => { exits.push(code); } },
  });
  vi.stubGlobal('process', cliProcess);
  try {
    await import('../src/cli/index');
    await vi.waitFor(() => expect(exits).toEqual([1]));
    expect(errors).toEqual([`Daemon ${oldOwner.pid} exited without releasing daemon.pid. Cleanup was not confirmed; see vonvon daemon logs.`]);
    expect(await readFile(lockFile)).toEqual(originalBytes);
    expect(diagnostics).toEqual([]);
  } finally { vi.unstubAllGlobals(); }

  const originalEntry = process.argv[1];
  process.argv[1] = '/owned/fixture/vonvon.mjs';
  let published: Promise<void> | undefined;
  try {
    fixture.spawn.mockImplementation(() => {
      const shell = new ChildProcess();
      Object.defineProperty(shell, 'pid', { value: process.pid });
      shell.unref = vi.fn();
      published = (async () => {
        const replacement = await acquirePidLock(paths.appDir);
        await publishPidLock(paths.appDir, replacement, oldOwner.listen);
        fixture.alive.add(replacement.pid);
      })();
      return shell;
    });
    const started = await runStart(43119);
    await published;
    expect(fixture.spawn).toHaveBeenCalledOnce();
    expect(started).toMatchObject({ running: true, pid: process.pid, listen: oldOwner.listen });
    expect(await getPidLockInfo(paths.appDir)).toMatchObject({ pid: process.pid, listen: oldOwner.listen });
    expect((await getPidLockInfo(paths.appDir))?.startedAt).not.toBe(oldOwner.startedAt);
    expect(await readFile(lockFile)).not.toEqual(originalBytes);
    expect(diagnostics).toEqual([]);
    expect(probes.every(([, signal]) => signal === 0)).toBe(true);
  } finally {
    if (originalEntry === undefined) delete process.argv[1];
    else process.argv[1] = originalEntry;
  }
});

// main 必败 (#667 Windows CI): the daemon released daemon.pid and exited between stop's read of the lock and its liveness
// check, and stop said it had exited without releasing daemon.pid.
it('counts a daemon that released its lock and exited between the two looks as stopped', async () => {
  const owner = { pid: 74322, startedAt: new Date().toISOString(), listen: '127.0.0.1:43120' } satisfies PidLockInfo;
  const lockFile = join(paths.appDir, 'daemon.pid');
  await writeFile(lockFile, JSON.stringify(owner));
  fixture.alive.add(owner.pid);
  let stopped = false;
  fixture.stop.mockImplementationOnce(async () => { stopped = true; });
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal !== 0) throw new Error('test attempted to send an OS signal');
    // The first liveness check after stop is where the daemon finishes: its lock goes, then the process.
    if (stopped && fixture.alive.has(pid)) { unlinkSync(lockFile); fixture.alive.delete(pid); }
    if (fixture.alive.has(pid)) return true;
    throw Object.assign(new Error('simulated process exit'), { code: 'ESRCH' });
  });
  await expect(runStop(paths.appDir)).resolves.toBe(true);
  expect(stopped).toBe(true);
  expect(await getPidLockInfo(paths.appDir)).toBeNull();
});
