import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { machineIdSchema } from '@vonvon/protocol';
import { createSocketServer } from '../src/server/ws';
import { stopVerifiedOwner } from '../src/server/owner-verification';
import type { PidLockInfo } from '../src/server/pid-lock';

const modes = ['ready', 'wrong-pid', 'changed-lock', 'wrong-credential', 'closed-before-done', 'wrong-reply', 'wrong-response-id'] as const;
type Mode = typeof modes[number];
afterEach(() => { vi.restoreAllMocks(); });
async function fixture(mode: Mode) {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-verified-stop-'));
  const server = createServer();
  const credential = 'ab'.repeat(32);
  const requests: { peer: string; type: string }[] = [];
  let upgrades = 0;
  let lock: PidLockInfo = { pid: process.pid, startedAt: new Date().toISOString(), listen: null };
  const sockets = createSocketServer({
    server, credential,
    info: () => ({ type: 'serverInfo', machineId: machineIdSchema.parse(randomUUID()), version: 'test', protocolVersion: 1 }),
    detached: () => {},
    request: async (peer, request) => {
      requests.push({ peer: peer.id, type: 'type' in request.payload ? request.payload.type : 'action' in request.payload ? request.payload.action : request.method });
      if (request.method === 'admin' && request.payload.type === 'daemonStatus') {
        if (mode === 'changed-lock') await writeFile(join(home, 'daemon.pid'), JSON.stringify({ ...lock, startedAt: new Date(Date.parse(lock.startedAt) + 1000).toISOString() }));
        peer.send({ type: 'response', id: request.id, method: 'admin', payload: { kind: 'daemonStatus', status: { startedAt: 1, installed: false, supported: false, running: true, selfHosted: true, version: 'test', pid: mode === 'wrong-pid' ? process.pid + 1 : process.pid } } });
      } else if (request.method === 'machine' && request.payload.type === 'stopHost') {
        if (mode === 'closed-before-done') { void sockets.close(); return; }
        if (mode === 'wrong-reply') { peer.send({ type: 'error', id: request.id, code: 'busy', message: 'refused' }); return; }
        peer.send({ type: 'response', id: mode === 'wrong-response-id' ? 'unrelated' : request.id, method: 'machine', payload: { type: 'done', message: 'stopping' } });
      }
    },
  });
  server.on('upgrade', () => { upgrades++; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  lock = { ...lock, listen: `127.0.0.1:${address.port}` };
  await writeFile(join(home, 'daemon.pid'), JSON.stringify(lock));
  await writeFile(join(home, 'local-credential'), mode === 'wrong-credential' ? 'cd'.repeat(32) : credential);
  return { home, lock, requests, upgrades: () => upgrades, close: async () => {
    await sockets.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  } };
}

it('authenticates, verifies fresh identity, and receives stop done over exactly one socket without signaling', async () => {
  const f = await fixture('ready');
  const originalKill = process.kill.bind(process);
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => signal === 0 ? originalKill(pid, 0) : true);
  try {
    const result = await stopVerifiedOwner(f.home, f.lock).then(() => ({ ok: true }), error => ({ ok: false, error }));
    expect.soft(f.upgrades()).toBe(1);
    expect.soft(f.requests.map(request => request.type)).toEqual(['daemonStatus', 'stopHost']);
    expect.soft(new Set(f.requests.map(request => request.peer)).size).toBe(1);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(JSON.parse(await readFile(join(f.home, 'daemon.pid'), 'utf8'))).toEqual(f.lock);
    expect(result).toEqual({ ok: true });
  } finally { kill.mockRestore(); await f.close(); }
});

it.each(modes.filter(mode => mode !== 'ready'))('refuses %s without process signals or lock deletion', async mode => {
  const f = await fixture(mode);
  const originalKill = process.kill.bind(process);
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => signal === 0 ? originalKill(pid, 0) : true);
  try {
    await expect(stopVerifiedOwner(f.home, f.lock)).rejects.toThrow('Cannot verify daemon owner');
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(await readFile(join(f.home, 'daemon.pid'), 'utf8')).toContain(String(f.lock.pid));
    if (mode === 'wrong-pid' || mode === 'changed-lock' || mode === 'wrong-credential') {
      expect(f.requests.some(request => request.type === 'stopHost')).toBe(false);
    } else {
      expect.soft(f.requests.map(request => request.type)).toEqual(['daemonStatus', 'stopHost']);
      expect.soft(new Set(f.requests.map(request => request.peer)).size).toBe(1);
    }
  } finally { kill.mockRestore(); await f.close(); }
});
