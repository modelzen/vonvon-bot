import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { machineIdSchema, PROTOCOL_VERSION } from '@vonvon/protocol';
import { createSocketServer, type Peer } from '../src/server/ws';
import { stopVerifiedOwner } from '../src/server/owner-verification';
import type { PidLockInfo } from '../src/server/pid-lock';
import { createServiceDrain, type DrainScope } from '../src/service/drain';

import { mkdir, unlink, rename } from 'node:fs/promises';
import { createLaunchdService, TRANSLOCATED_REFUSAL } from '../src/service/launchd';
import { classifyServiceFailure } from '../src/service/action-report';
import { renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot, LAUNCHD_LABEL } from '../src/service/identity';
import { readRegistration } from '../src/service/registration';
import { clearPosixFixtures, logicalFixturePath, registerPosixFixture } from './service-posix-fixture';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const { mappedServiceFs } = await import('./service-posix-fixture');
  return mappedServiceFs(actual);
});


afterEach(clearPosixFixtures);

type Observation =
  | { kind: 'lock'; value: PidLockInfo | null }
  | { kind: 'job'; value: number | null }
  | { kind: 'stop'; value: PidLockInfo; error?: Error }
  | { kind: 'lock-error'; error: Error }
  | { kind: 'job-error'; error: Error };

const first: PidLockInfo = { pid: 41001, startedAt: '2026-10-11T00:00:00.000Z', listen: '127.0.0.1:49101' };
const next: PidLockInfo = { pid: 41002, startedAt: '2026-10-11T00:00:01.000Z', listen: '127.0.0.1:49102' };
const install: DrainScope = { kind: 'job-only', context: 'install-rollback' };
const resumed: DrainScope = { kind: 'job-only', context: 'uninstall-resumed' };
const all: DrainScope = { kind: 'all-owners' };

function trace(steps: Observation[], scope: DrainScope) {
  const pending = [...steps];
  const calls: string[] = [];
  let pauses = 0;
  const take = (kind: Observation['kind']): Observation => {
    const step = pending.shift();
    if (!step || step.kind !== kind) throw new Error(`Expected ${kind}; got ${step?.kind ?? 'end'}`);
    calls.push(kind);
    return step;
  };
  const drain = createServiceDrain({
    readRunningPidLock: async () => {
      const step = pending[0];
      if (step?.kind === 'lock-error') {
        const observation = take('lock-error');
        if (observation.kind !== 'lock-error') throw new Error('Expected lock error');
        throw observation.error;
      }
      const observation = take('lock');
      if (observation.kind !== 'lock') throw new Error('Expected lock');
      return observation.value;
    },
    stopVerifiedOwner: async (_home, lock) => {
      const observation = take('stop');
      if (observation.kind !== 'stop') throw new Error('Expected stop');
      expect(lock).toEqual(observation.value);
      if (observation.error) throw observation.error;
    },
    pause: async milliseconds => {
      expect(milliseconds).toBeGreaterThanOrEqual(250);
      calls.push('pause');
      pauses++;
      if (pauses > 30) throw new Error('Unbounded scripted trace');
    },
  });
  return {
    calls,
    run: async () => {
      const result = await drain({ home: '/unused/scripted-home', scope, queryJobPid: async () => {
        const step = pending[0];
        if (step?.kind === 'job-error') {
          const observation = take('job-error');
          if (observation.kind !== 'job-error') throw new Error('Expected job error');
          throw observation.error;
        }
        const observation = take('job');
        if (observation.kind !== 'job') throw new Error('Expected job');
        return observation.value;
      } });
      expect(pending).toEqual([]);
      return result;
    },
  };
}

it.each([
  { scope: all, steps: [{ kind: 'lock', value: null }, { kind: 'job', value: null }], retained: null },
  { scope: install, steps: [{ kind: 'lock', value: first }, { kind: 'job', value: null }], retained: { pid: first.pid, startedAt: first.startedAt } },
  { scope: resumed, steps: [{ kind: 'lock', value: first }, { kind: 'job', value: null }], retained: { pid: first.pid, startedAt: first.startedAt } },
] satisfies { scope: DrainScope; steps: Observation[]; retained: { pid: number; startedAt: string } | null }[])('finishes $scope.kind only after ordered lock and manager observations', async ({ scope, steps, retained }) => {
  const f = trace(steps, scope);
  expect(await f.run()).toEqual({ kind: 'drained', retained });
  expect(f.calls).toEqual(['lock', 'job']);
});

it('all-owners waits for a manager-only process to exit before the final empty round', async () => {
  const f = trace([
    { kind: 'lock', value: null }, { kind: 'job', value: first.pid },
    { kind: 'lock', value: null }, { kind: 'job', value: first.pid },
    { kind: 'lock', value: null }, { kind: 'job', value: null },
  ], all);
  expect(await f.run()).toEqual({ kind: 'drained', retained: null });
  expect(f.calls).toEqual(['lock', 'job', 'pause', 'lock', 'job', 'pause', 'lock', 'job']);
});

it('all-owners waits for publication and confirmed exit, stops a replacement, and requires both observations empty', async () => {
  const f = trace([
    { kind: 'lock', value: null }, { kind: 'job', value: first.pid },
    { kind: 'lock', value: { ...first, listen: null } }, { kind: 'job', value: first.pid },
    { kind: 'lock', value: first }, { kind: 'job', value: first.pid }, { kind: 'stop', value: first },
    { kind: 'lock', value: first }, { kind: 'lock', value: first }, { kind: 'lock', value: next },
    { kind: 'lock', value: next }, { kind: 'job', value: null }, { kind: 'stop', value: next },
    { kind: 'lock', value: next }, { kind: 'lock', value: null },
    { kind: 'lock', value: null }, { kind: 'job', value: null },
  ], all);
  expect(await f.run()).toEqual({ kind: 'drained', retained: null });
  expect(f.calls).toEqual([
    'lock', 'job', 'pause',
    'lock', 'job', 'pause',
    'lock', 'job', 'stop', 'lock', 'pause', 'lock', 'pause', 'lock', 'pause',
    'lock', 'job', 'stop', 'lock', 'pause', 'lock', 'pause',
    'lock', 'job',
  ]);
});

it('all-owners stops a published owner beside a different manager pid and keeps waiting for that job', async () => {
  const f = trace([
    { kind: 'lock', value: first }, { kind: 'job', value: next.pid }, { kind: 'stop', value: first },
    { kind: 'lock', value: null },
    { kind: 'lock', value: null }, { kind: 'job', value: next.pid },
    { kind: 'lock', value: null }, { kind: 'job', value: null },
  ], all);
  expect(await f.run()).toEqual({ kind: 'drained', retained: null });
  expect(f.calls).toEqual([
    'lock', 'job', 'stop', 'lock', 'pause', 'lock', 'job', 'pause', 'lock', 'job',
  ]);
});

it('resets an unproven streak when a matching owner has not published its listener', async () => {
  const f = trace([
    { kind: 'lock', value: first }, { kind: 'job', value: first.pid }, { kind: 'lock', value: null },
    { kind: 'lock', value: { ...first, listen: null } }, { kind: 'job', value: first.pid },
    { kind: 'lock', value: first }, { kind: 'job', value: first.pid }, { kind: 'lock', value: null },
    { kind: 'lock', value: first }, { kind: 'job', value: first.pid }, { kind: 'lock', value: null },
  ], resumed);
  expect(await f.run()).toMatchObject({ kind: 'drain-failed', reason: 'owner_unproven', pid: first.pid });
  expect(f.calls).toEqual([
    'lock', 'job', 'lock', 'pause', 'lock', 'job', 'pause',
    'lock', 'job', 'lock', 'pause', 'lock', 'job', 'lock',
  ]);
});

it('all-owners makes a rejected stop terminal without another observation or stop', async () => {
  const f = trace([
    { kind: 'lock', value: first }, { kind: 'job', value: null },
    { kind: 'stop', value: first, error: new Error('done reply lost') },
  ], all);
  expect(await f.run()).toMatchObject({ kind: 'drain-failed', reason: 'stop_unconfirmed', pid: first.pid });
  expect(f.calls).toEqual(['lock', 'job', 'stop']);
});

it('retains a Windows job-only lock when its manager has no PID query', async () => {
  const f = trace([{ kind: 'lock', value: { ...first, listen: null } }, { kind: 'job', value: null }], install);
  expect(await f.run()).toEqual({ kind: 'drained', retained: { pid: first.pid, startedAt: first.startedAt } });
  expect(f.calls).toEqual(['lock', 'job']);
});

it('waits for a matching unpublished owner to become ready before proof', async () => {
  const f = trace([
    { kind: 'lock', value: { ...first, listen: null } }, { kind: 'job', value: first.pid },
    { kind: 'lock', value: first }, { kind: 'job', value: first.pid }, { kind: 'lock', value: first }, { kind: 'stop', value: first },
    { kind: 'lock', value: null }, { kind: 'lock', value: null }, { kind: 'job', value: null },
  ], resumed);
  expect(await f.run()).toEqual({ kind: 'drained', retained: null });
  expect(f.calls.filter(call => call === 'stop')).toHaveLength(1);
  expect(f.calls.slice(0, 5)).toEqual(['lock', 'job', 'pause', 'lock', 'job']);
});

it('waits through a missing job lock on install rollback, then proves the published owner', async () => {
  const f = trace([
    { kind: 'lock', value: null }, { kind: 'job', value: first.pid },
    { kind: 'lock', value: first }, { kind: 'job', value: first.pid }, { kind: 'lock', value: first }, { kind: 'stop', value: first },
    { kind: 'lock', value: null }, { kind: 'lock', value: null }, { kind: 'job', value: null },
  ], install);
  expect(await f.run()).toEqual({ kind: 'drained', retained: null });
  expect(f.calls.filter(call => call === 'stop')).toHaveLength(1);
});

it.each([null, next])('refuses a resumed foreign job with lock %s without calling stop', async lock => {
  const f = trace([{ kind: 'lock', value: lock }, { kind: 'job', value: first.pid }], resumed);
  expect(await f.run()).toMatchObject({ kind: 'drain-failed', reason: 'foreign_job_pid', pid: first.pid });
  expect(f.calls).toEqual(['lock', 'job']);
});

it('retains a foreign owner while install rollback waits for its job to exit', async () => {
  const f = trace([
    { kind: 'lock', value: next }, { kind: 'job', value: first.pid },
    { kind: 'lock', value: next }, { kind: 'job', value: null },
  ], install);
  expect(await f.run()).toEqual({ kind: 'drained', retained: { pid: next.pid, startedAt: next.startedAt } });
  expect(f.calls).toEqual(['lock', 'job', 'pause', 'lock', 'job']);
});

it('does not stop an owner whose O3 lock changes, and fails after two consecutive unproven attempts', async () => {
  const f = trace([
    { kind: 'lock', value: first }, { kind: 'job', value: first.pid }, { kind: 'lock', value: { ...first, listen: next.listen } },
    { kind: 'lock', value: first }, { kind: 'job', value: first.pid }, { kind: 'lock', value: { ...first, startedAt: next.startedAt } },
  ], resumed);
  expect(await f.run()).toMatchObject({ kind: 'drain-failed', reason: 'owner_unproven', pid: first.pid });
  expect(f.calls).toEqual(['lock', 'job', 'lock', 'pause', 'lock', 'job', 'lock']);
});

