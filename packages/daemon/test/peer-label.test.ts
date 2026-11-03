import { expect, it } from 'vitest';
import type { ClientRecord } from '@vonvon/protocol';
import { localPeerLabel, pairedPeerName, peerName, peerOwner } from '../src/server/peer-label';
import type { Principal } from '../src/server/principal';

// devices-ui-3 4.2: whose a scan is, and how a refusal names it. main 必败: no peer-label.ts
const id = 'cl_0123456789abcdef';
const clients = { get: (clientId: string) => clientId === id ? { id, name: 'Clay 的 MacBook' } as ClientRecord : undefined };
const at = (principal: Principal, clientKind?: 'desktop' | 'cli' | 'web') => ({ principal, ...(clientKind ? { clientKind } : {}) });

it('keys a paired client by its id and one on this computer by its kind', () => {
  expect(peerOwner(at({ kind: 'owner', via: 'paired', clientId: id, generation: 1 }, 'desktop'), clients, '办公室 Mac'))
    .toEqual({ key: `paired:${id}`, label: '另一台设备「Clay 的 MacBook」', far: '另一台设备「Clay 的 MacBook」' });
  expect(peerOwner(at({ kind: 'owner', via: 'local' }, 'cli'), clients, '办公室 Mac')).toEqual({ key: 'local:cli', label: '本机的命令行', far: '「办公室 Mac」上的命令行' });
  expect(peerOwner(at({ kind: 'owner', via: 'local' }), clients, '办公室 Mac')).toEqual({ key: 'local:unknown', label: '本机的客户端', far: '「办公室 Mac」上的客户端' });
  expect(peerOwner(at({ kind: 'bot-session', sessionId: 's', appId: 'cli_a', place: 'dm' }, 'cli'), clients, 'x')).toBeUndefined();
  expect(peerOwner(at({ kind: 'maintenance', protocolVersion: 1, inner: 'owner:local' }, 'desktop'), clients, 'x')).toBeUndefined();
});
it('names a client it does not know, and each kind of this computer', () => {
  expect(pairedPeerName('cl_ffffffffffffffff', clients)).toBe('未知设备');
  expect(['desktop', 'cli', 'web', 'other', undefined].map(localPeerLabel)).toEqual(['本机的桌面端', '本机的命令行', '本机的网页端', '本机的客户端', '本机的客户端']);
});
// U4: who asks for an update, by the connection's client id (a paired client's maintenance connection has one too).
it('names who asks for an update: a paired client by its name, one on this computer by its kind', () => {
  expect(peerName({ clientId: id, clientKind: 'desktop' }, clients)).toBe('「Clay 的 MacBook」');
  expect(peerName({ clientId: 'cl_ffffffffffffffff', clientKind: 'cli' }, clients)).toBe('另一台设备');
  expect(peerName({ clientKind: 'cli' }, clients)).toBe('本机的命令行');
  expect(peerName({}, clients)).toBe('本机的客户端');
});
