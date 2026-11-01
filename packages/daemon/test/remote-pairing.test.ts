import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Event } from '@vonvon/protocol';
import { createClientRegistry } from '../src/remote/clients';
import { announceRevocations, completePairing, createInviteBook, INVITE_TTL_MS, PairingError } from '../src/remote/pairing';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'vonvon-pairing-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it('keeps at most three unused invites', () => {
  const book = createInviteBook();
  const invites = [1, 2, 3].map(() => book.create({ invitedBy: 'local' }));
  expect(invites[0]?.id).toMatch(/^inv_[0-9a-f]{16}$/);
  expect(() => book.create({ invitedBy: 'local' })).toThrow(expect.objectContaining({ code: 'pairing_limit' }));
  const [first] = invites;
  if (!first) throw new Error('no invite');
  expect(book.redeem(first.id, first.secret)).toMatchObject({ id: first.id, invitedBy: 'local' });
  expect(book.create({ invitedBy: 'local' }).id).toMatch(/^inv_/);
  expect(book.size()).toBe(3);
});
it('lets an invite be used once, before it expires, with its exact secret', () => {
  let now = 0;
  const book = createInviteBook({ now: () => now });
  const a = book.create({ invitedBy: 'local' });
  expect(a.expiresAt).toBe(INVITE_TTL_MS);
  for (const wrong of [`${a.secret.slice(0, -1)}${a.secret.endsWith('A') ? 'B' : 'A'}`, a.secret.slice(0, -1), `${a.secret}x`]) expect(book.redeem(a.id, wrong)).toBeUndefined();
  expect(book.redeem(a.id, a.secret)).toBeDefined();
  expect(book.redeem(a.id, a.secret)).toBeUndefined();
  const b = book.create({ invitedBy: 'local' });
  expect(book.has(b.id)).toBe(true);
  now += 10 * 60_000 + 1000;
  expect(book.has(b.id)).toBe(false);
  expect(book.redeem(b.id, b.secret)).toBeUndefined();
});
it('registers the paired client and tells the owner, never logging the secret', async () => {
  const invites = createInviteBook();
  const clients = await createClientRegistry(home);
  const published: Event[] = [];
  const log = { info: vi.fn() };
  const deps = { invites, clients, device: { name: '工作电脑' }, publish: (event: Event) => published.push(event), log };
  const invite = invites.create({ invitedBy: 'local' });
  const request = { type: 'pairRequest' as const, inviteId: invite.id, inviteSecret: invite.secret, clientName: '笔记本', clientKind: 'desktop' as const };
  const result = await completePairing(deps, { publicKey: 'k'.repeat(43), request, address: '192.0.2.5:50000' });
  expect(result).toEqual({ clientId: expect.stringMatching(/^cl_/), deviceName: '工作电脑' });
  expect(JSON.parse(await readFile(join(home, 'clients.json'), 'utf8')).clients).toMatchObject([{ id: result.clientId, name: '笔记本', invitedBy: 'local' }]);
  expect(published).toEqual([{ type: 'event', event: 'device', payload: { change: 'client-paired', clientId: result.clientId, name: '笔记本', clientKind: 'desktop', address: '192.0.2.5:50000', invitedBy: 'local' } }]);
  expect(log.info).toHaveBeenCalledWith('device', 'client-paired', expect.objectContaining({ clientId: result.clientId }));

  const again = completePairing(deps, { publicKey: 'm'.repeat(43), request, address: '192.0.2.6:50000' });
  await expect(again).rejects.toBeInstanceOf(PairingError);
  await expect(again).rejects.toMatchObject({ code: 'pairing_failed' });
  expect(clients.generation).toBe(1);
  expect(published).toHaveLength(1);

  // devices 4.3: each revoked client, however revoked, reaches the owner and the log
  announceRevocations(deps);
  await clients.revoke(result.clientId);
  expect(published[1]).toEqual({ type: 'event', event: 'device', payload: { change: 'client-revoked', clientId: result.clientId, name: '笔记本', clientKind: 'desktop', address: '192.0.2.5:50000', invitedBy: 'local' } });
  expect(log.info).toHaveBeenLastCalledWith('device', 'client-revoked', expect.objectContaining({ clientId: result.clientId }));
  expect(JSON.stringify(log.info.mock.calls)).not.toMatch(new RegExp(`${invite.secret}|vonvon://`));
});
