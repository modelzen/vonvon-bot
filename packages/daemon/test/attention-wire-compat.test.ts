import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {afterEach, expect, it} from 'vitest';
import {WebSocket} from 'ws';
import {agentIdSchema, agentSchema, botDiagnosticsSchema, desktopSnapshotSchema, groupAttentionSchema, type DesktopSnapshot, type Request} from '@vonvon/protocol';
import {createSocketServer, type Peer} from '../src/server/ws';
import {attentionFrame, attentionSnapshot} from '../src/server/attention-compat';

// Previous v2 records have exactly the original place/budget fields and reject group.
const legacyAttention = groupAttentionSchema.pick({groupId: true, main: true, focusedTopics: true, watchedTopics: true, budget: true}).strict();
const legacySnapshot = desktopSnapshotSchema.omit({attentionModel: true}).extend({
  agents: agentSchema.extend({diagnostics: botDiagnosticsSchema.extend({attention: legacyAttention.array().optional()}).optional()}).array(),
});
const snapshot: DesktopSnapshot = {
  attentionModel: 'group', revision: 1, observedAt: 1, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'},
  agents: [{id: agentIdSchema.parse('cli_attention'), name: 'bot', enabled: true, running: true, connection: 'connected', activation: 'active',
    diagnostics: {notReplied: [], deniedScopes: [], attention: [{groupId: 'oc_attention', focusedTopics: 0, watchedTopics: 0,
      group: {score: 10, intervalMs: 300_000, updatedAt: 1}, main: {mode: 'watch', intervalMs: 300_000}}]}}],
  groups: [], memberships: [], tools: [], jobs: [], application: {platform: 'linux', version: 'test', loginItem: false, dataPath: '/tmp/fixture'},
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});

it('projects event, response and nested command snapshots for the old strict v2 schema without mutating shared state', () => {
  expect(legacySnapshot.safeParse(snapshot).success).toBe(false);
  const response = {type: 'response', id: '1', method: 'snapshot', payload: snapshot} as const;
  const event = {type: 'event', event: 'snapshot', payload: snapshot} as const;
  for (const frame of [response, event]) {
    const shown = attentionFrame(frame, false);
    expect(legacySnapshot.safeParse(shown.payload).success).toBe(true);
    expect(shown.payload.attentionModel).toBeUndefined();
    expect(shown.payload.agents[0]?.diagnostics?.attention?.[0]?.group).toBeUndefined();
    expect(attentionFrame(frame, true)).toBe(frame);
  }
  const command = {type: 'response', id: '2', method: 'command', payload: {kind: 'applied', revision: 1, snapshot}} as const;
  expect(legacySnapshot.safeParse(attentionFrame(command, false).payload.snapshot).success).toBe(true);
  expect(snapshot.attentionModel).toBe('group');
  expect(snapshot.agents[0]?.diagnostics?.attention?.[0]?.group?.score).toBe(10);
  expect(attentionSnapshot(snapshot, true)).toBe(snapshot);
});

it('opts in on a real loopback connection independently of one-shot admin negotiation', async () => {
  const server = createServer();
  let owner: Peer | undefined;
  const sockets = createSocketServer({server, credential: 'test-credential',
    info: () => ({type: 'serverInfo', version: 'test', protocolVersion: 2, capabilities: ['attention.group']}),
    request: async (peer, request) => {
      owner = peer;
      if (request.method === 'snapshot') {
        peer.send({type: 'response', id: request.id, method: 'snapshot', payload: snapshot});
        peer.event({type: 'event', event: 'snapshot', payload: snapshot});
      }
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  cleanup.push(async () => {await sockets.close(); await new Promise<void>(resolve => server.close(() => resolve()));});
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  cleanup.push(async () => {socket.terminate();});
  const frames: any[] = [];
  socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
  await once(socket, 'open');
  socket.send(JSON.stringify({type: 'hello', protocolVersion: 2, clientKind: 'web', credential: 'test-credential'}));
  await expect.poll(() => frames.find(frame => frame.type === 'serverInfo')).toBeDefined();
  const send = async (payload: Extract<Request, {method: 'snapshot'}>['payload']) => {
    const id = randomUUID();
    socket.send(JSON.stringify({type: 'request', id, method: 'snapshot', payload}));
    await expect.poll(() => frames.find(frame => frame.id === id)).toBeDefined();
    return frames.find(frame => frame.id === id).payload as DesktopSnapshot;
  };
  expect(legacySnapshot.safeParse(await send({type: 'get'})).success).toBe(true);
  expect(owner?.negotiated).toBe(false);
  expect((await send({type: 'get', groupAttention: true})).attentionModel).toBe('group');
  expect(owner?.groupAttention).toBe(true);
  expect(owner?.negotiate(['desktop.self-update'], null)).toBe(true);
  expect(owner?.negotiate([], null)).toBe(false);
  const events = frames.filter(frame => frame.type === 'event');
  expect(events[0].payload.attentionModel).toBeUndefined();
  expect(events.at(-1).payload.attentionModel).toBe('group');
});