it('counts an unproven streak by incarnation and resets it after a nonmatching manager round', async () => {
  const secondIncarnation = { ...first, startedAt: next.startedAt };
  const f = trace([
    { kind: 'lock', value: first }, { kind: 'job', value: first.pid }, { kind: 'lock', value: null },
    { kind: 'lock', value: secondIncarnation }, { kind: 'job', value: secondIncarnation.pid }, { kind: 'lock', value: null },
    { kind: 'lock', value: secondIncarnation }, { kind: 'job', value: next.pid },
    { kind: 'lock', value: secondIncarnation }, { kind: 'job', value: secondIncarnation.pid }, { kind: 'lock', value: null },
    { kind: 'lock', value: secondIncarnation }, { kind: 'job', value: secondIncarnation.pid }, { kind: 'lock', value: null },
  ], install);
  expect(await f.run()).toMatchObject({ kind: 'drain-failed', reason: 'owner_unproven', pid: secondIncarnation.pid });
  expect(f.calls.filter(call => call === 'stop')).toHaveLength(0);
  expect(f.calls.filter(call => call === 'pause')).toHaveLength(4);
});

it.each([
  { label: 'O1 read', steps: [{ kind: 'lock-error', error: new Error('O1 unavailable') }] },
  { label: 'O2 query', steps: [{ kind: 'lock', value: first }, { kind: 'job-error', error: new Error('manager unavailable') }] },
  { label: 'O3 read', steps: [{ kind: 'lock', value: first }, { kind: 'job', value: first.pid }, { kind: 'lock-error', error: new Error('O3 unavailable') }] },
] satisfies { label: string; steps: Observation[] }[])('maps $label failure to query_failed without a stop', async ({ steps }) => {
  const f = trace(steps, resumed);
  expect(await f.run()).toMatchObject({ kind: 'drain-failed', reason: 'query_failed' });
  expect(f.calls).not.toContain('stop');
});

it('makes an O4 rejection terminal even if the stop request may have been accepted', async () => {
  const f = trace([
    { kind: 'lock', value: first }, { kind: 'job', value: first.pid }, { kind: 'lock', value: first },
    { kind: 'stop', value: first, error: new Error('done reply lost') },
  ], install);
  expect(await f.run()).toMatchObject({ kind: 'drain-failed', reason: 'stop_unconfirmed', pid: first.pid });
  expect(f.calls).toEqual(['lock', 'job', 'lock', 'stop']);
});

it('waits for a confirmed owner without a deadline or second stop, then handles a replacement in the fixed scope', async () => {
  let reads = 0;
  let jobs = 0;
  let pauses = 0;
  let stops = 0;
  const drain = createServiceDrain({
    readRunningPidLock: async () => {
      reads++;
      if (reads <= 2) return first;
      if (reads <= 2_002) return first;
      return next;
    },
    stopVerifiedOwner: async (_home, lock) => { expect(lock).toEqual(first); stops++; },
    pause: async milliseconds => { expect(milliseconds).toBeGreaterThanOrEqual(250); pauses++; },
  });
  const result = await drain({ home: '/unused/scripted-home', scope: install, queryJobPid: async () => ++jobs === 1 ? first.pid : null });
  expect(result).toEqual({ kind: 'drained', retained: { pid: next.pid, startedAt: next.startedAt } });
  expect(stops).toBe(1);
  expect(jobs).toBe(2);
  expect(pauses * 250).toBeGreaterThanOrEqual(8 * 60 * 1000);
});

it('treats a read failure during the confirmed owner wait as query_failed without repeating stop', async () => {
  const f = trace([
    { kind: 'lock', value: first }, { kind: 'job', value: first.pid }, { kind: 'lock', value: first }, { kind: 'stop', value: first },
    { kind: 'lock-error', error: new Error('wait read unavailable') },
  ], install);
  expect(await f.run()).toMatchObject({ kind: 'drain-failed', reason: 'query_failed' });
  expect(f.calls.filter(call => call === 'stop')).toHaveLength(1);
});

