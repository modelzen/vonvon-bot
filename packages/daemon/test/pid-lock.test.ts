import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquirePidLock, getPidLockInfo, publishPidLock, readRunningPidLock, releasePidLock } from '../src/server/pid-lock';
import { daemonStatus } from '../src/cli/commands/daemon';

const homes: string[] = [];
async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'vonvon-pid-'));
  homes.push(path);
  return path;
}
afterEach(async () => { await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it('claims before readiness, publishes the actual address, and releases only its owner', async () => {
  const path = await home();
  const owner = await acquirePidLock(path);
  expect(owner.listen).toBeNull();
  expect((await daemonStatus(path)).running).toBe(false);
  await expect(acquirePidLock(path)).rejects.toThrow(/already running/);
  const ready = await publishPidLock(path, owner, '127.0.0.1:49152');
  expect(await daemonStatus(path)).toMatchObject({ running: true, pid: process.pid, listen: '127.0.0.1:49152' });
  await releasePidLock(path, { ...owner, startedAt: new Date(0).toISOString() });
  expect(await readRunningPidLock(path)).toEqual(ready);
  await releasePidLock(path, owner);
  expect(await getPidLockInfo(path)).toBeNull();
});

it('replaces a dead owner but preserves an ambiguous live owner', async () => {
  const path = await home();
  const file = join(path, 'daemon.pid');
  await writeFile(file, JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString(), listen: '127.0.0.1:8' }));
  const owner = await acquirePidLock(path);
  expect(owner.pid).toBe(process.pid);
  await writeFile(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), listen: null }));
  await expect(acquirePidLock(path)).rejects.toThrow(/already running/);
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ pid: process.pid });
});

it('reads absent status without creating the home', async () => {
  const parent = await home();
  const absent = join(parent, 'absent');
  expect(await daemonStatus(absent)).toEqual({ running: false });
  await expect(readFile(join(absent, 'daemon.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
});
