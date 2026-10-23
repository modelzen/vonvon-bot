import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PROTOCOL_VERSION, type Request, type Response } from '@vonvon/protocol';
import type { AdminService } from '../admin/service';
import type { ShutdownControl } from '../host/lifecycle';
import { createServiceActionLauncher } from '../host/service-action';
import { paths } from '../config/paths';
import { bridgeVersion } from '../core/version';
import { createDirectoryBrowser } from './directory-browser';
import { memoryRpc } from './rpc/memory';
import { contextPreviewRpc } from './rpc/context-preview';
import { Jobs } from './jobs';
import { LogFollowers } from './logs';
import { createSnapshotStore, type SnapshotStore } from './snapshot';
import { createSocketServer, type Peer } from './ws';
import type { RpcOutcome } from './rpc';
import { adminRpc } from './rpc/admin';
import { commandRpc } from './rpc/command';
import { collaborationRpc } from './rpc/collaboration';
import { environmentRpc } from './rpc/environment';
import { libraryRpc } from './rpc/library';
import { machineRpc } from './rpc/machine';
import type {BridgeImporter} from '../import/bridge/transaction';
import { settingsRpc } from './rpc/settings';
import { readLocalIdentity } from './local-credential';
import { getRpcErrorCode } from './errors';
import { serveWebUi } from './web-ui';
import { getPidLockInfo, type PidLockInfo } from './pid-lock';
import { EnvironmentService, type EnvironmentServiceOptions } from '../environment/service';
import { resolveCodexBin } from '../agent/codex-appserver/locate';

export interface ApiLifetime {
  beginDrain(): Promise<void>;
  release(): Promise<void>;
}

export class ApiCleanupError extends AggregateError {
  constructor(errors: Iterable<unknown>) {
    super(errors, 'API listener closed with cleanup errors');
    this.name = 'ApiCleanupError';
  }
}

export interface DaemonApi extends ApiLifetime {
  port: number;
  listen: string;
  invalidate(): void;
  close(): Promise<void>;
}

/** Test seams for the login-time service: the platform and spawn of the helper launcher, and the manager read. */
type ServiceSeams = Pick<Parameters<typeof createServiceActionLauncher>[0], 'platform' | 'spawn'> & Pick<Parameters<typeof createSnapshotStore>[0], 'readService'>;

