import { expect, it } from 'vitest';
import { MAINTENANCE_KINDS, rpcKinds, type Request } from '@vonvon/protocol';
import { authorize, RULES } from '../src/server/authz';
import type { Principal } from '../src/server/principal';

const peer = (principal: Principal) => ({ principal, protocolVersion: principal.kind === 'maintenance' ? 1 : 2, negotiated: false, scope: null });
const request = (method: string, payload: object): Request => ({ type: 'request', id: '1', method, payload } as Request);

// devices 5.2: a new RPC kind is refused until the table names it. main 必败: there was no table.
it('has one row for every RPC kind and no row for anything else', () => {
  const kinds = rpcKinds().map(entry => entry.kind);
  expect(kinds.filter(kind => !RULES.has(kind))).toEqual([]);
  expect([...RULES.keys()].filter(kind => !kinds.includes(kind))).toEqual([]);
  for (const kind of MAINTENANCE_KINDS) expect(RULES.get(kind)?.maintenance).toBe(true);
});

it('lets the owner do everything, a connection of another protocol only the maintenance kinds', async () => {
  const owner = peer({ kind: 'owner', via: 'local' });
  const old = peer({ kind: 'maintenance', protocolVersion: 1, inner: 'owner:local' });
  expect(await authorize(owner, request('command', { type: 'refresh' }))).toEqual({ ok: true });
  expect(await authorize(owner, request('machine', { type: 'service', action: 'start' }))).toEqual({ ok: true });
  expect(await authorize(old, request('command', { type: 'refresh' }))).toMatchObject({ ok: false, code: 'permission_denied' });
  expect(await authorize(old, request('admin', { type: 'daemonStatus' }))).toEqual({ ok: true });
  // a 0.8 desktop or CLI still stops a newer daemon (devices 4.5)
  expect(await authorize(old, request('machine', { type: 'stopHost' }))).toEqual({ ok: true });
  expect(await authorize(peer({ kind: 'unpaired' }), request('admin', { type: 'daemonStatus' }))).toMatchObject({ ok: false, code: 'permission_denied' });
  expect(await authorize(owner, request('command', { type: 'notAKind' }))).toMatchObject({ ok: false, code: 'permission_denied' });
});
