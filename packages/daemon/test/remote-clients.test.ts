import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClientRegistry, type NewClient } from '../src/remote/clients';
import { devicesPath } from '../src/remote/files';

/** The next writes to fail, in order (`undefined` lets one through), before anything reaches the disk. */
const failures = vi.hoisted(() => ({ writes: [] as Array<Error | undefined> }));
vi.mock('../src/server/atomic-file', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/server/atomic-file')>();
  return {
    ...actual,
    writeFileAtomic: (...args: Parameters<typeof actual.writeFileAtomic>) => {
      const failure = failures.writes.shift();
      return failure ? Promise.reject(failure) : actual.writeFileAtomic(...args);
    },
  };
});
const noSpace = (): Error => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });

let home: string;
beforeEach(async () => { failures.writes.length = 0; home = await mkdtemp(join(tmpdir(), 'vonvon-clients-')); });
afterEach(async () => { vi.useRealTimers(); await rm(home, { recursive: true, force: true }); });
const path = (): string => devicesPath(home, 'clients.json');
const file = async () => JSON.parse(await readFile(path(), 'utf8'));
const client = (n: number, invitedBy = 'local'): NewClient => ({ name: `电脑 ${n}`, publicKey: String(n).repeat(43).slice(0, 43), clientKind: 'desktop', address: `192.0.2.${n}:50000`, invitedBy });

it('counts a generation per write and keeps a revoked client as a tombstone', async () => {
  const registry = await createClientRegistry(home, { now: () => 5 });
  const changes: Array<[number, readonly string[]]> = [];
  registry.onChange((generation, revoked) => changes.push([generation, revoked]));
  expect(registry.generation).toBe(0);
  const a = await registry.add(client(1));
  expect(a.id).toMatch(/^cl_[0-9a-f]{16}$/);
  expect(registry.generation).toBe(1);
  if (process.platform !== 'win32') expect((await stat(path())).mode & 0o777).toBe(0o600);
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
  const x = await registry.add(client(4));
  const y = await registry.add(client(5, x.id));
  expect(await registry.revoke(x.id)).toEqual([x.id]);
  expect(registry.get(y.id)?.revokedAt).toBeUndefined();
  expect(await registry.revoke(a.id, { cascade: true })).toEqual([a.id, b.id, c.id]);
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
  // close() also waits for the write the timer started, and has nothing left to write: one write for the 60
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
  await mkdir(join(home, 'devices'));
  await writeFile(path(), JSON.stringify({ v: 1, generation: 2, clients: [{ id: 'x' }] }));
  await expect(createClientRegistry(home)).rejects.toThrow('clients.json 损坏');
});
// D1-R5: after a rollback, the fields a newer version wrote are no damage: kept on disk, left out of the replies;
// a newer format is named as such. main 必败: the daemon refused to start, "clients.json 损坏".
it('reads and keeps the fields a newer version added, and names a newer format', async () => {
  const registry = await createClientRegistry(home);
  const a = await registry.add(client(1));
  await registry.close();
  const stored = await file();
  await writeFile(path(), JSON.stringify({ ...stored, relay: 'r', clients: [{ ...stored.clients[0], accountId: 'acc_1' }] }));
  const reread = await createClientRegistry(home);
  expect(reread.list()).toEqual([expect.not.objectContaining({ accountId: expect.anything() })]);
  expect(reread.get(a.id)).toEqual(registry.get(a.id));
  await reread.revoke(a.id);
  expect(await file()).toMatchObject({ relay: 'r', generation: 2, clients: [{ id: a.id, accountId: 'acc_1', revokedAt: expect.any(Number) }] });
  await writeFile(path(), JSON.stringify({ ...stored, v: 2 }));
  await expect(createClientRegistry(home)).rejects.toThrow('较新版本');
});