async function realOwner(mode: 'changed-lock' | 'lost-done') {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-service-drain-'));
  const child: ChildProcess = spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout?.once('data', () => resolve()); });
  if (!child.pid) throw new Error('Missing fixture child pid');
  const credential = 'ab'.repeat(32);
  const server = createServer();
  let status = 0;
  let stops = 0;
  let lock: PidLockInfo;
  const sockets = createSocketServer({
    server, credential,
    info: { type: 'serverInfo', machineId: machineIdSchema.parse(randomUUID()), version: 'test', protocolVersion: PROTOCOL_VERSION },
    detached: () => undefined,
    request: async (peer: Peer, request) => {
      if (request.method === 'admin' && request.payload.type === 'daemonStatus') {
        status++;
        if (mode === 'changed-lock') await writeFile(join(home, 'daemon.pid'), JSON.stringify({ ...lock, startedAt: next.startedAt }));
        peer.send({ type: 'response', id: request.id, method: 'admin', payload: { kind: 'daemonStatus', status: {
          installed: false, running: true, selfHosted: true, version: 'test', supported: true, pid: child.pid,
        } } });
      } else if (request.method === 'machine' && request.payload.type === 'stopHost') {
        stops++;
      } else throw new Error(`Unexpected fixture request ${request.method}`);
    },
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  lock = { pid: child.pid, startedAt: new Date().toISOString(), listen: `127.0.0.1:${address.port}` };
  await writeFile(join(home, 'daemon.pid'), JSON.stringify(lock));
  await writeFile(join(home, 'local-credential'), credential);
  return {
    home, lock, status: () => status, stops: () => stops, child,
    close: async () => {
      await sockets.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
      await rm(home, { recursive: true, force: true });
    },
  };
}

it('real O4 refuses an O3-to-O4 lock incarnation change without sending stopHost', async () => {
  const f = await realOwner('changed-lock');
  try {
    const drain = createServiceDrain({ pause: async () => { throw new Error('Unexpected retry'); } });
    const result = await drain({ home: f.home, scope: resumed, queryJobPid: async () => f.child.pid ?? null });
    expect(result).toMatchObject({ kind: 'drain-failed', reason: 'stop_unconfirmed', pid: f.lock.pid });
    expect(f.status()).toBe(1);
    expect(f.stops()).toBe(0);
    expect(await readFile(join(f.home, 'daemon.pid'), 'utf8')).toBe(JSON.stringify({ ...f.lock, startedAt: next.startedAt }));
    expect(f.child.exitCode).toBeNull();
    expect(f.child.signalCode).toBeNull();
  } finally { await f.close(); }
});

it.each([install, all])('real O4 sends exactly one stopHost and treats a lost done reply as terminal under $kind', async scope => {
  const f = await realOwner('lost-done');
  try {
    const originalBytes = await readFile(join(f.home, 'daemon.pid'), 'utf8');
    const drain = createServiceDrain({ pause: async () => { throw new Error('Unexpected retry'); } });
    let queries = 0;
    const result = await drain({ home: f.home, scope, queryJobPid: async () => {
      queries++;
      return f.child.pid ?? null;
    } });
    expect(queries).toBe(1);
    expect(result).toMatchObject({ kind: 'drain-failed', reason: 'stop_unconfirmed', pid: f.lock.pid });
    expect(f.status()).toBe(1);
    expect(f.stops()).toBe(1);
    expect(await readFile(join(f.home, 'daemon.pid'), 'utf8')).toBe(originalBytes);
    expect(f.child.exitCode).toBeNull();
    expect(f.child.signalCode).toBeNull();
  } finally { await f.close(); }
});


type LaunchdFixture = Awaited<ReturnType<typeof launchdFixture>>;
async function launchdFixture(overrides: NonNullable<Parameters<typeof createLaunchdService>[1]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'launchd-transaction-'));
  const root = await resolveServiceRoot(registerPosixFixture(await resolveServiceRoot(directory)));
  const plistPath = posix.join(root, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const target = { platform: 'darwin' as const, label: LAUNCHD_LABEL, plistPath };
  const calls: string[] = [];
  const fileCalls: string[] = [];
  const state: {
    fileFault: 'open' | 'write' | 'sync' | 'close' | 'rename' | null;
    cleanupFails: boolean; plistUnlinkFails: boolean;
    logFault: { name: string; operation: 'open' | 'close' } | null;
    child: { phase: 'checking' | 'owner' | 'guard-rejected' | 'exited'; pid: number; locks: number; work: number; exitCode: number | null; signals: number } | null;
    prematureBootouts: number; ownerWork: number;
    loaded: boolean; owner: PidLockInfo | null; pid: number | null; clock: number;
    bootstrap: 'success' | 'error' | 'timeout'; verifyFails: boolean;
    queryFailure: boolean; queryTimeout: boolean; queryOutput: string | null; bootout: 'success' | 'error' | 'timeout' | 'retained'; stopFails: boolean;
    beforeCommand: ((command: string) => Promise<void>) | null;
    beforeUnlink: (() => Promise<void>) | null;
    afterUnlink: (() => Promise<void>) | null;
    onPause: (() => void | Promise<void>) | null; renameFails: boolean; delayStop: boolean; pidText: string | null;
  } = { fileFault: null, cleanupFails: false, plistUnlinkFails: false, logFault: null, child: null, prematureBootouts: 0, ownerWork: 0, loaded: false, owner: null, pid: null, clock: 0, bootstrap: 'success', verifyFails: false,
    queryFailure: false, queryTimeout: false, queryOutput: null, bootout: 'success', stopFails: false, beforeCommand: null, beforeUnlink: null, afterUnlink: null, onPause: null, renameFails: false, delayStop: false, pidText: null };
  const content = (port = 49101) => {
    const result = renderDefinition({ target, root, port, distribution: { kind: 'npm', executable: '/fixture/bin/node', entry: '/package/bin/vonvon.mjs' }, capturedPath: '/captured/bin' });
    if (result.platform !== 'darwin') throw new Error('Expected plist');
    return Buffer.from(result.plist);
  };
  const seed = async (port = 49101) => { await mkdir(posix.join(root, 'Library/LaunchAgents'), { recursive: true }); await writeFile(plistPath, content(port)); state.loaded = true; };
  const launchChild = () => {
    expect(state.child).toBeNull();
    state.child = { phase: 'checking', pid: first.pid, locks: 0, work: 0, exitCode: null, signals: 0 };
    state.pid = first.pid;
    calls.push('child born');
  };
  const checkChildRegistration = async () => {
    const child = state.child;
    if (!child || child.phase !== 'checking') throw new Error('No child awaiting registration check');
    const current = await readRegistration({ target, requestedRoot: root });
    calls.push(`child registration ${current.kind}`);
    if (current.kind === 'ours') {
      child.phase = 'owner'; child.locks++; child.work++;
      state.owner = { ...first };
    } else {
      expect(current.kind).toBe('absent');
      child.phase = 'guard-rejected';
    }
  };
  const exitChild = () => {
    const child = state.child;
    if (!child || child.phase !== 'guard-rejected') throw new Error('Child has not rejected registration');
    child.phase = 'exited'; child.exitCode = 0; state.pid = null;
    calls.push('child exited 0');
  };
  const failFile = (operation: NonNullable<typeof state.fileFault>) => {
    fileCalls.push(operation);
    if (state.fileFault === operation) { state.fileFault = null; throw new Error(`${operation} failed`); }
  };
  const temporaryFiles = async () => (await readdir(posix.dirname(plistPath))).filter(name => name.endsWith('.tmp')).map(name => posix.join(posix.dirname(plistPath), name));
  const dependencies = {
    home: root, uid: 501, executable: '/fixture/bin/node', capturedPath: '/captured/bin', target: () => target,
    distribution: async () => ({ kind: 'global-npm', cliPath: '/package/bin/vonvon.mjs' }),
    readOwner: async () => state.owner,
    verifyOwner: async (_root, owner) => { if (state.verifyFails || state.owner !== owner) throw new Error('Owner not authenticated'); },
    stopOwner: async (_root, owner) => {
      calls.push(`stop ${owner.pid}`);
      expect(state.owner).toBe(owner);
      if (state.stopFails) throw new Error('Stop reply lost');
      if (state.delayStop) return;
      state.owner = null; state.ownerWork = 0;
      if (state.pid === owner.pid) state.pid = null;
      if (state.child?.phase === 'owner' && state.child.pid === owner.pid) {
        state.child.phase = 'exited'; state.child.exitCode = 0; state.child.work = 0;
        calls.push('child drained 0');
      }
    },
    open: async (path, flags, mode) => {
      const temporary = String(path).endsWith('.tmp');
      const logFault = state.logFault?.name === logicalFixturePath(String(path)) ? state.logFault : null;
      if (temporary) failFile('open');
      if (logFault?.operation === 'open') throw new Error('log open failed');
      const file = await open(path, flags, mode);
      const write = file.writeFile.bind(file);
      const sync = file.sync.bind(file);
      const close = file.close.bind(file);
      if (temporary) {
        file.writeFile = async (...args) => { failFile('write'); await write(...args); };
        file.sync = async () => { failFile('sync'); await sync(); };
      }
      file.close = async () => {
        await close();
        if (temporary) failFile('close');
        if (logFault?.operation === 'close') throw new Error('log close failed');
      };
      return file;
    },
    rename: async (from, to) => { failFile('rename'); if (state.renameFails) throw new Error('rename failed'); await rename(from, to); },
    unlink: async path => {
      if (String(path) !== plistPath) { fileCalls.push('cleanup'); if (state.cleanupFails) throw new Error('cleanup failed'); await unlink(path); return; }
      await state.beforeUnlink?.();
      if (state.plistUnlinkFails) throw new Error('plist unlink failed');
      await unlink(path);
      calls.push('withdraw');
      await state.afterUnlink?.();
    },
    pause: async ms => { state.clock += ms; await state.onPause?.(); }, now: () => state.clock, freePort: async () => 49101,
    run: async (args, timeout) => {
      expect(timeout).toBe(30_000);
      const command = args[0] ?? '';
      calls.push(args.join(' '));
      await state.beforeCommand?.(command);
      if (command === 'print' && args[1] === 'gui/501') return { ok: true, stdout: 'domain', stderr: '' };
      if (command === 'print') {
        if (state.child && state.child.phase !== 'exited') { expect(state.pid).toBe(state.child.pid); calls.push(`child visible ${state.child.phase}`); }
        if (state.queryTimeout) return { ok: false, stdout: '', stderr: 'launchctl client timed out' };
        if (state.queryOutput !== null) { const stdout = state.queryOutput; state.queryOutput = null; return { ok: true, stdout, stderr: '' }; }
        if (state.queryFailure) return { ok: false, stdout: '', stderr: 'query failed' };
        if (!state.loaded) return { ok: false, stdout: '', stderr: 'Could not find service' };
        return { ok: true, stdout: `gui/501/${LAUNCHD_LABEL} = {\n\tstate = ${state.pid === null ? 'waiting' : 'running'}\n${state.pidText !== null ? `\tpid = ${state.pidText}\n` : state.pid === null ? '' : `\tpid = ${state.pid}\n`}}`, stderr: '' };
      }
      if (command === 'bootstrap') {
        expect((await readRegistration({ target, requestedRoot: root })).kind).toBe('ours');
        state.loaded = true;
        if (state.bootstrap !== 'success') return { ok: false, stdout: '', stderr: state.bootstrap };
        if (!state.owner && !state.verifyFails) {
          const current = await readRegistration({ target, requestedRoot: root });
          if (current.kind !== 'ours') throw new Error('Missing bootstrap registration');
          state.owner = { ...first, listen: `127.0.0.1:${current.definition.port}` }; state.pid = first.pid;
        }
        return { ok: true, stdout: '', stderr: '' };
      }
      if (command === 'bootout') {
        expect((await readRegistration({ target, requestedRoot: root })).kind).toBe('absent');
        if (state.pid !== null) {
          if (state.child?.phase !== 'guard-rejected') state.prematureBootouts++;
          expect(state.child).toMatchObject({ phase: 'guard-rejected', locks: 0, work: 0, signals: 0 });
          calls.push('manager sees rejected child');
          exitChild();
        }
        expect(state.pid).toBeNull();
        if (state.bootout !== 'retained' && state.bootout !== 'error') state.loaded = false;
        return { ok: state.bootout === 'success' || state.bootout === 'retained', stdout: '', stderr: state.bootout };
      }
      if (command === 'kickstart') { state.owner = { ...first }; state.pid = first.pid; return { ok: true, stdout: '', stderr: '' }; }
      throw new Error(`Unexpected command ${command}`);
    },
    ...overrides,
  } satisfies NonNullable<Parameters<typeof createLaunchdService>[1]>;
  type BarrierObservation = { kind: 'lock'; owner: PidLockInfo | null } | { kind: 'job'; pid: number | null };
  const observations: BarrierObservation[] = [];
  let withdrawn = false;
  let jobOnly = false;
  let resumedAbsent = false;
  const service = createLaunchdService({ root }, {
    ...dependencies,
    readOwner: async home => {
      const owner = await dependencies.readOwner(home);
      observations.push({ kind: 'lock', owner: owner === null ? null : { ...owner } });
      return owner;
    },
    stopOwner: async (home, owner) => {
      if (jobOnly) expect.soft(observations.slice(-3)).toEqual([
        { kind: 'lock', owner }, { kind: 'job', pid: owner.pid }, { kind: 'lock', owner },
      ]);
      observations.length = 0;
      await dependencies.stopOwner(home, owner);
    },
    unlink: async path => {
      await dependencies.unlink(path);
      if (String(path) === plistPath) { withdrawn = true; observations.length = 0; }
    },
    run: async (args, timeout) => {
      if (args[0] === 'bootstrap') { jobOnly = true; withdrawn = false; observations.length = 0; }
      if (args[0] === 'bootout') {
        expect.soft(withdrawn || resumedAbsent).toBe(true);
        expect.soft((await readRegistration({ target, requestedRoot: root })).kind).toBe('absent');
        const last = observations.slice(-2);
        expect.soft(last[0]?.kind).toBe('lock');
        expect.soft(last[1]).toEqual({ kind: 'job', pid: null });
        if (!jobOnly) expect.soft(last[0]).toEqual({ kind: 'lock', owner: null });
        observations.length = 0;
      }
      const result = await dependencies.run(args, timeout);
      if (args[0] === 'print' && args[1] !== 'gui/501' && result.ok) {
        const ownPid = /^\tpid = ([0-9]+)$/m.exec(result.stdout);
        observations.push({ kind: 'job', pid: ownPid ? Number(ownPid[1]) : null });
      } else if (args[0] === 'print' && result.stderr === 'Could not find service') observations.push({ kind: 'job', pid: null });
      return result;
    },
  });
  const installTransaction = service.install;
  const uninstallTransaction = service.uninstall;
  service.install = async input => { observations.length = 0; withdrawn = false; jobOnly = false; resumedAbsent = false; return installTransaction(input); };
  service.uninstall = async () => {
    observations.length = 0; withdrawn = false;
    resumedAbsent = (await readRegistration({ target, requestedRoot: root })).kind === 'absent';
    jobOnly = resumedAbsent;
    return uninstallTransaction();
  };
  return { root, target, plistPath, calls, fileCalls, temporaryFiles, state, content, seed, service, launchChild, checkChildRegistration, exitChild, cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function withLaunchd(run: (fixture: LaunchdFixture) => Promise<void>, overrides: NonNullable<Parameters<typeof createLaunchdService>[1]> = {}) {
  const fixture = await launchdFixture(overrides);
  try { await run(fixture); } finally { await fixture.cleanup(); }
}
const bootouts = (fixture: LaunchdFixture) => fixture.calls.filter(call => call.startsWith('bootout '));

it('launchd installs canonical bytes and root-local logs, and loaded stopped reinstall stays stopped', async () => {
  await withLaunchd(async f => {
    expect((await f.service.install()).kind).toBe('installed');
    expect(await readFile(f.plistPath)).toEqual(f.content());
    expect(await readFile(posix.join(f.root, 'service.log'), 'utf8')).toBe('');
    f.state.owner = null; f.state.pid = null; f.calls.length = 0;
    expect((await f.service.install()).kind).toBe('already-installed');
    expect(f.calls.some(call => /bootstrap|kickstart|withdraw|stop /.test(call))).toBe(false);
    expect((await f.service.status()).running).toBe(false);
  });
});
it('launchd refuses a leftover loaded job without a plist', async () => {
  await withLaunchd(async f => { f.state.loaded = true; expect((await f.service.install()).kind).toBe('install_refused'); expect(bootouts(f)).toEqual([]); expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent'); });
});
it.each(['error', 'timeout'] as const)('launchd partial bootstrap %s never grants stop or unload authority', async bootstrap => {
  await withLaunchd(async f => {
    f.state.bootstrap = bootstrap;
    const result = await f.service.install();
    expect(result.kind).toBe('install_incomplete'); expect(result.retained).toBeNull();
    expect(f.state.owner).toBeNull(); expect(f.state.loaded).toBe(true);
    expect(result.leftovers).toContain(`job gui/501/${LAUNCHD_LABEL}: loaded`);
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toEqual(['print gui/501', printJob, `bootstrap gui/501 ${f.plistPath}`, 'withdraw', printJob]);
    expect(bootouts(f)).toEqual([]); expect(f.calls.filter(call => call.startsWith('stop '))).toEqual([]);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
    expect((await f.service.uninstall()).kind).toBe('uninstalled');
    expect(bootouts(f)).toHaveLength(1);
  });
});
it('launchd successful replacement and failed verification each run their own withdrawal barrier', async () => {
  await withLaunchd(async f => {
    await f.seed(49102); f.state.verifyFails = true;
    const result = await f.service.install({ port: 49101 });
    expect(result.kind).toBe('install_rolled_back'); expect(result.retained).toBeNull();
    expect(f.state.owner).toBeNull();
    expect(await readFile(f.plistPath)).toEqual(f.content(49102));
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('ours');
    expect(bootouts(f)).toHaveLength(2);
    expect(f.calls.filter(call => call === 'withdraw')).toHaveLength(2);
    expect(f.calls.filter(call => call.startsWith('bootstrap '))).toHaveLength(1);
    expect(f.state.loaded).toBe(false);
  });
});
it.each(['error', 'timeout', 'retained'] as const)('launchd bootout %s leaves absent bytes and makes exactly one following print', async bootout => {
  await withLaunchd(async f => {
    await f.seed(); f.state.bootout = bootout;
    const result = await f.service.uninstall();
    expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain(`jobPresent=${bootout !== 'timeout'}`);
    expect(result.retained).toBeNull(); expect(f.state.owner).toBeNull(); expect(f.state.loaded).toBe(bootout !== 'timeout');
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toEqual([printJob, 'withdraw', printJob, bootoutJob, printJob]);
    expect(bootouts(f)).toHaveLength(1);
    const index = f.calls.findIndex(call => call.startsWith('bootout '));
    expect(f.calls.slice(index + 1)).toEqual([`print gui/501/${LAUNCHD_LABEL}`]);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
  });
});
it.each(['uninstall', 'replacement', 'rollback'] as const)('launchd %s query failure restores only the outcome row bytes', async mode => {
  await withLaunchd(async f => {
    await f.seed(49102);
    if (mode === 'rollback') f.state.verifyFails = true;
    let removals = 0;
    f.state.afterUnlink = async () => { if (++removals === (mode === 'rollback' ? 2 : 1)) f.state.queryFailure = true; };
    const result = mode === 'uninstall' ? await f.service.uninstall() : await f.service.install({ port: 49101 });
    expect(result.kind).toBe(mode === 'uninstall' ? 'uninstall_rolled_back' : mode === 'replacement' ? 'install_rolled_back' : 'install_incomplete');
    expect(await readFile(f.plistPath)).toEqual(f.content(mode === 'rollback' ? 49101 : 49102));
    expect(bootouts(f)).toHaveLength(mode === 'rollback' ? 1 : 0);
    expect(result.retained).toBeNull(); expect(f.state.owner).toBeNull(); expect(f.state.loaded).toBe(true);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('ours');
    expect(f.calls.slice(f.calls.lastIndexOf('withdraw') + 1)).toEqual([printJob]);
    expect(f.calls.filter(call => call.startsWith('stop '))).toEqual([]);
    expect(f.calls.filter(call => call.startsWith('bootstrap '))).toHaveLength(mode === 'rollback' ? 1 : 0);
  });
});
it.each(['uninstall', 'replacement', 'rollback'] as const)('launchd %s lost stop reply restores nothing and never unloads that job', async mode => {
  await withLaunchd(async f => {
    await f.seed(49102); f.state.stopFails = true;
    if (mode === 'rollback') f.state.verifyFails = true;
    let removals = 0;
    f.state.beforeUnlink = async () => {
      if (++removals === (mode === 'rollback' ? 2 : 1)) { f.state.owner = { ...first }; f.state.pid = first.pid; }
    };
    const result = mode === 'uninstall' ? await f.service.uninstall() : await f.service.install({ port: 49101 });
    expect(result.kind).toBe(mode === 'uninstall' ? 'uninstall_incomplete' : 'install_incomplete');
    expect(result.detail).toContain('stop_unconfirmed'); expect(f.calls.filter(call => call.startsWith('stop '))).toHaveLength(1);
    expect(bootouts(f)).toHaveLength(mode === 'rollback' ? 1 : 0);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
    expect(result.retained).toEqual({ pid: first.pid, startedAt: first.startedAt });
    expect(f.state.owner).toEqual(first); expect(f.state.loaded).toBe(true);
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const lastWithdraw = f.calls.lastIndexOf('withdraw');
    expect(f.calls.slice(lastWithdraw + 1)).toEqual([printJob, `stop ${first.pid}`]);
  });
});
it.each((['replacement', 'rollback'] as const).flatMap(mode =>
  (['before-withdraw', 'after-withdraw', 'before-bootout'] as const).map(race => ({ mode, race })),
))('launchd $mode handles relaunch $race with a visible child lifecycle', async ({ mode, race }) => {
  await withLaunchd(async f => {
    if (mode === 'replacement') await f.seed(49102);
    else f.state.verifyFails = true;
    if (race === 'before-withdraw') f.state.beforeUnlink = async () => { f.launchChild(); await f.checkChildRegistration(); };
    if (race === 'after-withdraw') {
      f.state.afterUnlink = async () => { f.launchChild(); };
      f.state.onPause = async () => {
        if (f.state.child?.phase === 'checking') await f.checkChildRegistration();
        else if (f.state.child?.phase === 'guard-rejected') f.exitChild();
      };
    }
    if (race === 'before-bootout') f.state.beforeCommand = async command => {
      if (command !== 'bootout') return;
      f.launchChild();
      expect((await f.service.status()).manager).toMatchObject({ kind: 'loaded', pid: first.pid });
      await f.checkChildRegistration();
      expect(f.state.pid).toBe(first.pid);
      expect(f.state.owner).toBeNull();
    };
    const result = await f.service.install({ port: 49101 });
    expect(result.kind).toBe(mode === 'replacement' ? 'installed' : 'install_rolled_back');
    expect(f.state.child).toMatchObject({ phase: 'exited', exitCode: 0, work: 0, signals: 0, locks: race === 'before-withdraw' ? 1 : 0 });
    expect(f.state.prematureBootouts).toBe(0);
    expect(f.calls.filter(call => call.startsWith('stop '))).toHaveLength(race === 'before-withdraw' ? 1 : 0);
    expect(bootouts(f)).toHaveLength(1);
    const bootoutIndex = f.calls.findIndex(call => call.startsWith('bootout '));
    expect(f.calls.indexOf('withdraw')).toBeLessThan(bootoutIndex);
    if (race === 'before-withdraw') expect(f.calls.indexOf('child drained 0')).toBeLessThan(bootoutIndex);
    else {
      expect(f.calls).toContain('child visible checking');
      expect(f.calls).toContain('child registration absent');
      if (race === 'after-withdraw') {
        expect(f.calls).toContain('child visible guard-rejected');
        const exitIndex = f.calls.indexOf('child exited 0');
        expect(exitIndex).toBeLessThan(bootoutIndex);
        expect(f.calls.slice(exitIndex + 1, bootoutIndex)).toContain(`print gui/501/${LAUNCHD_LABEL}`);
      } else {
        expect(f.calls).toContain('manager sees rejected child');
        expect(f.calls.indexOf('child born')).toBeGreaterThan(bootoutIndex);
      }
    }
  });
});
it('launchd resumed uninstall refuses a foreign job pid without touching the retained owner', async () => {
  await withLaunchd(async f => {
    f.state.loaded = true; f.state.pid = next.pid; f.state.owner = { ...first };
    const result = await f.service.uninstall();
    expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('foreign_job_pid');
    expect(result.retained).toEqual({ pid: first.pid, startedAt: first.startedAt }); expect(bootouts(f)).toEqual([]);
    expect(f.state.owner).toEqual(first); expect(f.state.loaded).toBe(true);
    expect(f.calls).toEqual([printJob, printJob]);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
  });
});
it('launchd start uses fixed port and kickstart without kill, and status requires an owner', async () => {
  await withLaunchd(async f => {
    await f.seed();
    await expect(f.service.start({ port: 49102 })).rejects.toThrow('not requested port');
    expect(f.calls).toEqual([]);
    expect((await f.service.start()).port).toBe(49101);
    expect(f.calls).toContain(`kickstart gui/501/${LAUNCHD_LABEL}`);
    expect((await f.service.status()).running).toBe(true);
  });
});
it('launchd start kickstarts past a stale owner that failed authentication and waits for its replacement', async () => {
  await withLaunchd(async f => {
    await f.seed();
    const stale = { ...first, startedAt: '2026-10-10T00:00:00.000Z' };
    f.state.owner = stale;
    const started = await f.service.start({ staleOwner: stale });
    expect(f.calls).toContain(`kickstart gui/501/${LAUNCHD_LABEL}`);
    expect(started).toMatchObject({ startedAt: first.startedAt, port: 49101 });
  });
});
it.each(['loaded', 'absent'] as const)('launchd start after a failed bootstrap that left the job %s', async after => {
  await withLaunchd(async f => {
    await f.seed(); f.state.loaded = false; f.state.bootstrap = 'error';
    f.state.beforeCommand = async command => { if (command === 'print' && f.calls.some(call => call.startsWith('bootstrap '))) f.state.loaded = after === 'loaded'; };
    f.state.onPause = () => { f.state.owner = { ...first }; f.state.pid = first.pid; };
    if (after === 'loaded') expect((await f.service.start()).port).toBe(49101);
    else await expect(f.service.start()).rejects.toThrow('error');
    expect(f.calls.filter(call => call.startsWith('bootstrap '))).toHaveLength(1);
    expect(f.calls.some(call => call.startsWith('kickstart '))).toBe(false);
  });
});
it('launchd authenticated rollback waits through minutes of accepted drain without a deadline', async () => {
  await withLaunchd(async f => {
    f.state.verifyFails = true; f.state.delayStop = true;
    f.state.beforeUnlink = async () => { f.state.owner = { ...first }; f.state.pid = first.pid; };
    let rounds = 0;
    f.state.onPause = () => { if (f.calls.some(call => call.startsWith('stop ')) && ++rounds === 500) { f.state.owner = null; f.state.pid = null; } };
    expect((await f.service.install()).kind).toBe('install_rolled_back');
    expect(f.state.clock).toBeGreaterThan(120_000);
    expect(f.calls.filter(call => call.startsWith('stop '))).toHaveLength(1);
    expect(bootouts(f)).toHaveLength(1);
  });
});
it('launchd final uninstall owner stop failure leaves absent registration and never unloads twice', async () => {
  await withLaunchd(async f => {
    await f.seed(); f.state.stopFails = true;
    f.state.beforeCommand = async command => { if (command === 'bootout') f.state.owner = { ...first }; };
    const result = await f.service.uninstall();
    expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('stop_unconfirmed');
    expect(bootouts(f)).toHaveLength(1); expect(f.calls.filter(call => call.startsWith('stop '))).toHaveLength(1);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
  });
});
it('launchd failed initial print cannot authorize unloading an existing job', async () => {
  await withLaunchd(async f => {
    await f.seed(); f.state.queryFailure = true; f.state.bootstrap = 'error';
    f.state.beforeCommand = async command => { if (command === 'bootstrap') f.state.queryFailure = false; };
    expect((await f.service.install()).kind).toBe('install_refused');
    expect(f.calls.some(call => call.startsWith('bootstrap'))).toBe(false);
    expect(bootouts(f)).toEqual([]); expect(await readFile(f.plistPath)).toEqual(f.content());
  });
});
it('launchd changed accepted bytes before withdrawal refuse without deleting the new registration', async () => {
  await withLaunchd(async f => {
    await f.seed();
    f.state.beforeCommand = async command => { if (command === 'print') await writeFile(f.plistPath, f.content(49102)); };
    expect((await f.service.uninstall()).kind).toBe('uninstall_incomplete');
    expect(await readFile(f.plistPath)).toEqual(f.content(49102)); expect(bootouts(f)).toEqual([]);
  });
});
it('launchd failed atomic rename removes its temporary file and never loads a job', async () => {
  await withLaunchd(async f => {
    f.state.renameFails = true;
    expect((await f.service.install()).kind).toBe('install_rolled_back');
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
    expect(await f.temporaryFiles()).toEqual([]);
    expect(f.calls.some(call => call.startsWith('bootstrap '))).toBe(false);
  });
});
it.each(['0x10', '1e3', '-1', '1.5', '9007199254740993'])('launchd status classifies malformed pid %s as unknown', async pid => {
  await withLaunchd(async f => {
    await f.seed(); f.state.pidText = pid;
    expect((await f.service.status()).manager.kind).toBe('unknown');
    expect((await f.service.uninstall()).kind).toBe('uninstall_incomplete');
    expect(await readFile(f.plistPath)).toEqual(f.content()); expect(bootouts(f)).toEqual([]);
  });
});
it('launchd stops a detached owner before writing, and a later rollback reports it stopped', async () => {
  await withLaunchd(async f => {
    const owner = { ...first, startedAt: 'detached' }; f.state.owner = owner; f.state.ownerWork = 3;
    let bootstrapped = false; let prints = 0;
    f.state.beforeCommand = async command => {
      if (command === 'bootstrap') bootstrapped = true;
      if (command === 'print' && bootstrapped) f.state.queryFailure = ++prints === 1;
    };
    const result = await f.service.install();
    expect(result.kind).toBe('install_incomplete'); expect(result.retained).toBeNull();
    expect(result.detail).toContain('the detached daemon was stopped');
    expect(f.state.owner).toBeNull(); expect(f.state.loaded).toBe(false);
    expect(f.calls.indexOf(`stop ${owner.pid}`)).toBeLessThan(f.calls.indexOf(`bootstrap gui/501 ${f.plistPath}`));
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(bootouts(f)).toHaveLength(1);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
  });
});
it.each(['replacement', 'rollback'] as const)('launchd %s unload-unknown never restores or enters another barrier', async mode => {
  await withLaunchd(async f => {
    await f.seed(49102); f.state.verifyFails = mode === 'rollback';
    let unloads = 0;
    f.state.beforeCommand = async command => {
      if (command === 'bootout' && ++unloads === (mode === 'rollback' ? 2 : 1)) f.state.bootout = 'timeout';
    };
    const result = await f.service.install({ port: 49101 });
    expect(result.kind).toBe('install_incomplete'); expect(result.leftovers).toContain('jobPresent=false');
    expect(result.retained).toBeNull(); expect(f.state.owner).toBeNull(); expect(f.state.loaded).toBe(false);
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls.slice(f.calls.lastIndexOf(bootoutJob) + 1)).toEqual([printJob]);
    expect(f.calls.filter(call => call.startsWith('stop '))).toEqual([]);
    expect(bootouts(f)).toHaveLength(mode === 'rollback' ? 2 : 1);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
    expect(f.calls.filter(call => call.startsWith('bootstrap '))).toHaveLength(mode === 'rollback' ? 1 : 0);
  });
});
it('launchd unknown post-bootout print records unknown and keeps registration withdrawn', async () => {
  await withLaunchd(async f => {
    await f.seed();
    f.state.beforeCommand = async command => { if (command === 'bootout') f.state.queryFailure = true; };
    const result = await f.service.uninstall();
    expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('jobPresent=unknown');
    expect(bootouts(f)).toHaveLength(1);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
  });
});
it('launchd failed restoration is incomplete and describes the remaining state', async () => {
  await withLaunchd(async f => {
    await f.seed();
    f.state.afterUnlink = async () => { f.state.queryFailure = true; f.state.renameFails = true; };
    const result = await f.service.uninstall();
    expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('restore failed: rename failed');
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
    expect(bootouts(f)).toEqual([]);
  });
});

const jobHeader = `gui/501/${LAUNCHD_LABEL} = {`;
const invalidJobOutputs = [
  { label: 'nested-only pid', raw: `${jobHeader}\n\tstate = waiting\n\tnested = {\n\t\tpid = ${first.pid}\n\t}\n}` },
  { label: 'duplicate pid', raw: `${jobHeader}\n\tstate = running\n\tpid = ${first.pid}\n\tpid = ${next.pid}\n}` },
  { label: 'duplicate state', raw: `${jobHeader}\n\tstate = waiting\n\tstate = running\n}` },
  { label: 'nested-only state', raw: `${jobHeader}\n\tnested = {\n\t\tstate = running\n\t}\n}` },
  { label: 'trailing foreign record', raw: `${jobHeader}\n\tstate = waiting\n}\nforeign = {\n\tpid = ${first.pid}\n}` },
  { label: 'duplicate target record', raw: `${jobHeader}\n\tstate = waiting\n}\n${jobHeader}\n\tstate = waiting\n}` },
  { label: 'missing closing brace', raw: `${jobHeader}\n\tstate = waiting\n` },
  { label: 'unindented pid', raw: `${jobHeader}\n\tstate = running\npid = ${first.pid}\n}` },
  { label: 'structured pid', raw: `${jobHeader}\n\tstate = waiting\n\tpid = {\n\t\tvalue = ${first.pid}\n\t}\n}` },
  { label: 'empty pid', raw: `${jobHeader}\n\tstate = running\n\tpid = \n}` },
  { label: 'malformed pid', raw: `${jobHeader}\n\tstate = running\n\tpid = 0x10\n}` },
  { label: 'inline nested pid', raw: `${jobHeader}\n\tstate = waiting\n\tnested = { pid = ${first.pid} }\n}` },
];
it.each((['replacement', 'rollback'] as const).flatMap(mode => invalidJobOutputs.map(sample => ({ mode, ...sample }))))('launchd $mode rejects $label in B2 without stop or unload and restores exact bytes', async ({ mode, ...sample }) => {
    await withLaunchd(async f => {
      await f.seed(49102);
      f.state.verifyFails = mode === 'rollback';
      let removals = 0;
      f.state.afterUnlink = async () => {
        if (++removals !== (mode === 'rollback' ? 2 : 1)) return;
        f.state.owner = { ...first }; f.state.pid = first.pid;
        f.state.queryOutput = sample.raw;
      };
      const result = await f.service.install({ port: 49101 });
      expect(result.detail, sample.label).toContain('query_failed');
      expect(result.kind, sample.label).toBe('install_incomplete');
      expect(f.calls.filter(call => call.startsWith('stop ')), sample.label).toEqual([]);
      expect(bootouts(f), sample.label).toHaveLength(mode === 'rollback' ? 1 : 0);
      expect(await readFile(f.plistPath), sample.label).toEqual(f.content(mode === 'rollback' ? 49101 : 49102));
      expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind, sample.label).toBe('ours');
      expect(f.state.owner, sample.label).toEqual(first);
    });
});
it.each(['uninstall', 'replacement', 'rollback'] as const)('launchd %s B2 timeout cannot authorize stop or unload', async mode => {
  await withLaunchd(async f => {
    await f.seed(49102); f.state.verifyFails = mode === 'rollback';
    let removals = 0;
    f.state.afterUnlink = async () => { if (++removals === (mode === 'rollback' ? 2 : 1)) f.state.queryTimeout = true; };
    const result = mode === 'uninstall' ? await f.service.uninstall() : await f.service.install({ port: 49101 });
    expect(result.detail).toContain('query_failed');
    expect(result.detail).toContain('timed out');
    expect(result.kind).toBe(mode === 'uninstall' ? 'uninstall_rolled_back' : mode === 'replacement' ? 'install_rolled_back' : 'install_incomplete');
    expect(f.calls.filter(call => call.startsWith('stop '))).toEqual([]);
    expect(bootouts(f)).toHaveLength(mode === 'rollback' ? 1 : 0);
    expect(await readFile(f.plistPath)).toEqual(f.content(mode === 'rollback' ? 49101 : 49102));
  });
});
it('launchd reads only own state and pid beside native-shaped nested state fields', async () => {
  await withLaunchd(async f => {
    await f.seed();
    f.state.queryOutput = `${jobHeader}\n\tstate = running\n\tresource coalition = {\n\t\tstate = active\n\t}\n\tpid = ${first.pid}\n}\n`;
    expect((await f.service.status()).manager).toMatchObject({ kind: 'loaded', pid: first.pid });
  });
});
it('launchd status reads the exits from the same print, and has none without a job (s17b)', async () => {
  await withLaunchd(async f => {
    await f.seed();
    f.calls.length = 0;
    f.state.queryOutput = `${jobHeader}\n\tstate = running\n\truns = 3\n\tpid = ${first.pid}\n\tlast terminating signal = Killed: 9\n\tresource coalition = {\n\t\tstate = active\n\t}\n}\n`;
    const status = await f.service.status();
    expect(status.manager).toMatchObject({ kind: 'loaded', pid: first.pid });
    expect(status.exits).toEqual({ manager: 'launchd', runs: 3, lastExitCode: null, lastExitText: null, lastSignal: 'Killed: 9' });
    expect(f.calls).toEqual([printJob]);
    f.state.loaded = false;
    const absent = await f.service.status();
    expect(absent.manager.kind).toBe('absent');
    expect(absent.exits).toBeUndefined();
  });
});

const printJob = `print gui/501/${LAUNCHD_LABEL}`;
const bootoutJob = `bootout gui/501/${LAUNCHD_LABEL}`;
it.each((['fresh', 'replacement'] as const).flatMap(mode =>
  (['open', 'write', 'sync', 'close', 'rename'] as const).map(fault => ({ mode, fault })),
))('launchd $mode atomic $fault failure restores exact bytes and cleans its temporary', async ({ mode, fault }) => {
  await withLaunchd(async f => {
    if (mode === 'replacement') await f.seed(49102);
    f.state.fileFault = fault;
    const result = await f.service.install({ port: 49101 });
    expect(result.kind).toBe('install_rolled_back');
    expect(result.detail).toContain(`${fault} failed`);
    expect(result.retained).toBeNull();
    expect(f.state.owner).toBeNull(); expect(f.state.loaded).toBe(false);
    expect(await f.temporaryFiles()).toEqual([]);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe(mode === 'replacement' ? 'ours' : 'absent');
    if (mode === 'replacement') expect(await readFile(f.plistPath)).toEqual(f.content(49102));
    else await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toEqual(mode === 'replacement'
      ? ['print gui/501', printJob, 'withdraw', printJob, bootoutJob, printJob, printJob]
      : ['print gui/501', printJob, printJob]);
    const steps = ['open', 'write', 'sync', 'close', 'rename'];
    const failedSteps = steps.slice(0, steps.indexOf(fault) + 1);
    if (fault === 'write' || fault === 'sync') failedSteps.push('close');
    if (fault !== 'open') failedSteps.push('cleanup');
    expect(f.fileCalls).toEqual(mode === 'replacement' ? [...failedSteps, ...steps] : failedSteps);
  });
});
it.each((['fresh', 'replacement'] as const).flatMap(mode =>
  (['write', 'sync', 'close', 'rename'] as const).map(fault => ({ mode, fault })),
))('launchd $mode cleanup failure after $fault reports the actual remaining temporary as incomplete', async ({ mode, fault }) => {
  await withLaunchd(async f => {
    if (mode === 'replacement') await f.seed(49102);
    f.state.fileFault = fault; f.state.cleanupFails = true;
    const result = await f.service.install({ port: 49101 });
    const temporary = await f.temporaryFiles();
    expect(temporary).toHaveLength(1);
    const remaining = temporary[0];
    if (!remaining) throw new Error('Expected temporary file');
    expect(await readFile(remaining)).toEqual(fault === 'write' ? Buffer.alloc(0) : f.content());
    expect(result.kind).toBe('install_incomplete');
    expect(result.leftovers).toContain(`temporary file ${temporary[0]}`);
    expect(result.detail).toContain('cleanup failed');
    expect(result.retained).toBeNull(); expect(f.state.owner).toBeNull(); expect(f.state.loaded).toBe(false);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe(mode === 'replacement' ? 'ours' : 'absent');
    if (mode === 'replacement') expect(await readFile(f.plistPath)).toEqual(f.content(49102));
    else await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toEqual(mode === 'replacement'
      ? ['print gui/501', printJob, 'withdraw', printJob, bootoutJob, printJob, printJob]
      : ['print gui/501', printJob, printJob]);
    f.state.cleanupFails = false;
    const nextResult = await f.service.install({ port: 49101 });
    expect(nextResult.kind).toBe('installed');
    expect(nextResult.leftovers).not.toContain(`temporary file ${remaining}`);
    expect(await f.temporaryFiles()).toEqual(temporary);
  });
});
it.each(['uninstall', 'replacement'] as const)('launchd %s B1 unlink failure preserves bytes and the live owner without drain', async mode => {
  await withLaunchd(async f => {
    await f.seed(49102);
    f.state.plistUnlinkFails = true;
    f.state.beforeUnlink = async () => { f.launchChild(); await f.checkChildRegistration(); };
    const result = mode === 'uninstall' ? await f.service.uninstall() : await f.service.install({ port: 49101 });
    expect(result.kind).toBe(mode === 'uninstall' ? 'uninstall_incomplete' : 'install_incomplete');
    expect(result.detail).toContain('plist unlink failed');
    expect(result.retained).toEqual({ pid: first.pid, startedAt: first.startedAt });
    expect(f.state.owner).toEqual(first);
    expect(f.state.child).toMatchObject({ phase: 'owner', pid: first.pid, work: 1, locks: 1, signals: 0, exitCode: null });
    expect(f.state.loaded).toBe(true); expect(f.state.pid).toBe(first.pid);
    expect(await readFile(f.plistPath)).toEqual(f.content(49102));
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('ours');
    expect(f.calls).toEqual([...(mode === 'replacement' ? ['print gui/501'] : []), printJob, 'child born', 'child registration ours']);
  });
});
it.each((['fresh', 'replacement'] as const).flatMap(mode =>
  (['service.log', 'service.err.log'] as const).flatMap(name =>
    (['open', 'close'] as const).map(operation => ({ mode, name, operation })))),
)('launchd $mode $name $operation failure rolls back without bootstrap', async ({ mode, name, operation }) => {
  await withLaunchd(async f => {
    if (mode === 'replacement') await f.seed(49102);
    f.state.logFault = { name: posix.join(f.root, name), operation };
    const result = await f.service.install({ port: 49101 });
    expect(result.kind).toBe('install_rolled_back'); expect(result.detail).toContain(`log ${operation} failed`);
    expect(result.retained).toBeNull(); expect(f.state.owner).toBeNull(); expect(f.state.loaded).toBe(false);
    expect(await f.temporaryFiles()).toEqual([]);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe(mode === 'replacement' ? 'ours' : 'absent');
    if (mode === 'replacement') expect(await readFile(f.plistPath)).toEqual(f.content(49102));
    else await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toEqual(mode === 'replacement'
      ? ['print gui/501', printJob, 'withdraw', printJob, bootoutJob, printJob, printJob]
      : ['print gui/501', printJob, 'withdraw', printJob]);
  });
});
it('launchd successful uninstall from ours drains accepted work and removes registration', async () => {
  await withLaunchd(async f => {
    await f.seed(); f.launchChild(); await f.checkChildRegistration(); f.calls.length = 0;
    const result = await f.service.uninstall();
    expect(result).toEqual({ kind: 'uninstalled', detail: 'Uninstalled', retained: null, leftovers: [] });
    expect(f.state.owner).toBeNull(); expect(f.state.loaded).toBe(false); expect(f.state.pid).toBeNull();
    expect(f.state.child).toMatchObject({ phase: 'exited', work: 0, signals: 0, exitCode: 0, locks: 1 });
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toEqual([printJob, 'child visible owner', 'withdraw', printJob, 'child visible owner', `stop ${first.pid}`, 'child drained 0', printJob, bootoutJob, printJob]);
  });
});
it.each(['success', 'error', 'timeout', 'retained', 'unknown'] as const)('launchd resumed uninstall %s retains self-hosted identity and accepted work', async outcome => {
  await withLaunchd(async f => {
    f.state.loaded = true; f.state.owner = { ...first }; f.state.ownerWork = 3;
    const owner = f.state.owner;
    f.calls.length = 0;
    if (outcome === 'unknown') f.state.beforeCommand = async command => { if (command === 'bootout') f.state.queryFailure = true; };
    else f.state.bootout = outcome;
    const result = await f.service.uninstall();
    expect(result.kind).toBe(outcome === 'success' ? 'uninstalled' : 'uninstall_incomplete');
    expect(result.retained).toEqual({ pid: first.pid, startedAt: first.startedAt });
    expect(f.state.owner).toBe(owner); expect(f.state.ownerWork).toBe(3);
    expect(f.state.loaded).toBe(outcome === 'error' || outcome === 'retained');
    if (outcome !== 'success') expect(result.leftovers).toContain(`jobPresent=${outcome === 'unknown' ? 'unknown' : outcome === 'error' || outcome === 'retained'}`);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toEqual([printJob, printJob, bootoutJob, printJob]);
  });
});

it('launchd failed deletion during unproven rollback reports exact remaining new bytes', async () => {
  await withLaunchd(async f => {
    f.state.bootstrap = 'error'; f.state.plistUnlinkFails = true;
    const result = await f.service.install();
    expect(result.kind).toBe('install_incomplete'); expect(result.detail).toContain('restore failed: plist unlink failed');
    expect(result.retained).toBeNull(); expect(f.state.owner).toBeNull(); expect(f.state.loaded).toBe(true);
    expect(await readFile(f.plistPath)).toEqual(f.content());
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('ours');
    expect(result.leftovers).toContain(`plist ${f.plistPath}: ours`);
    expect(f.calls).toEqual(['print gui/501', printJob, `bootstrap gui/501 ${f.plistPath}`]);
    expect(await f.temporaryFiles()).toEqual([]);
  });
});
it.each(['query_failed', 'stop_unconfirmed'] as const)('launchd resumed uninstall %s keeps absent bytes and never unloads', async failure => {
  await withLaunchd(async f => {
    f.state.loaded = true; f.state.owner = { ...first }; f.state.pid = first.pid; f.state.ownerWork = 2;
    const owner = f.state.owner;
    let prints = 0;
    f.state.beforeCommand = async command => { if (command === 'print' && ++prints === 2) f.state.queryFailure = failure === 'query_failed'; };
    f.state.stopFails = failure === 'stop_unconfirmed';
    const result = await f.service.uninstall();
    expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain(failure);
    expect(result.retained).toEqual({ pid: first.pid, startedAt: first.startedAt });
    expect(f.state.owner).toBe(owner); expect(f.state.ownerWork).toBe(2); expect(f.state.loaded).toBe(true); expect(f.state.pid).toBe(first.pid);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toEqual([printJob, printJob, ...(failure === 'stop_unconfirmed' ? [`stop ${first.pid}`] : [])]);
  });
});

it('launchd preserves the stopped registered port when the next free port differs', async () => {
  const freePort = vi.fn(async () => 32124);
  await withLaunchd(async f => {
    await f.seed(32123);
    const before = await readFile(f.plistPath);
    const result = await f.service.install();
    expect(result.kind).toBe('already-installed');
    expect(await readFile(f.plistPath)).toEqual(before);
    expect(f.calls).toEqual(['print gui/501', printJob]);
    expect(f.fileCalls).toEqual([]);
    expect(f.state.owner).toBeNull(); expect(f.state.pid).toBeNull();
    expect(freePort).not.toHaveBeenCalled();
  }, { freePort });
});

it.each(['explicit replacement', 'lost manager state'] as const)('launchd handles %s without choosing a free port', async mode => {
  const freePort = vi.fn(async () => 32124);
  await withLaunchd(async f => {
    await f.seed(32123);
    if (mode === 'lost manager state') f.state.loaded = false;
    const port = mode === 'explicit replacement' ? 32125 : 32123;
    const result = await f.service.install(mode === 'explicit replacement' ? { port } : {});
    expect(result.kind).toBe('installed');
    expect(await readFile(f.plistPath)).toEqual(f.content(port));
    expect(f.state.owner?.listen).toBe(`127.0.0.1:${port}`);
    expect(f.state.loaded).toBe(true); expect(freePort).not.toHaveBeenCalled();
    expect(f.calls.filter(call => !call.startsWith('print '))).toEqual([
      ...(mode === 'explicit replacement' ? ['withdraw', bootoutJob] : []),
      `bootstrap gui/501 ${f.plistPath}`,
    ]);
    if (mode === 'lost manager state') expect(f.fileCalls).toEqual([]);
  }, { freePort });
});

it.each(['absent', 'identity', 'listen'] as const)('launchd resumed owner_unproven after O3 %s retains identity and work without unloading or restoring', async change => {
  const changed = change === 'absent' ? null : change === 'identity' ? { ...first, startedAt: 'different-incarnation' } : { ...first, listen: '127.0.0.1:32124' };
  const readOwner = vi.fn(async (): Promise<PidLockInfo | null> => first)
    .mockResolvedValueOnce(first).mockResolvedValueOnce(changed)
    .mockResolvedValueOnce(first).mockResolvedValueOnce(changed);
  await withLaunchd(async f => {
    f.state.loaded = true; f.state.pid = first.pid; f.state.owner = first; f.state.ownerWork = 3;
    const result = await f.service.uninstall();
    expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('owner_unproven');
    expect(result.detail).toContain(String(first.pid));
    expect(result.retained).toEqual({ pid: first.pid, startedAt: first.startedAt });
    expect(f.state.owner).toBe(first); expect(f.state.ownerWork).toBe(3);
    expect(f.state.loaded).toBe(true); expect(f.state.pid).toBe(first.pid);
    expect(f.calls).toEqual([printJob, printJob, printJob]);
    expect(f.state.clock).toBe(250); expect(readOwner).toHaveBeenCalledTimes(5);
    expect(f.fileCalls).toEqual([]);
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
  }, { readOwner });
});

async function composedOwner() {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready');process.stdin.once('data',()=>process.exit(0))"], { stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', () => resolve()); });
  if (!child.pid) throw new Error('Missing composed fixture child');
  const pid = child.pid;
  const credential = 'cd'.repeat(32);
  const server = createServer();
  const state = {
    status: 0, stops: 0, rejectEndpoint: false, loseReply: false, draining: false, work: ['accepted-work'],
    onStatus: async () => {}, onStop: async () => {},
  };
  const sockets = createSocketServer({
    server, credential,
    info: { type: 'serverInfo', machineId: machineIdSchema.parse(randomUUID()), version: 'test', protocolVersion: PROTOCOL_VERSION },
    detached: () => undefined,
    request: async (peer, request) => {
      if (request.method === 'admin' && request.payload.type === 'daemonStatus') {
        state.status++;
        await state.onStatus();
        peer.send({ type: 'response', id: request.id, method: 'admin', payload: { kind: 'daemonStatus', status: {
          installed: false, running: true, selfHosted: true, version: 'test', supported: true, pid: state.rejectEndpoint ? pid + 1 : pid,
        } } });
      } else if (request.method === 'machine' && request.payload.type === 'stopHost') {
        state.stops++; state.draining = true;
        await state.onStop();
        if (!state.loseReply) peer.send({ type: 'response', id: request.id, method: 'machine', payload: { type: 'done', message: 'Draining' } });
      } else throw new Error('Unexpected composed owner request');
    },
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing composed fixture port');
  const old: PidLockInfo = { pid, startedAt: new Date().toISOString(), listen: `127.0.0.1:${address.port}` };
  const replacement = { ...old, startedAt: new Date(Date.now() + 1).toISOString() };
  const finish = async () => {
    if (child.exitCode !== null) return;
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.stdin.end('drain complete'); });
    expect(child.exitCode).toBe(0); expect(child.signalCode).toBeNull();
    state.work = []; state.draining = false;
  };
  return { state, old, replacement, credential, child, finish, close: async () => {
    await sockets.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await finish();
  } };
}

