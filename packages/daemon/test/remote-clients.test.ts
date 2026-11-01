import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClientRegistry, type NewClient } from '../src/remote/clients';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'vonvon-clients-')); });
afterEach(async () => { vi.useRealTimers(); await rm(home, { recursive: true, force: true }); });
const file = async () => JSON.parse(await readFile(join(home, 'clients.json'), 'utf8'));
const client = (n: number, invitedBy = 'local'): NewClient => ({ name: `电脑 ${n}`, publicKey: String(n).repeat(43).slice(0, 43), clientKind: 'desktop', address: `192.0.2.${n}:50000`, invitedBy });

it('counts a generation per write and keeps a revoked client as a tombstone', async () => {
  const registry = await createClientRegistry(home, { now: () => 5 });
  const changes: Array<[number, readonly string[]]> = [];
  registry.onChange((generation, revoked) => changes.push([generation, revoked]));
  expect(registry.generation).toBe(0);
  const a = await registry.add(client(1));
  expect(a.id).toMatch(/^cl_[0-9a-f]{16}$/);
  expect(registry.generation).toBe(1);
  if (process.platform !== 'win32') expect((await stat(join(home, 'clients.json'))).mode & 0o777).toBe(0o600);
  await registry.rename(a.id, '笔记本');
  expect(registry.generation).toBe(2);
  expect(await registry.revoke(a.id)).toEqual([a.id]);
  expect(registry.generation).toBe(3);
  expect(await file()).toMatchObject({ v: 1, generation: 3, clients: [{ id: a.id, name: '笔记本', revokedAt: 5, invitedBy: 'local' }] });
  expect(changes).toEqual([[1, []], [2, []], [3, [a.id]]]);
  expect(await registry.revoke(a.id)).toEqual([]);
  expect(registry.generation).toBe(3);
  await expect(registry.rename('cl_0000000000000000', 'x')).rejects.toMatchObject({ code: 'invalid_request' });
  const reread = await createClientRegistry(home);
  expect(reread.generation).toBe(3);
  expect(reread.list()).toEqual(registry.list());
});

it('revokes down the invitation line only when asked to', async () => {
  const registry = await createClientRegistry(home);
  const a = await registry.add(client(1));
  const b = await registry.add(client(2, a.id));
  const c = await registry.add(client(3, b.id));
  const other = await registry.add(client(4));
  expect(await registry.revoke(a.id)).toEqual([a.id]);
  expect(await registry.revoke(a.id, { cascade: true })).toEqual([b.id, c.id]);
  expect(registry.get(other.id)?.revokedAt).toBeUndefined();
  const fresh = await createClientRegistry(await mkdtemp(join(home, 'cascade-')));
  const x = await fresh.add(client(1));
  const y = await fresh.add(client(2, x.id));
  const z = await fresh.add(client(3, y.id));
  expect(await fresh.revoke(x.id, { cascade: true })).toEqual([x.id, y.id, z.id]);
});

it('finds a revoked key and refuses to pair it again; a known key is the same client', async () => {
  const registry = await createClientRegistry(home);
  const a = await registry.add(client(1));
  expect((await registry.add({ ...client(1), name: '别的名字' })).id).toBe(a.id);
  expect(registry.list()).toHaveLength(1);
  await registry.revoke(a.id);
  expect(registry.byPublicKey(client(1).publicKey)).toMatchObject({ id: a.id, revokedAt: expect.any(Number) });
  expect(registry.byPublicKey(client(9).publicKey)).toBeUndefined();
  await expect(registry.add(client(1))).rejects.toMatchObject({ code: 'client_revoked' });
});

it('writes last-seen at most once a period, and on close', async () => {
  vi.useFakeTimers();
  let now = 100;
  const registry = await createClientRegistry(home, { now: () => now, touchEveryMs: 60_000 });
  const a = await registry.add(client(1));
  for (let i = 0; i < 60; i++) { now += 1; registry.touch(a.id, `192.0.2.7:${i}`); }
  expect(registry.generation).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(registry.generation).toBe(2);
  // close() also waits for the write the timer started
  await registry.close();
  expect(registry.generation).toBe(2);
  expect(await file()).toMatchObject({ clients: [{ lastSeenAt: 160, lastAddress: '192.0.2.7:59' }] });
  now = 500;
  registry.touch(a.id, '192.0.2.8:1');
  await registry.close();
  expect(registry.generation).toBe(3);
  expect(await file()).toMatchObject({ clients: [{ lastSeenAt: 500, lastAddress: '192.0.2.8:1' }] });
});

it('refuses a damaged list instead of treating it as empty', async () => {
  await writeFile(join(home, 'clients.json'), JSON.stringify({ v: 1, generation: 2, clients: [{ id: 'x' }] }));
  await expect(createClientRegistry(home)).rejects.toThrow('clients.json 损坏');
});
