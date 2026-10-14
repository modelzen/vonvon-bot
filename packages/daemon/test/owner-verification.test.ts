import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { machineIdSchema, PROTOCOL_VERSION } from '@vonvon/protocol';
import { daemonStatus, runStop } from '../src/cli/commands/daemon';
import { readHostEndpoint } from '../src/host/discovery';
import { createSocketServer, type Peer } from '../src/server/ws';
import { type PidLockInfo } from '../src/server/pid-lock';

let sleeper: ChildProcess;
let pid: number;
beforeAll(async () => {
  sleeper = spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>(resolve => sleeper.stdout?.once('data', () => resolve()));
  if (!sleeper.pid) throw new Error('Missing sleeper PID');
  pid = sleeper.pid;
});
afterAll(async () => {
  if (sleeper.exitCode === null && sleeper.signalCode === null) {
    await new Promise<void>(resolve => { sleeper.once('exit', () => resolve()); sleeper.kill('SIGTERM'); });
  }
});

type Mode = 'ready' | 'wrong-pid' | 'missing-pid' | 'stopped' | 'wrong-credential' | 'no-credential' | 'bad-credential' | 'timeout' | 'closed' | 'rpc-error' | 'changed-lock' | 'wrong-version';
async function fixture(mode: Mode) {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-owner-'));
  const credential = 'ac'.repeat(32);
  const server = createServer();
  let requests = 0;
  let peers = 0;
  const sockets = createSocketServer({
    server, credential,
    info: { type: 'serverInfo', machineId: machineIdSchema.parse(randomUUID()), version: 'test', protocolVersion: mode === 'wrong-version' ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION },
    detached: () => { peers--; },
    request: async (peer: Peer, request) => {
      requests++;
      expect(request.method).toBe('admin');
      expect(request.payload).toEqual({ type: 'daemonStatus' });
      if (mode === 'timeout') return;
      if (mode === 'rpc-error') { peer.send({ type: 'error', id: request.id, code: 'busy', message: credential }); return; }
      if (mode === 'changed-lock') await writeFile(join(home, 'daemon.pid'), JSON.stringify({ ...lock, startedAt: new Date(Date.parse(lock.startedAt) + requests * 1000).toISOString() }));
      peer.event({ type: 'event', event: 'log', payload: { lines: 'concurrent event' } });
      peer.send({ type: 'response', id: request.id, method: 'admin', payload: { kind: 'daemonStatus', status: {
        installed: false, running: mode !== 'stopped', selfHosted: true, version: 'test', supported: true,
        ...(mode === 'missing-pid' ? {} : { pid: mode === 'wrong-pid' ? process.pid : pid }),
      } } });
    },
  });
  server.on('upgrade', () => { peers++; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const lock: PidLockInfo = { pid, startedAt: new Date().toISOString(), listen: `127.0.0.1:${address.port}` };
  await writeFile(join(home, 'daemon.pid'), JSON.stringify(lock));
  if (mode !== 'no-credential') await writeFile(join(home, 'local-credential'), mode === 'bad-credential' ? 'invalid' : mode === 'wrong-credential' ? 'bb'.repeat(32) : credential);
  if (mode === 'closed') { await sockets.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  return { home, lock, requests: () => requests, peers: () => peers, close: async () => {
    await sockets.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  } };
}

it('discovers an authenticated matching PID through read-only RPC with concurrent events', async () => {
  const f = await fixture('ready');
  try {
    const before = await readdir(f.home);
    expect(await daemonStatus(f.home)).toMatchObject({ running: true, pid, listen: f.lock.listen });
    expect(await readHostEndpoint(f.home, true)).toMatchObject({ pid, listen: f.lock.listen });
    expect(f.requests()).toBe(2);
    await expect.poll(f.peers).toBe(0);
    expect(await readdir(f.home)).toEqual(before);
    expect(JSON.parse(await readFile(join(f.home, 'daemon.pid'), 'utf8'))).toEqual(f.lock);
  } finally { await f.close(); }
});

it.each<Mode>(['wrong-pid', 'missing-pid', 'stopped', 'wrong-credential', 'no-credential', 'bad-credential', 'timeout', 'closed', 'rpc-error', 'changed-lock', 'wrong-version'])('refuses %s without signaling or removing the lock', async mode => {
  const f = await fixture(mode);
  try {
    const before = await readdir(f.home);
    await expect(daemonStatus(f.home)).rejects.toThrow('Cannot verify daemon owner');
    expect(await readHostEndpoint(f.home, true)).toMatchObject({ kind: 'blocked', reason: 'inspection-failed' });
    await expect(runStop(f.home)).rejects.toThrow('Cannot verify daemon owner');
    expect(sleeper.exitCode).toBeNull();
    expect(sleeper.signalCode).toBeNull();
    expect(await readdir(f.home)).toEqual(before);
    expect(JSON.parse(await readFile(join(f.home, 'daemon.pid'), 'utf8'))).toMatchObject({ pid });
    await expect.poll(f.peers).toBe(0);
  } finally { await f.close(); }
});

it('keeps startup ownership busy and refuses stop before readiness', async () => {
  const f = await fixture('ready');
  try {
    await writeFile(join(f.home, 'daemon.pid'), JSON.stringify({ ...f.lock, listen: null }));
    expect(await daemonStatus(f.home)).toEqual({ running: false });
    expect(await readHostEndpoint(f.home, true)).toMatchObject({ kind: 'blocked', reason: 'busy' });
    await expect(runStop(f.home)).rejects.toThrow('Cannot verify daemon owner');
    expect(f.requests()).toBe(0);
    expect(sleeper.signalCode).toBeNull();
    expect(JSON.parse(await readFile(join(f.home, 'daemon.pid'), 'utf8'))).toMatchObject({ pid, listen: null });
  } finally { await f.close(); }
});

it('reports a dead owner as absent without contacting its listener or removing its stale lock', async () => {
  const f = await fixture('ready');
  try {
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise<void>(resolve => exited.once('exit', () => resolve()));
    const lock = JSON.stringify({ ...f.lock, pid: exited.pid });
    await writeFile(join(f.home, 'daemon.pid'), lock);
    expect(await daemonStatus(f.home)).toEqual({ running: false });
    expect(await readHostEndpoint(f.home, true)).toBeUndefined();
    expect(await runStop(f.home)).toBe(false);
    expect(f.requests()).toBe(0);
    expect(await readFile(join(f.home, 'daemon.pid'), 'utf8')).toBe(lock);
  } finally { await f.close(); }
});
