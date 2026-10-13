import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { machineIdSchema, PROTOCOL_VERSION } from '@vonvon/protocol';
import { createSocketServer, type Peer } from '../src/server/ws';
import { stopVerifiedOwner } from '../src/server/owner-verification';
import type { PidLockInfo } from '../src/server/pid-lock';
import { createServiceDrain, type DrainScope } from '../src/service/drain';

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
}, 10_000);

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
}, 10_000);