it.each(['before-O1', 'stale-lock endpoint mismatch', 'O2-O3', 'O3-O4'] as const)('launchd rollback composes PID generation reuse at %s with real O4', async boundary => {
  const endpoint = await composedOwner();
  const generations = new Map<number, { generation: number; manager: boolean; work: string[] }>();
  generations.set(endpoint.old.pid, { generation: 0, manager: true, work: ['old-work'] });
  let f: LaunchdFixture;
  let cleanup = async () => {};
  let withdrawn = false;
  let reads = 0;
  const events: string[] = [];
  const publish = async (lock: PidLockInfo) => {
    f.state.owner = lock;
    await writeFile(join(f.root, 'daemon.pid'), JSON.stringify(lock));
  };
  const reuse = async (stale: boolean) => {
    generations.set(endpoint.old.pid, { generation: 1, manager: stale, work: stale ? [] : ['replacement-work'] });
    events.push('generation 1');
    if (!stale) { f.state.pid = null; await publish(endpoint.replacement); }
  };
  try {
    f = await launchdFixture({
      readOwner: async () => {
        if (!withdrawn) return f.state.owner;
        reads++;
        if (reads === 1) events.push('O1');
        if (reads === 2) {
          events.push('O3');
          if (boundary === 'O2-O3') await reuse(false);
        }
        return f.state.owner;
      },
      stopOwner: async (home, lock) => { events.push('O4'); await stopVerifiedOwner(home, lock); },
    });
    cleanup = f.cleanup;
    await writeFile(join(f.root, 'local-credential'), endpoint.credential);
    f.state.verifyFails = true;
    f.state.afterUnlink = async () => {
      withdrawn = true; f.state.pid = endpoint.old.pid; await publish(endpoint.old);
      if (boundary === 'before-O1') await reuse(false);
    };
    f.state.beforeCommand = async command => {
      if (withdrawn && command === 'print') {
        const live = generations.get(endpoint.old.pid);
        f.state.pid = live?.manager ? endpoint.old.pid : null;
      }
      if (withdrawn && command === 'print' && reads === 1) {
        events.push('O2');
        if (boundary === 'stale-lock endpoint mismatch') { await reuse(true); endpoint.state.rejectEndpoint = true; }
      }
    };
    endpoint.state.onStatus = async () => {
      events.push('authenticated status');
      if (boundary === 'O3-O4') await reuse(false);
    };
    const result = await f.service.install();
    expect(result.kind).toBe('install_incomplete');
    expect(endpoint.state.stops).toBe(0);
    expect(endpoint.state.work).toEqual(['accepted-work']);
    expect(endpoint.child.signalCode).toBeNull();
    expect(endpoint.child.exitCode).toBeNull();
    expect(generations.get(endpoint.old.pid)).toEqual({ generation: 1, manager: boundary === 'stale-lock endpoint mismatch', work: boundary === 'stale-lock endpoint mismatch' ? [] : ['replacement-work'] });
    const retained = boundary === 'stale-lock endpoint mismatch' ? endpoint.old : endpoint.replacement;
    expect(await readFile(join(f.root, 'daemon.pid'), 'utf8')).toBe(JSON.stringify(retained));
    expect(f.state.owner).toEqual(retained);
    expect(result.retained).toEqual({ pid: retained.pid, startedAt: retained.startedAt });
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    if (boundary === 'stale-lock endpoint mismatch' || boundary === 'O3-O4') {
      expect(result.detail).toContain('stop_unconfirmed');
      expect(bootouts(f)).toEqual([]);
      expect(endpoint.state.status).toBe(1);
      expect(events.slice(0, 4)).toEqual(boundary === 'stale-lock endpoint mismatch' ? ['O1', 'O2', 'generation 1', 'O3'] : ['O1', 'O2', 'O3', 'O4']);
    } else {
      expect(endpoint.state.status).toBe(0);
      expect(bootouts(f)).toHaveLength(1);
    }
  } finally { await cleanup(); await endpoint.close(); }
});

