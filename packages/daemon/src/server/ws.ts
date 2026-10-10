import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { helloSchema, requestSchema, type ErrorEnvelope, type Event, type Request, type Response, type ServerInfo } from '@vonvon/protocol';
import { getRpcErrorCode } from './errors';
import type { JobPeer } from './jobs';

export interface Peer extends JobPeer {
  send(value: Response | ErrorEnvelope): void;
}
function loopbackHost(host: string | undefined): boolean {
  return !!host && /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host);
}
function loopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try { const url = new URL(origin); return (url.protocol === 'http:' || url.protocol === 'https:') && loopbackHost(url.host); }
  catch { return false; }
}
export function createSocketServer(options: { server: Server; credential: string; info: ServerInfo; request: (peer: Peer, request: Request) => Promise<void>; detached: (peer: Peer) => void }) {
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4_000_000 });
  const peers = new Set<Peer>();
  options.server.on('upgrade', (request, socket, head) => {
    if (!loopbackHost(request.headers.host) || !loopbackOrigin(request.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', socket => {
    let authenticated = false;
    let detached = false;
    const send = (value: Response | ErrorEnvelope | Event | ServerInfo): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 8_000_000) { socket.close(1013, 'slow_consumer'); detach(); return; }
      socket.send(JSON.stringify(value), error => { if (error) { socket.terminate(); detach(); } });
    };
    const peer: Peer = { id: randomUUID(), get open() { return authenticated && !detached && socket.readyState === WebSocket.OPEN; }, send, event: send };
    const detach = (): void => {
      if (detached) return;
      detached = true;
      clearTimeout(deadline);
      peers.delete(peer);
      options.detached(peer);
    };
    const deadline = setTimeout(() => socket.close(4401, 'unauthorized'), 5000);
    deadline.unref();
    socket.on('close', detach);
    socket.on('error', detach);
    socket.on('message', (bytes, binary) => {
      let raw: unknown;
      try { if (binary) throw new Error('binary'); raw = JSON.parse(bytes.toString()); }
      catch { socket.close(authenticated ? 1007 : 4401, authenticated ? 'invalid_message' : 'unauthorized'); return; }
      if (!authenticated) {
        const hello = helloSchema.safeParse(raw);
        const credential = hello.success ? hello.data.credential : undefined;
        const supplied = Buffer.from(credential ?? '');
        const expected = Buffer.from(options.credential);
        if (!hello.success || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { socket.close(4401, 'unauthorized'); return; }
        authenticated = true;
        clearTimeout(deadline);
        peers.add(peer);
        send(options.info);
        return;
      }
      if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string' || !raw.id) { socket.close(1007, 'invalid_message'); return; }
      const id = raw.id;
      if ('type' in raw && raw.type === 'request' && 'method' in raw && typeof raw.method === 'string' && !requestSchema.optionsMap.has(raw.method)) {
        peer.send({ type: 'error', id, code: 'unknown_method', message: '未知 RPC 方法。' });
        return;
      }
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) { peer.send({ type: 'error', id, code: 'invalid_request', message: '请求参数无效。' }); return; }
      void options.request(peer, parsed.data).catch(error => {
        peer.send({ type: 'error', id, code: getRpcErrorCode(error), message: error instanceof Error ? error.message : '操作失败。' });
      });
    });
  });
  return {
    publish(event: Event): void { for (const peer of peers) peer.event(event); },
    async close(): Promise<void> {
      for (const socket of sockets.clients) socket.close(1001, 'server_shutdown');
      await new Promise<void>(resolve => {
        const deadline = setTimeout(() => { for (const socket of sockets.clients) socket.terminate(); }, 250);
        sockets.close(() => { clearTimeout(deadline); resolve(); });
      });
    },
  };
}