export async function startApi(options: { service: AdminService; port?: number; control?: ShutdownControl; environmentOptions?: EnvironmentServiceOptions; serviceActions?: ServiceSeams; bridgeImport?: BridgeImporter; diagnostics?: Parameters<typeof createSnapshotStore>[0]['diagnostics']; crashes?: Parameters<typeof createSnapshotStore>[0]['crashes'] }): Promise<DaemonApi> {
  let acquiredServer: ReturnType<typeof createServer> | undefined;
  let acquiredJobs: Jobs | undefined;
  let acquiredLogs: LogFollowers | undefined;
  let acquiredEnvironment: EnvironmentService | undefined;
  let acquiredSockets: ReturnType<typeof createSocketServer> | undefined;
  let snapshots: SnapshotStore | undefined;
  let port = options.port ?? 0;
  const invalidate = (): void => { void snapshots?.rebuild().catch(() => undefined); };
  const home = paths.appDir;
  let owner: Promise<PidLockInfo | null> | undefined;
  let draining: Promise<void> | undefined;
  let released: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const beginDrain = (): Promise<void> => {
    if (draining) return draining;
    const drains: Promise<void>[] = [];
    draining = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(drains);
      results.push(...await Promise.allSettled([Promise.resolve().then(() => snapshots?.close())]));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'API drain failed');
    });
    owner = getPidLockInfo(home);
    void owner.catch(() => undefined);
    for (const cleanup of [
      () => acquiredSockets?.beginDrain(),
      () => Promise.resolve().then(() => options.service.close?.()),
      () => acquiredJobs?.close(),
      () => acquiredEnvironment?.close(),
      () => acquiredLogs?.close(),
    ]) {
      const drain = new Promise<void>(resolve => resolve(cleanup()));
      void drain.catch(() => undefined);
      drains.push(drain);
    }
    return draining;
  };
  const release = (): Promise<void> => {
    if (released) return released;
    let socketCleanup: Promise<void>;
    let listenerClosed: Promise<void>;
    released = Promise.resolve().then(async () => {
      await listenerClosed;
      try { await socketCleanup; }
      catch (error) { throw new ApiCleanupError([error]); }
    });
    socketCleanup = new Promise<void>(resolve => resolve(acquiredSockets?.release()));
    listenerClosed = new Promise<void>((resolve, reject) => {
      if (!acquiredServer) { resolve(); return; }
      acquiredServer.close(error => { if (error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) reject(error); else resolve(); });
    });
    void socketCleanup.catch(() => undefined);
    void listenerClosed.catch(() => undefined);
    return released;
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let drain: Promise<void>;
    closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([drain]);
      results.push(...await Promise.allSettled([release()]));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'API shutdown failed');
    });
    drain = beginDrain();
    void drain.catch(() => undefined);
    return closing;
  };
  try {
    await mkdir(paths.appDir, { recursive: true });
    const environment = acquiredEnvironment = new EnvironmentService(options.environmentOptions ?? {
      home: homedir(), getDataRoot: () => paths.appDir,
      resolveCodex: () => resolveCodexBin({ force: true }), nodePath: process.execPath,
    });
    const { credential, machineId } = await readLocalIdentity(paths.appDir);
    const directory = await createDirectoryBrowser();
    const server = acquiredServer = createServer((request, response) => {
      void serveWebUi(request, response).then(served => {
        if (!served) { response.writeHead(404); response.end(); }
      }).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    const jobs = acquiredJobs = new Jobs({ service: options.service, changed: invalidate, toolsSettled: () => { void snapshots?.refreshTools().catch(() => undefined); } });
    const logs = acquiredLogs = new LogFollowers(join(paths.appDir, 'logs'));
    const { readService, ...launcher } = options.serviceActions ?? {};
    const serviceActions = createServiceActionLauncher({ root: home, ...launcher, onSettled: () => { void snapshots?.refreshService().catch(() => undefined); } });
    async function finish<T>(peer: Peer, outcome: RpcOutcome<T>, envelope: (value: T) => Response): Promise<void> {
      if (outcome.kind === 'read') { peer.send(envelope(outcome.value)); return; }
      let acted = false;
      try {
        if (!snapshots) throw new Error('Snapshot store is not ready');
        await snapshots.rebuild(snapshot => {
          peer.send(envelope(outcome.reply(snapshot)));
          if (outcome.kind === 'shutdown') { acted = true; outcome.afterReply(); }
        });
      } finally { if (outcome.kind === 'shutdown' && !acted) outcome.cancel?.(); }
    }
    async function dispatch(peer: Peer, request: Request): Promise<void> {
      if (!snapshots) throw new Error('Snapshot store is not ready');
      const { id } = request;
      switch (request.method) {
        case 'snapshot': peer.send({ type: 'response', id, method: 'snapshot', payload: snapshots.current() }); return;
        case 'admin': return finish(peer, await adminRpc(options.service, follow => logs.follow(peer, follow), request.payload), payload => ({ type: 'response', id, method: 'admin', payload }));
        case 'settings': return finish(peer, await settingsRpc(options.service, request.payload), payload => ({ type: 'response', id, method: 'settings', payload }));
        case 'collaboration': return finish(peer, await collaborationRpc(options.service, directory, request.payload), payload => ({ type: 'response', id, method: 'collaboration', payload }));
        case 'environment': return finish(peer, await environmentRpc(options.service, jobs, peer, request.payload, environment), payload => ({ type: 'response', id, method: 'environment', payload }));
        case 'machine': return finish(peer, await machineRpc(options.service, options.control, port, request.payload, { launcher: serviceActions, snapshots, root: home, bridgeImport: options.bridgeImport, environment }), payload => ({ type: 'response', id, method: 'machine', payload }));
        case 'command': return finish(peer, await commandRpc({ service: options.service, jobs, peer, directory, snapshots, control: options.control, port }, request.payload), payload => ({ type: 'response', id, method: 'command', payload }));
        case 'library': return finish(peer, await libraryRpc(options.service, request.payload), payload => ({ type: 'response', id, method: 'library', payload }));
        case 'memory': return finish(peer, await memoryRpc(request.payload), payload => ({ type: 'response', id, method: 'memory', payload }));
        case 'contextPreview': return finish(peer, await contextPreviewRpc(options.service, request.payload), payload => ({ type: 'response', id, method: 'contextPreview', payload }));
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
    async function control(peer: Peer, request: Request): Promise<void> {
      if (request.method === 'machine' && request.payload.type === 'stopHost') {
        if (!options.control) throw new Error('Host control is unavailable');
        options.control.requestStop();
        peer.send({ type: 'response', id: request.id, method: 'machine', payload: { type: 'done', message: 'daemon 正在停止。' } });
      } else if (request.method === 'admin' && request.payload.type === 'daemonStatus') {
        const lock = await owner;
        const own = lock?.pid === process.pid && lock.listen === `127.0.0.1:${port}`;
        peer.send({ type: 'response', id: request.id, method: 'admin', payload: { kind: 'daemonStatus', status: {
          installed: false, supported: false, selfHosted: true, running: own, version: bridgeVersion(), ...(own ? { pid: lock.pid } : {}),
        } } });
      }
    }
    const sockets = acquiredSockets = createSocketServer({ server, credential, info: { type: 'serverInfo', machineId, version: bridgeVersion(), protocolVersion: PROTOCOL_VERSION }, request, control, detached: peer => { jobs.detach(peer); logs.detach(peer); } });
    snapshots = await createSnapshotStore({ service: options.service, jobs: () => jobs.snapshot(), serviceAction: () => serviceActions.current(), ...(readService ? { readService } : {}), ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}), ...(options.crashes ? { crashes: options.crashes } : {}), publish: snapshot => sockets.publish({ type: 'event', event: 'snapshot', payload: snapshot }) });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('API did not bind a TCP port');
    port = address.port;
    return {
      port, listen: `127.0.0.1:${port}`, invalidate, close,
      beginDrain, release,
    };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'API startup and cleanup failed'); }
    throw error;
  }
}