it.each(['old-child-still-visible', 'same-pid-reused-after-reap', 'old-child-visible-through-second-round'] as const)('launchd literal O1-O2 lock change preserves the new owner: %s', async interleaving => {
  const endpoint = await composedOwner();
  const replacement = { ...endpoint.replacement, pid: interleaving !== 'same-pid-reused-after-reap' ? endpoint.old.pid + 1 : endpoint.old.pid };
  const processes = new Map<number, { generation: number; manager: boolean; work: string[]; signals: number }>();
  processes.set(endpoint.old.pid, { generation: 0, manager: true, work: [] , signals: 0 });
  const events: string[] = [];
  let f: LaunchdFixture;
  let cleanup = async () => {};
  let withdrawn = false;
  let changed = false;
  let reads = 0;
  let waits = 0;
  const stop = vi.fn(stopVerifiedOwner);
  const publish = async (lock: PidLockInfo) => {
    await writeFile(join(f.root, 'daemon.pid'), JSON.stringify(lock));
    f.state.owner = lock;
  };
  try {
    f = await launchdFixture({
      readOwner: async () => {
        if (!withdrawn) return f.state.owner;
        const bytes = await readFile(join(f.root, 'daemon.pid'), 'utf8');
        const lock: PidLockInfo = JSON.parse(bytes);
        reads++;
        events.push(`lock ${reads}: ${bytes}`);
        return lock;
      },
      stopOwner: stop,
    });
    cleanup = f.cleanup;
    await writeFile(join(f.root, 'local-credential'), endpoint.credential);
    f.state.verifyFails = true;
    f.state.afterUnlink = async () => {
      withdrawn = true;
      await publish(endpoint.old);
      events.push('withdrawn');
    };
    f.state.beforeCommand = async command => {
      if (withdrawn && command === 'bootout') {
        expect.soft(events.at(-1)).toBe('manager: null');
        events.push('bootout');
      }
      if (!withdrawn || command !== 'print') return;
      if (!changed && reads === 1) {
        expect(await readFile(join(f.root, 'daemon.pid'), 'utf8')).toBe(JSON.stringify(endpoint.old));
        processes.set(replacement.pid, { generation: 1, manager: false, work: ['replacement-work'], signals: 0 });
        await publish(replacement);
        changed = true;
        events.push(`published: ${await readFile(join(f.root, 'daemon.pid'), 'utf8')}`);
      }
      f.state.pid = [...processes].find(([, process]) => process.manager)?.[0] ?? null;
      events.push(`manager: ${f.state.pid}`);
    };
    f.state.onPause = async () => {
      if (!changed) return;
      waits++;
      expect(stop).not.toHaveBeenCalled();
      expect(bootouts(f)).toEqual([]);
      if (interleaving === 'old-child-visible-through-second-round' && waits === 1) {
        events.push('wait with old child visible');
        return;
      }
      const old = processes.get(endpoint.old.pid);
      if (old?.generation === 0) processes.delete(endpoint.old.pid);
      events.push('old child reaped');
    };
    const result = await f.service.install();
    expect(events.slice(0, 4)).toEqual([
      'withdrawn', `lock 1: ${JSON.stringify(endpoint.old)}`,
      `published: ${JSON.stringify(replacement)}`,
      `manager: ${interleaving !== 'same-pid-reused-after-reap' ? endpoint.old.pid : null}`,
    ]);
    if (interleaving === 'old-child-still-visible') {
      expect(events.slice(4, 8)).toEqual([
        `lock 2: ${JSON.stringify(replacement)}`, 'old child reaped',
        `lock 3: ${JSON.stringify(replacement)}`, 'manager: null',
      ]);
    }
    if (interleaving === 'old-child-visible-through-second-round') {
      expect(events.slice(4, 11)).toEqual([
        `lock 2: ${JSON.stringify(replacement)}`, 'wait with old child visible',
        `lock 3: ${JSON.stringify(replacement)}`, `manager: ${endpoint.old.pid}`,
        'old child reaped', `lock 4: ${JSON.stringify(replacement)}`, 'manager: null',
      ]);
      expect(waits).toBe(2);
    }
    expect(stop).not.toHaveBeenCalled();
    expect(endpoint.state.status).toBe(0);
    expect(endpoint.state.stops).toBe(0);
    expect(endpoint.state.work).toEqual(['accepted-work']);
    expect(endpoint.child.signalCode).toBeNull();
    expect(endpoint.child.exitCode).toBeNull();
    expect([...processes]).toEqual([[replacement.pid, { generation: 1, manager: false, work: ['replacement-work'], signals: 0 }]]);
    expect(await readFile(join(f.root, 'daemon.pid'), 'utf8')).toBe(JSON.stringify(replacement));
    expect(f.state.owner).toEqual(replacement);
    expect(result.retained).toEqual({ pid: replacement.pid, startedAt: replacement.startedAt });
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const trace = JSON.stringify({ events, result, calls: f.calls });
    expect(result.kind, trace).toBe('install_incomplete');
    expect(result.detail, trace).not.toContain('owner_unproven');
    expect(result.detail, trace).not.toContain('stop_unconfirmed');
    expect(bootouts(f), trace).toEqual([`bootout gui/501/${LAUNCHD_LABEL}`]);
    expect(events.indexOf('bootout')).toBeGreaterThan(events.indexOf('manager: null'));
    expect(events.at(-1)).toBe(`lock ${reads}: ${JSON.stringify(replacement)}`);
  } finally { await cleanup(); await endpoint.close(); }
});

