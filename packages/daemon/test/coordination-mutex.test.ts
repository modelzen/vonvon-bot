import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { acquireMutex, closeMutex, DataAccessError } from '../src/config/data-access';
import { bundleDataAccess, holdMutex, mutexChild } from './helpers/mutex-child';

const roles = ['admission', 'host', 'keystore', 'service', 'bots', 'projects', 'creation'] as const;
type Role = typeof roles[number];
let scratch = '';
let entry = '';
let homes = 0;
const children: ChildProcess[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-mutex-')));
  entry = await bundleDataAccess(scratch);
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const newHome = (): string => { const path = join(scratch, `home-${homes++}`); mkdirSync(path); return path; };
const busy = (role: Role) => `Bridge ${role} is busy on its local coordination endpoint.`;
/**
 * A new home whose `role` port from before s20c (`20000 + sha256("vonvon-bot-v2:<role>:<realpath>") % 30000`, which
 * builds from s20c until s20e still probed) is held by an unrelated listener that does `onConnection`.
 */
async function homeBehindListener(role: Role, onConnection: (socket: Socket) => void): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const home = newHome();
    const port = 20000 + createHash('sha256').update(`vonvon-bot-v2:${role}:${home}`).digest().readUInt32BE(0) % 30000;
    const server = createServer(socket => { sockets.push(socket); socket.on('error', () => {}); onConnection(socket); });
    const listening = await new Promise<boolean>((resolve, reject) => {
      server.once('error', error => 'code' in error && error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(true));
    });
    if (listening) { servers.push(server); return home; }
  }
  throw new Error('No free port for the fixture listener');
}

describe('the coordination mutex', () => {
  it.each(roles)('keeps other processes out of %s until its holder dies, then is free at once', async role => {
    const home = newHome();
    const holder = await holdMutex(entry, home, role);
    children.push(holder.child);
    const refused = await acquireMutex(home, role, 100).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DataAccessError);
    expect((refused as Error).message).toBe(busy(role));
    const exited = once(holder.child, 'exit');
    holder.child.kill('SIGKILL');
    await exited;
    await closeMutex(await acquireMutex(home, role, 0));
  });

  it('is busy for a second acquire in the same process, and a second release is harmless', async () => {
    const home = newHome();
    const first = await acquireMutex(home, 'host', 0);
    await expect(acquireMutex(home, 'host', 0)).rejects.toThrow(busy('host'));
    await closeMutex(first);
    await closeMutex(first);
    await closeMutex(await acquireMutex(home, 'host', 0));
  });

  it('keys the lock on the real path of the data root and on the role', async () => {
    const home = newHome();
    const other = newHome();
    const link = join(scratch, `link-${homes++}`);
    symlinkSync(home, link);
    const held = await acquireMutex(home, 'host', 0);
    try {
      await expect(acquireMutex(link, 'host', 0)).rejects.toThrow(busy('host'));
      await closeMutex(await acquireMutex(home, 'admission', 0));
      await closeMutex(await acquireMutex(other, 'host', 0));
    } finally { await closeMutex(held); }
  });

  it('is not inherited by a child the holder starts', async () => {
    const home = newHome();
    const holder = await mutexChild(entry, `m.acquireMutex(process.argv[1],'host',0).then(()=>{
const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write('ready'+c.pid)})`, [home]);
    children.push(holder.child);
    const grandchild = Number(holder.output());
    try {
      const exited = once(holder.child, 'exit');
      holder.child.kill('SIGKILL');
      await exited;
      process.kill(grandchild, 0);
      await closeMutex(await acquireMutex(home, 'host', 0));
    } finally { process.kill(grandchild, 'SIGKILL'); }
  });

  it.runIf(platform() === 'darwin')('refuses a lock directory that is a symlink', async () => {
    const home = newHome();
    symlinkSync(newHome(), join(home, '.locks'));
    await expect(acquireMutex(home, 'host', 0)).rejects.toThrow(/Invalid lock directory/);
  });

  // s20e: until then a holder probed this port too and took any listener that stayed silent for a second, or closed
  // without a word, for a build before s20c holding the lock. Unrelated listeners on macOS CI made #382 and #385 busy.
  it.each(roles.flatMap(role => [
    [role, 'never speaks', () => {}],
    [role, 'closes every connection at once', (socket: Socket) => socket.destroy()],
  ] as const))('takes %s at once while an unrelated listener that %s has its port from before s20c', async (role, _kind, onConnection) => {
    const home = await homeBehindListener(role, onConnection);
    const started = Date.now();
    await closeMutex(await acquireMutex(home, role, 0));
    // One try, well under the second the old probe waited for an answer.
    expect(Date.now() - started).toBeLessThan(900);
  });
});
