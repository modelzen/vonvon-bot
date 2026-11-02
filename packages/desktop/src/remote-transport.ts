import type { ClientRequest, IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { ConnectionError, type VonvonClient } from '@vonvon/client/browser';
import {
  connectSecure, nodeBinarySocket, SecureChannelError, type PairResult, type SecureConnection, type ServerInfo, type StaticKey,
} from '@vonvon/client/secure';
import type { DeviceRoute } from '@vonvon/protocol';

/** devices-ui-1a 4.3: every way a remote connection fails, the codes the device page words its hints by. */
export type RemoteConnectCode = 'refused' | 'unreachable' | 'timeout' | 'forbidden' | 'rate_limited' | 'device_identity_changed'
  | 'handshake_failed' | 'unknown_client' | 'client_revoked' | 'pairing_failed' | 'remote_disabled' | 'protocol_mismatch' | 'closed' | 'aborted';
export type RemoteConnectStage = 'socket' | 'handshake' | 'pairing' | 'hello';
export class RemoteConnectError extends Error {
  constructor(readonly code: RemoteConnectCode, readonly stage: RemoteConnectStage, readonly detail?: { httpStatus?: number; sysCode?: string }) {
    super(`remote connection ${code} (${stage})`);
    this.name = 'RemoteConnectError';
  }
}
export interface RemoteLink {
  client: VonvonClient;
  serverInfo: ServerInfo;
  pairResult?: PairResult;
  /** Resolves once, when the connection that was open ends; `closed` when this side closed it. */
  closed: Promise<{ code: RemoteConnectCode; closeCode?: number }>;
  close(): void;
}
export interface RemoteConnectOptions {
  route: DeviceRoute;
  device: { id: string; pk: string };
  clientKey: StaticKey;
  pairing?: { inviteId: string; inviteSecret: string; clientName: string };
  signal: AbortSignal;
  /** The WebSocket is open and the channel starts: adding a device shows "正在配对" from here. */
  onSocketOpen?: () => void;
}
export interface RemoteConnector { connect(options: RemoteConnectOptions): Promise<RemoteLink> }

/** `ws://host:port/`, an IPv6 host in brackets: the Host header `ws` derives from it is what D3 checks. */
export function routeUrl(route: Pick<DeviceRoute, 'host' | 'port'>): string {
  return `ws://${route.host.includes(':') ? `[${route.host}]` : route.host}:${route.port}/`;
}

const UNREACHABLE = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ENOTFOUND', 'EHOSTDOWN', 'ENETDOWN']);
function socketFailure(error: Error): RemoteConnectError {
  const sysCode = (error as NodeJS.ErrnoException).code;
  const detail = typeof sysCode === 'string' ? { sysCode } : undefined;
  if (sysCode === 'ECONNREFUSED') return new RemoteConnectError('refused', 'socket', detail);
  if (sysCode && UNREACHABLE.has(sysCode)) return new RemoteConnectError('unreachable', 'socket', detail);
  if (sysCode === 'ETIMEDOUT' || /handshake has timed out/i.test(error.message)) return new RemoteConnectError('timeout', 'socket', detail);
  return new RemoteConnectError('closed', 'socket', detail);
}
/** One to one; a key or link that is not a key at all is a failed handshake. */
function channelFailure(error: unknown): RemoteConnectError {
  if (!(error instanceof SecureChannelError)) return new RemoteConnectError('handshake_failed', 'handshake');
  return new RemoteConnectError(error.code, error.stage === 'open' ? 'hello' : error.stage);
}

/** How long the client waits after its ConnectionError for the channel's own close, which says why (4.3 step 6). */
const CLOSED_FALLBACK_MS = 250;

/** devices-ui-1a 4.3: `ws` in the main process (it reports ECONNREFUSED and the like, which the page words hints by), then D2's
 * channel. No Origin header: the remote listener refuses one. */
export function secureConnector(deps: { WebSocket?: typeof WebSocket; routeTimeoutMs?: number } = {}): RemoteConnector {
  const Socket = deps.WebSocket ?? WebSocket;
  const routeTimeoutMs = deps.routeTimeoutMs ?? 10_000;
  return {
    connect(options) {
      const { route, signal } = options;
      return new Promise<RemoteLink>((resolve, reject) => {
        if (signal.aborted) { reject(new RemoteConnectError('aborted', 'socket')); return; }
        let settled = false;
        let stage: RemoteConnectStage = 'socket';
        const ws = new Socket(routeUrl(route), { perMessageDeflate: false, handshakeTimeout: Math.min(5_000, routeTimeoutMs), maxPayload: 4_000_000 });
        // A failed or aborted socket still emits an error: heard here, so it is never an unhandled one.
        ws.on('error', () => undefined);
        const finish = (): void => {
          settled = true;
          clearTimeout(deadline);
          signal.removeEventListener('abort', onAbort);
        };
        const fail = (error: RemoteConnectError): void => {
          if (settled) return;
          finish();
          ws.terminate();
          reject(error);
        };
        const onAbort = (): void => fail(new RemoteConnectError('aborted', stage));
        const deadline = setTimeout(() => fail(new RemoteConnectError('timeout', stage)), routeTimeoutMs);
        deadline.unref?.();
        signal.addEventListener('abort', onAbort, { once: true });
        ws.once('unexpected-response', (request: ClientRequest, response: IncomingMessage) => {
          const httpStatus = response.statusCode;
          response.resume();
          request.destroy();
          const code: RemoteConnectCode = httpStatus === 403 ? 'forbidden' : httpStatus === 429 ? 'rate_limited' : 'closed';
          fail(new RemoteConnectError(code, 'socket', httpStatus === undefined ? undefined : { httpStatus }));
        });
        ws.once('error', error => { if (stage === 'socket') fail(socketFailure(error)); });
        ws.once('close', () => { if (stage === 'socket') fail(new RemoteConnectError('closed', 'socket')); });
        ws.once('open', () => {
          if (settled) return;
          stage = 'handshake';
          try { options.onSocketOpen?.(); } catch { /* progress only */ }
          void connectSecure({
            socket: nodeBinarySocket(ws), device: options.device, clientKey: options.clientKey, clientKind: 'desktop',
            ...(options.pairing ? { pairing: options.pairing } : {}),
          }).then(connection => {
            if (settled) { connection.close(); return; }
            finish();
            resolve(link(connection));
          }, error => fail(channelFailure(error)));
        });
      });
    },
  };
}

function link(connection: SecureConnection): RemoteLink {
  let settle!: (value: { code: RemoteConnectCode; closeCode?: number }) => void;
  let done = false;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<{ code: RemoteConnectCode; closeCode?: number }>(resolve => { settle = resolve; });
  const end = (value: { code: RemoteConnectCode; closeCode?: number }): void => {
    if (done) return;
    done = true;
    clearTimeout(fallback);
    off();
    settle(value);
  };
  // The channel's close says why (4003 revoked, 4006 turned off); the client's ConnectionError comes a microtask earlier
  // without a code, so it only ends the link when the channel has said nothing within 250 ms.
  void connection.closed.then(error => end({ code: error.code, ...(error.closeCode === undefined ? {} : { closeCode: error.closeCode }) }));
  const off = connection.client.onError(error => {
    if (!(error instanceof ConnectionError) || done || fallback) return;
    fallback = setTimeout(() => end({ code: 'closed' }), CLOSED_FALLBACK_MS);
    fallback.unref?.();
  });
  return {
    client: connection.client, serverInfo: connection.serverInfo,
    ...(connection.pairResult ? { pairResult: connection.pairResult } : {}),
    closed,
    close() {
      end({ code: 'closed' });
      connection.close();
    },
  };
}