it.each(['replacement', 'rollback'] as const)('launchd %s accepted real stop loses done, drains normally and fresh uninstall converges', async mode => {
  const endpoint = await composedOwner();
  endpoint.state.loseReply = true;
  const f = await launchdFixture({ stopOwner: stopVerifiedOwner });
  try {
    await writeFile(join(f.root, 'local-credential'), endpoint.credential);
    if (mode === 'replacement') await f.seed(49102);
    else f.state.verifyFails = true;
    f.state.beforeUnlink = async () => {
      f.state.owner = endpoint.old; f.state.pid = endpoint.old.pid;
      await writeFile(join(f.root, 'daemon.pid'), JSON.stringify(endpoint.old));
    };
    const result = await f.service.install({ port: 49101 });
    expect(result.kind).toBe('install_incomplete'); expect(result.detail).toContain('stop_unconfirmed');
    expect(result.detail).toContain(`PID ${endpoint.old.pid}`);
    expect(endpoint.state.stops).toBe(1); expect(endpoint.state.draining).toBe(true);
    expect(endpoint.state.work).toEqual(['accepted-work']);
    expect(await readFile(join(f.root, 'daemon.pid'), 'utf8')).toBe(JSON.stringify(endpoint.old));
    expect(bootouts(f)).toEqual([]);
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const calls = [...f.calls];
    for (let round = 0; round < 600; round++) {
      f.state.clock += 1000;
      expect(endpoint.child.exitCode).toBeNull();
    }
    expect(f.calls).toEqual(calls); expect(endpoint.state.stops).toBe(1);
    await endpoint.finish();
    f.state.owner = null; f.state.pid = null;
    await unlink(join(f.root, 'daemon.pid'));
    f.state.beforeUnlink = null;
    expect((await f.service.uninstall()).kind).toBe('uninstalled');
    expect(bootouts(f)).toHaveLength(1);
    expect(endpoint.state.stops).toBe(1); expect(endpoint.state.work).toEqual([]);
    expect(endpoint.child.exitCode).toBe(0); expect(endpoint.child.signalCode).toBeNull();
    expect((await f.service.uninstall()).kind).toBe('not-installed');
  } finally { await f.cleanup(); await endpoint.close(); }
});

