import { existsSync, readFileSync, rmSync } from 'node:fs';
import { Server as HttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import type { Mutex } from '../src/config/data-access';
import type { DaemonApi } from '../src/server/http';

const owned = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-release-errors-')));
  vi.stubEnv('VONVON_HOME', appDir);
  return {
    appDir, mutexes: new Set<Mutex>(), apis: new Set<DaemonApi>(),
    listening: vi.fn<(listen: string) => void>(), release: vi.fn(),
  };
});
vi.mock('../src/agent/owned-process', () => ({ closeOwnedProviderProcesses: async () => {}, unconfirmedProviderPids: () => [] }));
vi.mock('../src/service/startup', () => ({ readStartupRegistration: async () => ({ kind: 'absent' }), startRegisteredDaemon: async () => { throw new Error('unexpected service start'); } }));
vi.mock('../src/config/data-access', async original => {
  const actual = await original<typeof import('../src/config/data-access')>();
  return { ...actual, acquireMutex: async (...args: Parameters<typeof actual.acquireMutex>) => {
    const mutex = await actual.acquireMutex(...args);
    owned.mutexes.add(mutex);
    return mutex;
  } };
});
vi.mock('../src/admin/service', () => ({ createAdminService: () => ({ listBots: async () => [], listProjects: async () => [] }) }));
vi.mock('../src/agent', () => ({
  installBackendDep: vi.fn(), uninstallBackendDep: vi.fn(),
  createBackend: () => ({ doctor: async () => ({ ok: false, version: null, depState: 'not-installed' }) }),
}));
vi.mock('../src/server/http', async original => {
  const actual = await original<typeof import('../src/server/http')>();
  return { ...actual, startApi: async (...args: Parameters<typeof actual.startApi>) => {
    const api = await actual.startApi(...args);
    owned.apis.add(api);
    return { ...api, release: () => { owned.release(); return api.release(); } };
  } };
});
vi.mock('../src/cli/commands/run', async () => {
  const { runSupervisor } = await import('../src/bot/supervisor');
  return { runRun: (_bot: unknown, options: NonNullable<Parameters<typeof runSupervisor>[1]>) => runSupervisor([], {
    ...options,
    onListening: async listen => { await options.onListening?.(listen); owned.listening(listen); },
  }) };
});

import { acquireMutex, closeMutex } from '../src/config/data-access';
import { paths } from '../src/config/paths';
import { log } from '../src/core/logger';
import { runHostRuntime } from '../src/host/bootstrap';
import { observeShutdown, type ShutdownControl } from '../src/host/lifecycle';
import { Jobs } from '../src/server/jobs';
import { getPidLockInfo, releasePidLock } from '../src/server/pid-lock';

function gate<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function reasons(error: unknown): string[] {
  if (error instanceof AggregateError) return [error.message, ...error.errors.flatMap(reasons)];
  return [error instanceof Error ? error.message : String(error)];
}

let control: ShutdownControl | undefined;
let running: Promise<unknown> | undefined;
let peer: WebSocket | undefined;
let forwardHttpClose: () => void = () => {};
const httpServers = new Set<HttpServer>();
const boundPorts = new Set<Server>();

