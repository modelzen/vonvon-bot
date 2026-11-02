import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { helloSchema, pairRequestSchema, PROTOCOL_VERSION } from '@vonvon/protocol';
import { closeBody, createResponder, decodeFrame, encodeFrame, FRAME, generateStaticKey, type Channel } from '@vonvon/protocol/secure-channel';
import type { SecretBox } from '../../src/device-registry.js';

/** devices-ui-1a 第 5 节: a device on 127.0.0.1:0 that speaks D2's channel with only D2's public pieces. It pairs with an
 * invite, answers serverInfo v2, admin.daemonStatus, device.clients and device.revokeClient, and closes on demand with
 * the code said inside the channel, as a real device does. */
export interface FakeDeviceOptions {
  /** Refuse the WebSocket upgrade with this HTTP status. */
  refuse?: 403 | 429;
  /** Accept the socket and never answer message 1. */
  hold?: boolean;
  machineId?: string;
  version?: string;
  protocolVersion?: number;
}
type Client = { id: string; publicKey: string; name: string; revokedAt?: number };
export async function startFakeDevice(options: FakeDeviceOptions = {}) {
  const key = generateStaticKey();
  const machineId = options.machineId ?? randomUUID();
  const headers: IncomingHttpHeaders[] = [];
  const sockets = new Set<WebSocket>();
  const clients = new Map<string, Client>();
  const invites = new Map<string, string>();
  const live = new Map<WebSocket, { channel?: Channel; clientId?: string }>();
  let startedAt = 1_000;
  const server = new WebSocketServer({
    host: '127.0.0.1', port: 0, perMessageDeflate: false,
    verifyClient: (info, done) => { headers.push(info.req.headers); if (options.refuse) done(false, options.refuse); else done(true); },
  });
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');

  const frame = (ws: WebSocket, channel: Channel, type: number, body?: Buffer): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(channel.encrypt(encodeFrame(type as 0, body)));
  };
  const json = (ws: WebSocket, channel: Channel, value: unknown): void => frame(ws, channel, FRAME.json, Buffer.from(JSON.stringify(value)));
  /** Said inside the channel (the only close a client believes past message 2), then on the socket. */
  const shut = (ws: WebSocket, code: number, reason: string): void => {
    const channel = live.get(ws)?.channel;
    if (channel) frame(ws, channel, FRAME.close, closeBody(code, reason));
    ws.close(code, reason);
  };

  server.on('connection', ws => {
    sockets.add(ws);
    ws.on('close', () => { sockets.delete(ws); live.delete(ws); });
    const state: { channel?: Channel; clientId?: string } = {};
    live.set(ws, state);
    let phase: 'handshake' | 'unpaired' | 'hello' | 'ready' = 'handshake';
    let pairingKey = '';
    ws.on('message', (data: Buffer) => {
      if (options.hold) return;
      if (phase === 'handshake') {
        const responder = createResponder(key.key);
        let remote: Buffer;
        try { remote = responder.readMessage1(data).remoteStaticPublicKey; }
        catch { ws.close(4005, 'handshake_failed'); return; }
        const answer = responder.message2();
        state.channel = answer.channel;
        ws.send(answer.bytes);
        pairingKey = remote.toString('base64url');
        const record = [...clients.values()].find(client => client.publicKey === pairingKey);
        if (record?.revokedAt !== undefined) { shut(ws, 4003, 'client_revoked'); return; }
        if (record) { state.clientId = record.id; phase = 'hello'; return; }
        phase = 'unpaired';
        return;
      }
      const channel = state.channel!;
      const plain = decodeFrame(channel.decrypt(data));
      if (plain.type === FRAME.ping) { frame(ws, channel, FRAME.pong); return; }
      if (plain.type !== FRAME.json) return;
      const value = JSON.parse(plain.body.toString('utf8')) as Record<string, unknown>;
      if (phase === 'unpaired') {
        const request = pairRequestSchema.safeParse(value);
        if (!request.success) { shut(ws, 4002, 'unknown_client'); return; }
        if (invites.get(request.data.inviteId) !== request.data.inviteSecret) { shut(ws, 4007, 'pairing_failed'); return; }
        invites.delete(request.data.inviteId);
        const id = `cl_${randomBytes(8).toString('hex')}`;
        clients.set(id, { id, publicKey: pairingKey, name: request.data.clientName });
        state.clientId = id;
        json(ws, channel, { type: 'pairResult', clientId: id, deviceName: '测试机' });
        phase = 'hello';
        return;
      }
      if (phase === 'hello') {
        helloSchema.parse(value);
        phase = 'ready';
        json(ws, channel, {
          type: 'serverInfo', machineId, version: options.version ?? '0.9.0', protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
          deviceName: '测试机', platform: 'linux', capabilities: ['device'], principal: 'owner:paired',
        });
        return;
      }
      const id = value.id as string;
      const method = value.method as string;
      const payload = value.payload as { type?: string; clientId?: string };
      const reply = (body: unknown): void => json(ws, channel, { type: 'response', id, method, payload: body });
      if (method === 'admin' && payload.type === 'daemonStatus') {
        reply({ kind: 'daemonStatus', status: { installed: false, running: true, selfHosted: true, version: options.version ?? '0.9.0', supported: true, pid: 4242, startedAt } });
        return;
      }
      if (method === 'device' && payload.type === 'clients') {
        reply({ kind: 'clients', generation: 1, clients: [...clients.values()].map(client => ({
          id: client.id, name: client.name, publicKey: client.publicKey, clientKind: 'desktop', createdAt: 1, lastSeenAt: 1,
          lastAddress: '127.0.0.1:1', pairedVia: 'invite', invitedBy: 'local', ...(client.revokedAt === undefined ? {} : { revokedAt: client.revokedAt }),
        })) });
        return;
      }
      if (method === 'device' && payload.type === 'revokeClient' && payload.clientId) {
        const target = clients.get(payload.clientId);
        if (target) target.revokedAt = Date.now();
        reply({ kind: 'revoked', revoked: target ? [target.id] : [] });
        for (const [socket, other] of live) if (other.clientId === payload.clientId) shut(socket, 4003, 'client_revoked');
        return;
      }
      json(ws, channel, { type: 'error', id, code: 'unsupported', message: 'not in this fake' });
    });
  });

  return {
    port: address.port,
    machineId,
    pk: key.publicKeyBase64url,
    headers,
    clients,
    sockets,
    /** A one-time invite, as `vonvon pair` would make. */
    invite() {
      const id = `inv_${randomBytes(8).toString('hex')}`;
      const secret = randomBytes(32).toString('base64url');
      invites.set(id, secret);
      return { inviteId: id, inviteSecret: secret };
    },
    revoke(clientId: string) {
      const target = clients.get(clientId);
      if (target) target.revokedAt = Date.now();
      for (const [socket, other] of live) if (other.clientId === clientId) shut(socket, 4003, 'client_revoked');
    },
    closeAll(code: number, reason: string) { for (const socket of [...sockets]) shut(socket, code, reason); },
    restart() { startedAt += 1; },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/** A box that only base64-wraps: tests and the manual probe, never the app. */
export function plainSecretBox(options: { available?: () => boolean; open?: (sealed: string) => string } = {}): SecretBox {
  return {
    available: options.available ?? (() => true),
    seal: plain => `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`,
    open: options.open ?? (sealed => {
      if (!sealed.startsWith('sealed:')) throw new Error('not sealed');
      return Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8');
    }),
  };
}