// Codex 审查任务 213、215: a change counts once it is written. A revocation whose write failed stays undone, and its
// retry writes it. main 必败: the retry said "already revoked" ([]), the file kept the client valid, no listener heard of
// it (the invites it made stayed usable), and a reload let it back in.
it('changes nothing when a revocation cannot be written, so its retry writes it', async () => {
  const registry = await createClientRegistry(home);
  const a = await registry.add(client(1));
  const changes: Array<[number, readonly string[]]> = [];
  registry.onChange((generation, revoked) => changes.push([generation, revoked]));
  // a directory in its place: the atomic replace fails before it commits, as on a disk that is full or failing
  await rename(path(), `${path()}.saved`);
  await mkdir(path());
  await expect(registry.revoke(a.id)).rejects.toThrow();
  expect([registry.get(a.id)?.revokedAt, registry.generation, changes]).toEqual([undefined, 1, []]);
  await registry.close();
  await rmdir(path());
  await rename(`${path()}.saved`, path());
  expect(await registry.revoke(a.id)).toEqual([a.id]);
  expect(changes).toEqual([[2, [a.id]]]);
  expect(await file()).toMatchObject({ generation: 2, clients: [{ id: a.id, revokedAt: expect.any(Number) }] });
  await registry.close();
  expect((await createClientRegistry(home)).get(a.id)?.revokedAt).toEqual(expect.any(Number));
});
// Same for a pairing and a rename. main 必败: the failed add was listed (and its retry, finding the key, wrote nothing);
// the failed rename showed the new name.
it('adds and renames only once written, and retries a failed write for real', async () => {
  const registry = await createClientRegistry(home);
  const changes: Array<[number, readonly string[]]> = [];
  registry.onChange((generation, revoked) => changes.push([generation, revoked]));
  failures.writes.push(noSpace());
  await expect(registry.add(client(1))).rejects.toMatchObject({ code: 'ENOSPC' });
  expect([registry.list(), registry.byPublicKey(client(1).publicKey), registry.generation, changes]).toEqual([[], undefined, 0, []]);
  const a = await registry.add(client(1));
  expect(registry.list()).toEqual([a]);
  failures.writes.push(noSpace());
  await expect(registry.rename(a.id, '笔记本')).rejects.toMatchObject({ code: 'ENOSPC' });
  expect([registry.get(a.id)?.name, registry.generation]).toEqual(['电脑 1', 1]);
  expect(await registry.rename(a.id, '笔记本')).toMatchObject({ id: a.id, name: '笔记本' });
  expect(changes).toEqual([[1, []], [2, []]]);
  expect(await file()).toMatchObject({ generation: 2, clients: [{ id: a.id, name: '笔记本' }] });
  await registry.close();
  expect((await createClientRegistry(home)).list()).toEqual(registry.list());
});
// Changes made at once land in the order made; one that fails neither rides along in the next write nor stops it.
// main 必败: the failed revocation reached the disk with the rename after it.
it('runs changes in order, and one that fails neither leaks into the next write nor holds up the rest', async () => {
  const registry = await createClientRegistry(home);
  const a = await registry.add(client(1));
  const changes: Array<[number, readonly string[]]> = [];
  registry.onChange((generation, revoked) => changes.push([generation, revoked]));
  failures.writes.push(undefined, noSpace());
  const results = await Promise.allSettled([registry.rename(a.id, '甲'), registry.revoke(a.id), registry.rename(a.id, '乙')]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  expect(changes).toEqual([[2, []], [3, []]]);
  expect(registry.get(a.id)).toMatchObject({ name: '乙' });
  expect(registry.get(a.id)?.revokedAt).toBeUndefined();
  const stored = await file();
  expect(stored).toMatchObject({ generation: 3, clients: [{ id: a.id, name: '乙' }] });
  expect(stored.clients[0].revokedAt).toBeUndefined();
  const [b1, b2] = await Promise.all([registry.add(client(2)), registry.add(client(2))]);
  expect(b2.id).toBe(b1.id);
  expect(await Promise.all([registry.revoke(a.id), registry.revoke(a.id)])).toEqual([[a.id], []]);
  expect(changes).toEqual([[2, []], [3, []], [4, []], [5, [a.id]]]);
  expect((await file()).generation).toBe(5);
});
// main 必败: the failed write had already marked last-seen as written, so close() never wrote it again.
it('keeps last-seen to write again when its write fails', async () => {
  let now = 100;
  const registry = await createClientRegistry(home, { now: () => now });
  const a = await registry.add(client(1));
  now = 200;
  registry.touch(a.id, '192.0.2.9:1');
  failures.writes.push(noSpace());
  await expect(registry.close()).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(registry.get(a.id)).toMatchObject({ lastSeenAt: 200, lastAddress: '192.0.2.9:1' });
  await registry.close();
  expect(await file()).toMatchObject({ generation: 2, clients: [{ lastSeenAt: 200, lastAddress: '192.0.2.9:1' }] });
});
// Codex 审查任务 219: close() writes behind the changes already queued. 147b2619 必败: close() found nothing to write
// before the queued add of a known key touched, so the disk kept 100/initial until a second close().
it('writes on one close the last-seen of an add queued before it', async () => {
  let now = 100;
  const registry = await createClientRegistry(home, { now: () => now });
  const a = await registry.add({ ...client(1), address: 'initial' });
  now = 200;
  const adding = registry.add({ ...client(1), address: 'latest' });
  await registry.close();
  expect(await adding).toMatchObject({ id: a.id, lastSeenAt: 200, lastAddress: 'latest' });
  expect(await file()).toMatchObject({ generation: 2, clients: [{ id: a.id, lastSeenAt: 200, lastAddress: 'latest' }] });
  expect((await createClientRegistry(home)).get(a.id)).toMatchObject({ lastSeenAt: 200, lastAddress: 'latest' });
});
// What is queued or touched while close() waits is written before it settles, and no timer is left. 147b2619 必败.
it('writes on close what is queued and touched while it waits, and leaves no timer', async () => {
  vi.useFakeTimers();
  let now = 100;
  const registry = await createClientRegistry(home, { now: () => now });
  const a = await registry.add(client(1));
  const b = await registry.add(client(2));
  now = 200;
  const closing = registry.close();
  registry.touch(a.id, '192.0.2.1:1');
  const adding = registry.add({ ...client(2), address: '192.0.2.2:2' });
  const renaming = registry.rename(a.id, '笔记本');
  await closing;
  await Promise.all([adding, renaming]);
  expect(vi.getTimerCount()).toBe(0);
  expect(await file()).toMatchObject({ clients: [
    { id: a.id, name: '笔记本', lastSeenAt: 200, lastAddress: '192.0.2.1:1' },
    { id: b.id, lastSeenAt: 200, lastAddress: '192.0.2.2:2' },
  ] });
});
// Sonnet 复查 7674fb13: two close() at once, or one from an onChange listener while another runs, each took the other's
// flush for a change queued after its own and flushed again forever, in microtasks alone. 7674fb13 必败. That spin starves
// timers, vitest's timeout too, so it runs in a child process the parent kills after 10 s.
it('settles close() called twice at once, or from a listener while one runs', async () => {
  const entry = join(home, 'clients.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/remote/clients.ts', import.meta.url))], outfile: entry,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const script = `const { createClientRegistry } = require(${JSON.stringify(entry)});
const { mkdtempSync } = require('node:fs'), { join } = require('node:path');
const fresh = async () => {
  const root = mkdtempSync(join(${JSON.stringify(home)}, 'data-'));
  const r = await createClientRegistry(root, { now: () => 1 });
  const a = await r.add({ name: 'x', publicKey: 'a'.repeat(43), clientKind: 'cli', address: 'first', invitedBy: 'local' });
  return { root, r, a };
};
const disk = async (root, id) => {
  const { lastAddress, revokedAt } = (await createClientRegistry(root)).get(id);
  return { lastAddress, revoked: revokedAt !== undefined };
};
(async () => {
  const out = {};
  { const { root, r, a } = await fresh(); await Promise.all([r.close(), r.close()]); out.idle = await disk(root, a.id); }
  { const { root, r, a } = await fresh(); r.touch(a.id, 'latest'); await Promise.all([r.close(), r.close(), r.close()]);
    const first = await disk(root, a.id); r.touch(a.id, 'later'); await r.close(); out.touched = [first, await disk(root, a.id)]; }
  { const { root, r, a } = await fresh(); r.onChange(() => { void r.close(); }); r.touch(a.id, 'latest'); await r.close();
    out.listener = await disk(root, a.id); }
  { const { root, r, a } = await fresh(); r.onChange(() => { void r.close(); }); await Promise.all([r.revoke(a.id), r.close()]);
    out.listenerRevoke = await disk(root, a.id); }
  process.stdout.write(JSON.stringify(out));
})().catch(error => { console.error(error); process.exitCode = 1; });`;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
  expect({ signal: run.signal, status: run.status, stderr: run.stderr }).toEqual({ signal: null, status: 0, stderr: '' });
  expect(JSON.parse(run.stdout)).toEqual({
    idle: { lastAddress: 'first', revoked: false },
    touched: [{ lastAddress: 'latest', revoked: false }, { lastAddress: 'later', revoked: false }],
    listener: { lastAddress: 'latest', revoked: false },
    listenerRevoke: { lastAddress: 'first', revoked: true },
  });
});
