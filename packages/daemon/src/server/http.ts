import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type Request, type Response } from '@vonvon/protocol';
import type { AdminService } from '../admin/service';
import type { ShutdownControl } from '../host/lifecycle';
import { paths } from '../config/paths';
import { bridgeVersion } from '../core/version';
import { createDirectoryBrowser } from './directory-browser';
import { Jobs } from './jobs';
import { LogFollowers } from './logs';
import { createSnapshotStore, type SnapshotStore } from './snapshot';
import { createSocketServer, type Peer } from './ws';
import type { RpcOutcome } from './rpc';
import { adminRpc } from './rpc/admin';
import { commandRpc } from './rpc/command';
import { collaborationRpc } from './rpc/collaboration';
import { environmentRpc } from './rpc/environment';
import { machineRpc } from './rpc/machine';
import { settingsRpc } from './rpc/settings';
import { readLocalIdentity } from './local-credential';
import { getRpcErrorCode } from './errors';

export interface ApiLifetime {
  beginDrain(): Promise<void>;
  release(): Promise<void>;
}

export interface DaemonApi extends ApiLifetime {
  port: number;
  listen: string;
  invalidate(): void;
  close(): Promise<void>;
}

export async function startApi(options: { service: AdminService; port?: number; control?: ShutdownControl }): Promise<DaemonApi> {
  let acquiredServer: ReturnType<typeof createServer> | undefined;
  let acquiredJobs: Jobs | undefined;
  let acquiredLogs: LogFollowers | undefined;
  let acquiredSockets: ReturnType<typeof createSocketServer> | undefined;
  let snapshots: SnapshotStore | undefined;
  let port = options.port ?? 0;
  const invalidate = (): void => { void snapshots?.rebuild().catch(() => undefined); };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    const drains: Promise<void>[] = [];
    closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(drains);
      results.push(...await Promise.allSettled([Promise.resolve().then(() => snapshots?.close())]));
      results.push(...await Promise.allSettled([new Promise<void>((resolve, reject) => {
        if (!acquiredServer) { resolve(); return; }
        acquiredServer.close(error => { if (error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) reject(error); else resolve(); });
      })]));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'API shutdown failed');
    });
    for (const cleanup of [
      () => acquiredSockets?.close(),
      () => Promise.resolve().then(() => options.service.close?.()),
      () => acquiredJobs?.close(),
      () => acquiredLogs?.close(),
    ]) {
      const drain = new Promise<void>(resolve => resolve(cleanup()));
      void drain.catch(() => undefined);
      drains.push(drain);
    }
    return closing;
  };
  try {
    await mkdir(paths.appDir, { recursive: true });
    const { credential, machineId } = await readLocalIdentity(paths.appDir);
    const directory = await createDirectoryBrowser();
    const server = acquiredServer = createServer((_request, response) => { response.writeHead(404); response.end(); });
    const jobs = acquiredJobs = new Jobs({ service: options.service, changed: invalidate, toolsSettled: () => { void snapshots?.refreshTools().catch(() => undefined); } });
    const logs = acquiredLogs = new LogFollowers(join(paths.appDir, 'logs'));
    async function finish<T>(peer: Peer, outcome: RpcOutcome<T>, envelope: (value: T) => Response): Promise<void> {
      if (outcome.kind === 'read') { peer.send(envelope(outcome.value)); return; }
      if (!snapshots) throw new Error('Snapshot store is not ready');
      await snapshots.rebuild(snapshot => {
        peer.send(envelope(outcome.reply(snapshot)));
        if (outcome.kind === 'shutdown') outcome.afterReply();
      });
    }
    async function dispatch(peer: Peer, request: Request): Promise<void> {
      if (!snapshots) throw new Error('Snapshot store is not ready');
      const { id } = request;
      switch (request.method) {
        case 'snapshot': peer.send({ type: 'response', id, method: 'snapshot', payload: snapshots.current() }); return;
        case 'admin': return finish(peer, await adminRpc(options.service, follow => logs.follow(peer, follow), request.payload), payload => ({ type: 'response', id, method: 'admin', payload }));
        case 'settings': return finish(peer, await settingsRpc(options.service, request.payload), payload => ({ type: 'response', id, method: 'settings', payload }));
        case 'collaboration': return finish(peer, await collaborationRpc(options.service, directory, request.payload), payload => ({ type: 'response', id, method: 'collaboration', payload }));
        case 'environment': return finish(peer, await environmentRpc(options.service, jobs, peer, request.payload), payload => ({ type: 'response', id, method: 'environment', payload }));
        case 'machine': return finish(peer, await machineRpc(options.service, options.control, port, request.payload), payload => ({ type: 'response', id, method: 'machine', payload }));
        case 'command': return finish(peer, await commandRpc({ service: options.service, jobs, peer, directory, snapshots, control: options.control, port }, request.payload), payload => ({ type: 'response', id, method: 'command', payload }));
        case 'directory': {
          if (request.payload.type === 'list') { peer.send({ type: 'response', id, method: 'directory', payload: await directory.list(request.payload.path) }); return; }
          const folder = await directory.choose(request.payload.path);
          return finish(peer, { kind: 'mutation', reply: () => ({ kind: 'folderChosen' as const, folder }) }, payload => ({ type: 'response', id, method: 'directory', payload }));
        }
        default: { const exhaustive: never = request; throw new Error(String(exhaustive)); }
      }
    }
    async function request(peer: Peer, request: Request): Promise<void> {
      try { await dispatch(peer, request); }
      catch (error) {
        if (!snapshots) throw error;
        await snapshots.rebuild(() => peer.send({ type: 'error', id: request.id, code: getRpcErrorCode(error), message: error instanceof Error ? error.message : '操作失败。' }));
      }
    }
    const sockets = acquiredSockets = createSocketServer({ server, credential, info: { type: 'serverInfo', machineId, version: bridgeVersion(), protocolVersion: PROTOCOL_VERSION }, request, detached: peer => { jobs.detach(peer); logs.detach(peer); } });
    snapshots = await createSnapshotStore({ service: options.service, jobs: () => jobs.snapshot(), publish: snapshot => sockets.publish({ type: 'event', event: 'snapshot', payload: snapshot }) });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('API did not bind a TCP port');
    port = address.port;
    return {
      port, listen: `127.0.0.1:${port}`, invalidate, close,
      async beginDrain() { throw new Error('Drain control is not implemented.'); },
      async release() { throw new Error('Release control is not implemented.'); },
    };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'API startup and cleanup failed'); }
    throw error;
  }
}
