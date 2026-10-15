import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Registration } from '../src/service/registration';
import type { ShutdownControl } from '../src/host/lifecycle';

const fixture = vi.hoisted(() => ({
  root: '', registration: vi.fn<() => Promise<Registration>>(), run: vi.fn(), info: vi.fn(), verify: vi.fn(),
  mutex: vi.fn(), realVerify: true, armed: false,
}));
vi.mock('../src/config/paths', () => ({ paths: { get appDir() { return fixture.root; } } }));
vi.mock('../src/service/startup', () => ({ readStartupRegistration: fixture.registration }));
vi.mock('../src/cli/commands/run', () => ({ runRun: fixture.run }));
vi.mock('../src/core/logger', () => ({ log: { info: fixture.info, warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/service/codex-bin', () => ({ readServiceCodexBin: vi.fn() }));
vi.mock('../src/provider/process/process-host', () => ({
  defaultHolderPath: () => '/unused/holder',
  ProcessHost: class { sweepOrphans = async () => ({}); admission = () => null; closeAll = async () => {}; },
}));
vi.mock('../src/config/data-access', async original => {
  const actual = await original<typeof import('../src/config/data-access')>();
  // The busy-mutex wait reads Date.now once for its deadline; arming jumps every later read past it.
  fixture.mutex.mockImplementation(async (...args: Parameters<typeof actual.acquireMutex>) => {
    try { return await actual.acquireMutex(...args); }
    catch (error) { fixture.armed = true; throw error; }
  });
  return { ...actual, acquireMutex: fixture.mutex };
});
vi.mock('../src/server/owner-verification', async original => {
  const actual = await original<typeof import('../src/server/owner-verification')>();
  fixture.verify.mockImplementation((...args: Parameters<typeof actual.verifyPidLockOwner>) => fixture.realVerify ? actual.verifyPidLockOwner(...args) : Promise.resolve());
  return { ...actual, verifyPidLockOwner: fixture.verify };
});

import { runHostRuntime } from '../src/host/bootstrap';

const realNow = Date.now.bind(Date);
const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const control = (): ShutdownControl => ({
  requested: false, requestStop: vi.fn(), requestRestart: vi.fn(), waitForRequest: vi.fn(), dispose: vi.fn(),
  completeShutdown: vi.fn(async (release: () => Promise<void>) => { await release(); }),
});
const run = () => runHostRuntime({ managed: false, control: control() });
const lockPath = () => join(fixture.root, 'daemon.pid');
const ours = (): Registration => ({ kind: 'ours', definition: { root: fixture.root, port: 1234, capturedPath: '/bin', distribution: { kind: 'npm', executable: '/node', entry: '/cli' } } as never });
const children: ChildProcess[] = [];

/** A live process that is not a daemon; with `mutex` it also holds this root's host mutex. */
async function bystander(mutex: boolean): Promise<{ child: ChildProcess; pid: number; signals: () => string }> {
  const source = `const {createHash}=require('node:crypto');for(const s of ['SIGTERM','SIGINT','SIGHUP','SIGUSR1','SIGUSR2'])process.on(s,()=>process.stdout.write(s));
if(process.argv[1]){const h=createHash('sha256').update('vonvon-bot-v2:host:'+process.argv[1]).digest();require('node:net').createServer().listen({host:'127.0.0.1',port:20000+h.readUInt32BE(0)%30000,exclusive:true},()=>process.stdout.write('ready'));}
else process.stdout.write('ready');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', source, mutex ? fixture.root : ''], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  let out = '';
  await new Promise<void>((done, fail) => {
    child.once('exit', () => fail(new Error('bystander exited')));
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); if (out.startsWith('ready')) done(); });
  });
  return { child, pid: child.pid ?? 0, signals: () => out.slice('ready'.length) };
}
const untouchedBystander = (b: Awaited<ReturnType<typeof bystander>>) => {
  expect(b.child.exitCode).toBeNull(); expect(b.child.signalCode).toBeNull(); expect(b.signals()).toBe('');
};
const writeLock = (lock: object) => writeFile(lockPath(), JSON.stringify(lock));

beforeEach(async () => {
  fixture.root = await realpath(await mkdtemp(join(tmpdir(), 'vonvon-prelock-')));
  fixture.realVerify = true; fixture.armed = false;
  fixture.registration.mockResolvedValue(ours());
  fixture.run.mockReset(); fixture.info.mockReset(); fixture.verify.mockClear(); fixture.mutex.mockClear();
  let armedReads = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => fixture.armed && armedReads++ > 0 ? realNow() + 60_000 : realNow());
  vi.stubEnv('VONVON_SERVICE', 'systemd');
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { send: { value: undefined }, exitCode: { value: undefined, writable: true } }));
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await rm(fixture.root, { recursive: true, force: true });
});

it.each<[string, () => Registration]>([
  ['absent', () => ({ kind: 'absent' })],
  ['other-root', () => ({ ...ours(), kind: 'other-root', recordedRoot: '/elsewhere' } as never)],
  ['unrecognized', () => ({ kind: 'unrecognized', location: '/unit', reason: 'invalid' })],
])('exits zero for a %s registration under the service manager without touching locks', async (_kind, registration) => {
  fixture.registration.mockResolvedValue(registration());
  const bytes = JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString(), listen: null });
  await writeFile(lockPath(), bytes);
  await run();
  expect(process.exitCode).toBe(0);
  expect(fixture.info).toHaveBeenCalledWith('daemon-startup', 'registration_absent', expect.objectContaining({ kind: registration().kind }));
  expect(fixture.mutex).not.toHaveBeenCalled(); expect(fixture.run).not.toHaveBeenCalled();
  expect(await readFile(lockPath(), 'utf8')).toBe(bytes);
});

it('refuses a foreground run while the registration is ours, before any lock', async () => {
  vi.stubEnv('VONVON_SERVICE', '');
  await expect(run()).rejects.toThrow('Daemon is registered as a service');
  expect(fixture.mutex).not.toHaveBeenCalled(); expect(fixture.run).not.toHaveBeenCalled();
  await expect(readFile(lockPath())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('runs a foreground daemon when nothing is registered and releases its lock', async () => {
  vi.stubEnv('VONVON_SERVICE', '');
  fixture.registration.mockResolvedValue({ kind: 'absent' });
  fixture.run.mockImplementation(async () => { expect(JSON.parse(await readFile(lockPath(), 'utf8'))).toMatchObject({ pid: process.pid }); });
  await run();
  expect(fixture.run).toHaveBeenCalledOnce();
  await expect(readFile(lockPath())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('exits zero on a busy host mutex only after authenticating the ready owner', async () => {
  const holder = await bystander(true);
  const bytes = JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString(), listen: '127.0.0.1:1', bootId });
  await writeFile(lockPath(), bytes);
  fixture.realVerify = false;
  await run();
  expect(process.exitCode).toBe(0);
  expect(fixture.verify).toHaveBeenCalledWith(fixture.root, expect.objectContaining({ pid: holder.pid }));
  expect(fixture.info).toHaveBeenCalledWith('daemon-startup', 'owner_present', { pid: holder.pid });
  expect(fixture.run).not.toHaveBeenCalled(); expect(await readFile(lockPath(), 'utf8')).toBe(bytes);
  untouchedBystander(holder);
}, 15_000);

it.each([
  ['an owner that fails verification', '127.0.0.1:1'],
  ['an owner that never publishes readiness', null],
])('rejects on a busy host mutex with %s, leaving the lock and process untouched', async (_case, listen) => {
  const holder = await bystander(true);
  const bytes = JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString(), listen, bootId });
  await writeFile(lockPath(), bytes);
  await expect(run()).rejects.toThrow('Bridge host is busy');
  expect(process.exitCode).not.toBe(0);
  expect(fixture.verify).toHaveBeenCalledTimes(listen ? 1 : 0);
  expect(fixture.info).not.toHaveBeenCalledWith('daemon-startup', 'owner_present', expect.anything());
  expect(fixture.run).not.toHaveBeenCalled(); expect(await readFile(lockPath(), 'utf8')).toBe(bytes);
  untouchedBystander(holder);
}, 15_000);

it('replaces a lock naming this process once it holds the host mutex', async () => {
  const stale = { pid: process.pid, startedAt: new Date(realNow() - 1000).toISOString(), listen: null, bootId };
  await writeLock(stale);
  fixture.run.mockImplementation(async () => {
    const current = JSON.parse(await readFile(lockPath(), 'utf8'));
    expect(current).toMatchObject({ pid: process.pid }); expect(current.startedAt).not.toBe(stale.startedAt);
  });
  await run();
  expect(fixture.run).toHaveBeenCalledOnce();
  expect(fixture.info).toHaveBeenCalledWith('daemon-startup', 'stale_owner_replaced', { pid: process.pid });
});

it('takes over a lock whose PID now belongs to a live unrelated process instead of exiting zero (#287)', async () => {
  const unrelated = await bystander(false);
  await writeLock({ pid: unrelated.pid, startedAt: new Date().toISOString(), listen: '127.0.0.1:1', bootId });
  let during: unknown;
  fixture.run.mockImplementation(async () => { during = JSON.parse(await readFile(lockPath(), 'utf8')); });
  await run();
  expect(during).toMatchObject({ pid: process.pid, listen: null });
  expect(process.exitCode).toBeUndefined();
  expect(fixture.verify).not.toHaveBeenCalled();
  expect(fixture.info).toHaveBeenCalledWith('daemon-startup', 'stale_owner_replaced', { pid: unrelated.pid });
  expect(fixture.info).not.toHaveBeenCalledWith('daemon-startup', 'owner_present', expect.anything());
  untouchedBystander(unrelated);
});