it('launchd composes job takeover, real proof and long drain before rollback unload', async () => {
  const endpoint = await composedOwner();
  const f = await launchdFixture({ stopOwner: stopVerifiedOwner });
  const processes = new Map([
    [endpoint.old.pid, { role: 'job', alive: false, work: [] as string[] }],
  ]);
  try {
    await writeFile(join(f.root, 'local-credential'), endpoint.credential);
    let bootstrapped = false;
    f.state.beforeCommand = async command => {
      if (command === 'bootstrap') bootstrapped = true;
      else if (command === 'print' && bootstrapped) { f.state.queryFailure = true; bootstrapped = false; }
    };
    f.state.afterUnlink = async () => {
      // The job the bootstrap started is replaced by the real endpoint, which then drains for minutes.
      processes.set(endpoint.old.pid, { role: 'job', alive: true, work: ['accepted-work'] });
      f.state.queryFailure = false;
      f.state.owner = endpoint.old; f.state.pid = endpoint.old.pid;
      await writeFile(join(f.root, 'daemon.pid'), JSON.stringify(endpoint.old));
    };
    let rounds = 0;
    f.state.onPause = async () => {
      if (!endpoint.state.draining) return;
      expect(endpoint.state.work).toEqual(['accepted-work']);
      expect(bootouts(f)).toEqual([]);
      if (++rounds === 600) {
        await endpoint.finish();
        processes.set(endpoint.old.pid, { role: 'job', alive: false, work: [] });
        f.state.owner = null; f.state.pid = null;
        await unlink(join(f.root, 'daemon.pid'));
      }
    };
    endpoint.state.onStop = async () => {
      expect(processes.get(endpoint.old.pid)).toEqual({ role: 'job', alive: true, work: ['accepted-work'] });
      expect(bootouts(f)).toEqual([]);
    };
    const result = await f.service.install();
    expect(result.kind).toBe('install_rolled_back');
    expect(result.retained).toBeNull();
    expect([...processes.values()]).toEqual([{ role: 'job', alive: false, work: [] }]);
    expect(rounds).toBe(600); expect(f.state.clock).toBeGreaterThanOrEqual(150_000);
    expect(endpoint.state.status).toBe(1); expect(endpoint.state.stops).toBe(1);
    expect(endpoint.child.exitCode).toBe(0); expect(endpoint.child.signalCode).toBeNull();
    expect(endpoint.state.work).toEqual([]); expect(bootouts(f)).toHaveLength(1);
    expect((await readRegistration({ target: f.target, requestedRoot: f.root })).kind).toBe('absent');
  } finally { await f.cleanup(); await endpoint.close(); }
});