afterAll(() => {
  rmSync(owned.appDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

afterEach(async () => {
  control?.requestStop();
  peer?.terminate();
  forwardHttpClose();
  await running;
  await Promise.allSettled([...owned.apis].map(api => api.close()));
  control?.dispose();
  vi.restoreAllMocks();
  await Promise.allSettled([...httpServers].filter(server => server.listening).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  await Promise.allSettled([...owned.mutexes].map(closeMutex));
  owned.mutexes.clear();
  await Promise.allSettled([...boundPorts].filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
  const owner = await getPidLockInfo(paths.appDir);
  if (owner?.pid === process.pid) await releasePidLock(paths.appDir, owner);
  vi.unstubAllGlobals();
});

it('releases PID and mutex after confirmed API closure even when peer cleanup fails', async () => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'send', { value: undefined }));
  const ready = gate<string>();
  const actualHttpClose = gate<void>();
  const permitHttpCallback = gate<void>();
  forwardHttpClose = () => permitHttpCallback.resolve();
  owned.listening.mockImplementation(ready.resolve);
  const cleanupError = new Error('fixture detached peer cleanup failed');
  vi.spyOn(Jobs.prototype, 'detach').mockImplementationOnce(() => { throw cleanupError; });
  const failures = vi.spyOn(log, 'fail');
  const realClose = HttpServer.prototype.close;
  vi.spyOn(HttpServer.prototype, 'close').mockImplementation(function (this: HttpServer, callback) {
    httpServers.add(this);
    return realClose.call(this, error => {
      actualHttpClose.resolve();
      void permitHttpCallback.promise.then(() => callback?.(error));
    });
  });
  control = observeShutdown();
  let settled = false;
  running = runHostRuntime({ managed: false, port: 0, control }).then(
    () => { settled = true; return undefined; },
    error => { settled = true; return error; },
  );
  const listen = await Promise.race([ready.promise, running.then(error => { throw error ?? new Error('Host stopped before ready'); })]);
  const owner = await getPidLockInfo(paths.appDir);
  expect(owner).toMatchObject({ pid: process.pid, listen });
  console.log('release-error test owns', paths.appDir, listen);
  const credential = readFileSync(join(paths.appDir, 'local-credential'), 'utf8').trim();
  peer = new WebSocket(`ws://${listen}`);
  const authenticated = gate<void>();
  const disconnected = gate<void>();
  peer.on('message', bytes => {
    const frame: unknown = JSON.parse(bytes.toString());
    if (typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'serverInfo') authenticated.resolve();
  });
  peer.once('close', () => disconnected.resolve());
  await new Promise<void>((resolve, reject) => { peer?.once('open', resolve); peer?.once('error', reject); });
  peer.send(JSON.stringify({ type: 'hello', clientKind: 'cli', protocolVersion: 1, credential }));
  await authenticated.promise;
  control.requestStop();
  await Promise.all([actualHttpClose.promise, disconnected.promise]);
  expect(peer.readyState).toBe(WebSocket.CLOSED);
  expect(settled).toBe(false);
  expect(await getPidLockInfo(paths.appDir)).toEqual(owner);
  await expect(acquireMutex(paths.appDir, 'host', 0)).rejects.toThrow('busy');
  forwardHttpClose();
  const result = await running;
  expect(result).toBeInstanceOf(Error);
  expect(reasons(result)).toContain(cleanupError.message);
  expect(owned.release).toHaveBeenCalledOnce();
  expect(failures.mock.calls.some(([scope, error]) => scope === 'daemon-shutdown' && reasons(error).includes(cleanupError.message))).toBe(true);
  expect.soft(existsSync(join(paths.appDir, 'daemon.pid')), 'confirmed closure must remove the old daemon.pid').toBe(false);
  const contender = await acquireMutex(paths.appDir, 'host', 0).then(
    async server => { await closeMutex(server); return 'acquired'; },
    error => error,
  );
  expect.soft(contender, 'confirmed closure must return the host mutex to the next owner').toBe('acquired');
  const port = Number(listen.split(':')[1]);
  const replacement = createServer();
  boundPorts.add(replacement);
  await new Promise<void>((resolve, reject) => {
    replacement.once('error', reject);
    replacement.listen(port, '127.0.0.1', resolve);
  });
  expect(replacement.address()).toMatchObject({ port });
});

it('releases PID and mutex after a release-phase WSS failure and held actual HTTP callback', async () => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'send', { value: undefined }));
  const ready = gate<string>();
  const actualHttpClose = gate<void>();
  const permitHttpCallback = gate<void>();
  forwardHttpClose = () => permitHttpCallback.resolve();
  owned.listening.mockImplementation(ready.resolve);
  const cleanupError = new Error('fixture detached peer cleanup failed');
  const realWssClose = WebSocketServer.prototype.close;
  vi.spyOn(WebSocketServer.prototype, 'close').mockImplementationOnce(function (this: WebSocketServer, callback) {
    return realWssClose.call(this, error => callback?.(error ?? cleanupError));
  });
  const releaseCount = owned.release.mock.calls.length;
  const failures = vi.spyOn(log, 'fail');
  const realClose = HttpServer.prototype.close;
  vi.spyOn(HttpServer.prototype, 'close').mockImplementation(function (this: HttpServer, callback) {
    httpServers.add(this);
    return realClose.call(this, error => {
      actualHttpClose.resolve();
      void permitHttpCallback.promise.then(() => callback?.(error));
    });
  });
  control = observeShutdown();
  let settled = false;
  running = runHostRuntime({ managed: false, port: 0, control }).then(
    () => { settled = true; return undefined; },
    error => { settled = true; return error; },
  );
  const listen = await Promise.race([ready.promise, running.then(error => { throw error ?? new Error('Host stopped before ready'); })]);
  const owner = await getPidLockInfo(paths.appDir);
  expect(owner).toMatchObject({ pid: process.pid, listen });
  console.log('release-error test owns', paths.appDir, listen);
  const credential = readFileSync(join(paths.appDir, 'local-credential'), 'utf8').trim();
  peer = new WebSocket(`ws://${listen}`);
  const authenticated = gate<void>();
  const disconnected = gate<void>();
  peer.on('message', bytes => {
    const frame: unknown = JSON.parse(bytes.toString());
    if (typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'serverInfo') authenticated.resolve();
  });
  peer.once('close', () => disconnected.resolve());
  await new Promise<void>((resolve, reject) => { peer?.once('open', resolve); peer?.once('error', reject); });
  peer.send(JSON.stringify({ type: 'hello', clientKind: 'cli', protocolVersion: 1, credential }));
  await authenticated.promise;
  control.requestStop();
  await Promise.all([actualHttpClose.promise, disconnected.promise]);
  expect(peer.readyState).toBe(WebSocket.CLOSED);
  expect(settled).toBe(false);
  expect(await getPidLockInfo(paths.appDir)).toEqual(owner);
  await expect(acquireMutex(paths.appDir, 'host', 0)).rejects.toThrow('busy');
  forwardHttpClose();
  const result = await running;
  expect(result).toBeInstanceOf(Error);
  expect(reasons(result)).toContain(cleanupError.message);
  expect(owned.release.mock.calls.length - releaseCount).toBe(1);
  expect(failures.mock.calls.some(([scope, error]) => scope === 'daemon-shutdown' && reasons(error).includes(cleanupError.message))).toBe(true);
  expect.soft(existsSync(join(paths.appDir, 'daemon.pid')), 'confirmed closure must remove the old daemon.pid').toBe(false);
  const contender = await acquireMutex(paths.appDir, 'host', 0).then(
    async server => { await closeMutex(server); return 'acquired'; },
    error => error,
  );
  expect.soft(contender, 'confirmed closure must return the host mutex to the next owner').toBe('acquired');
  const port = Number(listen.split(':')[1]);
  const replacement = createServer();
  boundPorts.add(replacement);
  await new Promise<void>((resolve, reject) => {
    replacement.once('error', reject);
    replacement.listen(port, '127.0.0.1', resolve);
  });
  expect(replacement.address()).toMatchObject({ port });
});
