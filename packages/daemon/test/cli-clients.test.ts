import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runClients, runDeviceRename, runPair } from '../src/cli/commands/device';
import { createClientRegistry } from '../src/remote/clients';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'vonvon-cli-clients-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const output = (json = true) => {
  const lines: string[] = [];
  return { lines, io: { json, write: (text: string) => { lines.push(text); } }, last: () => JSON.parse(lines.at(-1) ?? 'null') };
};
const noDaemon = () => { throw new Error('the daemon is not running'); };

// devices 8.1: with no daemon the commands work on the files, and say so. main 必败: there were no such commands.
it('lists, renames and revokes clients and renames the device on the files when no daemon runs', async () => {
  const registry = await createClientRegistry(home);
  const a = await registry.add({ name: '笔记本', publicKey: 'a'.repeat(43), clientKind: 'desktop', address: '192.0.2.1:1', invitedBy: 'local' });
  const b = await registry.add({ name: '台式机', publicKey: 'b'.repeat(43), clientKind: 'cli', address: '192.0.2.2:1', invitedBy: a.id });
  await registry.close();
  const list = output();
  await runClients('ls', {}, list.io, noDaemon, home);
  expect(list.last()).toMatchObject({ ok: true, source: 'files', generation: 2, clients: [{ id: a.id }, { id: b.id }] });
  const human = output(false);
  await runClients('ls', {}, human.io, noDaemon, home);
  expect(human.lines.join('')).toMatch(new RegExp(`${a.id}  笔记本  desktop .*邀请自 local  新\\n`));

  const renamed = output();
  await runClients('rename', { clientId: a.id, name: '旧笔记本' }, renamed.io, noDaemon, home);
  expect(renamed.last()).toMatchObject({ client: { id: a.id, name: '旧笔记本' }, source: 'files' });
  const revoked = output();
  await runClients('revoke', { clientId: a.id, cascade: true }, revoked.io, noDaemon, home);
  expect(revoked.last()).toEqual({ ok: true, revoked: [a.id, b.id], source: 'files' });
  const file = JSON.parse(await readFile(join(home, 'clients.json'), 'utf8'));
  expect(file.clients.map((client: { revokedAt?: number }) => typeof client.revokedAt)).toEqual(['number', 'number']);
  await expect(runClients('revoke', { clientId: 'cl_0000000000000000' }, output().io, noDaemon, home)).rejects.toMatchObject({ kind: 'bad-args' });
  await expect(runClients('rename', { clientId: a.id, name: '' }, output().io, noDaemon, home)).rejects.toMatchObject({ kind: 'bad-args' });
  const device = output();
  await runDeviceRename('B', device.io, noDaemon, home);
  expect(device.last()).toMatchObject({ ok: true, device: { name: 'B' }, source: 'files' });
  expect(JSON.parse(await readFile(join(home, 'device.json'), 'utf8')).name).toBe('B');
});
it('makes a pairing link only through the daemon, and checks --ttl first', async () => {
  await expect(runPair({}, output().io, noDaemon, home)).rejects.toMatchObject({ kind: 'connection', message: expect.stringContaining('vonvon daemon start') });
  for (const ttl of ['0', '11', '2.5', 'x']) await expect(runPair({ ttl }, output().io, noDaemon, home)).rejects.toMatchObject({ kind: 'bad-args' });
});