it('launchd install rewrites an older-format plist under our label', async () => {
  await withLaunchd(async f => {
    await mkdir(posix.dirname(f.plistPath), { recursive: true }); await writeFile(f.plistPath, 'older plist format'); f.state.loaded = true;
    expect((await f.service.install()).kind).toBe('installed');
    expect(await readFile(f.plistPath)).toEqual(f.content());
    expect(bootouts(f)).toHaveLength(1);
  });
});
it('launchd uninstall refuses a symlinked plist under our label', async () => {
  await withLaunchd(async f => {
    await mkdir(posix.dirname(f.plistPath), { recursive: true });
    const external = posix.join(f.root, 'external.plist'); await writeFile(external, f.content()); await symlink(external, f.plistPath);
    f.state.loaded = true;
    expect((await f.service.uninstall()).kind).toBe('uninstall_refused');
    expect((await f.service.install()).kind).toBe('install_refused');
    expect(bootouts(f)).toEqual([]); expect(await readFile(external)).toEqual(f.content());
  });
});
it('launchd hands a detached daemon to the installed idle job', async () => {
  await withLaunchd(async f => {
    await f.seed(); f.state.owner = { ...first, pid: first.pid + 7, startedAt: 'detached' };
    expect((await f.service.install()).kind).toBe('installed');
    const kick = f.calls.indexOf(`kickstart gui/501/${LAUNCHD_LABEL}`);
    expect(f.calls.indexOf(`stop ${first.pid + 7}`)).toBeGreaterThan(-1);
    expect(f.calls.indexOf(`stop ${first.pid + 7}`)).toBeLessThan(kick);
    expect(f.state.owner?.pid).toBe(first.pid); expect(bootouts(f)).toEqual([]);
  });
});
it('launchd install refuses without stopping anything when the job record cannot be read', async () => {
  await withLaunchd(async f => {
    await f.seed(); f.state.owner = { ...first }; f.state.pid = first.pid; f.state.queryFailure = true;
    const result = await f.service.install();
    expect(result.kind).toBe('install_refused'); expect(result.detail).toContain('launchd query failed');
    expect(f.calls.filter(call => /^(stop|bootstrap|bootout|kickstart)/.test(call))).toEqual([]); expect(f.state.owner?.pid).toBe(first.pid);
  });
});
it('launchd install refuses an older-format plist whose job runs a process without our lock', async () => {
  await withLaunchd(async f => {
    await mkdir(posix.dirname(f.plistPath), { recursive: true }); await writeFile(f.plistPath, 'older plist format'); f.state.loaded = true; f.state.pid = 777;
    expect((await f.service.install()).kind).toBe('install_refused');
    const uninstall = await f.service.uninstall();
    expect(uninstall.kind).toBe('uninstall_rolled_back'); expect(uninstall.detail).toContain('foreign_job_pid');
    expect(await readFile(f.plistPath, 'utf8')).toBe('older plist format'); expect(bootouts(f)).toEqual([]);
  });
});
it('launchd install keeps a detached daemon running when the installed plist has no job (turned off in System Settings)', async () => {
  await withLaunchd(async f => {
    await f.seed(); f.state.loaded = false; f.state.owner = { ...first, startedAt: 'detached' };
    const result = await f.service.install();
    expect(result.kind).toBe('install_refused'); expect(result.detail).toContain('Login Items & Extensions');
    expect(f.calls.filter(call => /^(stop|bootstrap)/.test(call))).toEqual([]); expect(f.state.owner?.startedAt).toBe('detached');
  });
});

const translocated = '/private/var/folders/x1/T/AppTranslocation/1F2E3D4C/d/Vonvon Bot.app/Contents';
it.each([
  ['executable', { executable: `${translocated}/MacOS/Vonvon Bot` }],
  ['CLI entry', { distribution: async () => ({ kind: 'bundled' as const, cliPath: `${translocated}/Resources/daemon/bin/vonvon.mjs` }) }],
])('launchd refuses to install from an App Translocation %s and leaves the detached daemon running', async (_where, overrides) => {
  await withLaunchd(async f => {
    f.state.owner = { ...first, startedAt: 'detached' };
    const result = await f.service.install();
    expect(result.kind).toBe('install_refused'); expect(result.detail).toBe(TRANSLOCATED_REFUSAL);
    expect(classifyServiceFailure(result.detail)).toBe('translocated');
    expect(f.calls.filter(call => /^(stop|bootstrap|kickstart)/.test(call))).toEqual([]);
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.state.owner?.startedAt).toBe('detached');
  }, overrides);
});
it.each([
  ['with launchctl\'s own words', 'Could not find domain for user gui: 501\n', 'GUI domain unavailable: Could not find domain for user gui: 501'],
  ['without any', '', 'GUI domain unavailable'],
])('launchd names a missing GUI domain %s, so it classifies as manager-unavailable', async (_case, stderr, detail) => {
  await withLaunchd(async f => {
    const result = await f.service.install();
    expect(result.kind).toBe('install_refused'); expect(result.detail).toBe(detail);
    expect(classifyServiceFailure(result.detail)).toBe('manager-unavailable');
    await expect(readFile(f.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, { run: async args => { if (args.join(' ') !== 'print gui/501') throw new Error(`Unexpected command ${args.join(' ')}`); return { ok: false, stdout: '', stderr }; } });
});
it('launchd refusals the login-time switch can meet classify to their reasons', async () => {
  await withLaunchd(async f => {
    await f.seed(); f.state.loaded = false; f.state.owner = { ...first, startedAt: 'detached' };
    expect(classifyServiceFailure((await f.service.install()).detail)).toBe('turned-off');
  });
  await withLaunchd(async f => {
    f.state.loaded = true;
    expect(classifyServiceFailure((await f.service.install()).detail)).toBe('interrupted');
  });
  await withLaunchd(async f => {
    await f.seed(); f.state.owner = { ...first }; f.state.pid = first.pid;
    const result = await f.service.install();
    expect(result.kind).toBe('install_refused'); expect(classifyServiceFailure(result.detail)).toBe('replace-running');
  }, { executable: '/Users/u/Applications/Vonvon Bot.app/Contents/MacOS/Vonvon Bot' });
  await withLaunchd(async f => {
    expect(classifyServiceFailure((await f.service.install()).detail)).toBe('distribution');
  }, { distribution: async () => ({ kind: 'development', cliPath: '/src/packages/daemon/bin/vonvon.mjs' }) });
});
