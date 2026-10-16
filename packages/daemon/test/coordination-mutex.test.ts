import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { acquireMutex, closeMutex, DataAccessError, type Mutex } from '../src/config/data-access';
import { bundleDataAccess, holdMutex, mutexChild } from './helpers/mutex-child';

/** While set, `connect` fails with this code before connecting, the way a probe of the old port can fail. */
const probe = vi.hoisted(() => ({ fail: undefined as string | undefined }));
vi.mock('node:net', async original => {
  const net = await original<typeof import('node:net')>();
  const connect = (...args: Parameters<typeof net.connect>) => {
    const code = probe.fail;
    if (!code) return net.connect(...args);
    const socket = new net.Socket();
    process.nextTick(() => socket.destroy(Object.assign(new Error(`connect ${code}`), { code })));
    return socket;
  };
  return { ...net, connect };
});

const roles = ['admission', 'host', 'keystore', 'service'] as const;
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
  probe.fail = undefined;
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const newHome = (): string => { const path = join(scratch, `home-${homes++}`); mkdirSync(path); return path; };
const busy = (role: Role) => `Bridge ${role} is busy on its local coordination endpoint.`;
const MARKER = 'vonvon-mutex-v3\n';
const portOf = (path: string, role: Role): number => 20000 + createHash('sha256').update(`vonvon-bot-v2:${role}:${path}`).digest().readUInt32BE(0) % 30000;
/** The port builds before s20c lock `role` of `home` on. */
const legacyPort = (home: string, role: Role): number => portOf(realpathSync(home), role);
/** A new home whose `role` has the old port `port`. */
function homeOnPort(port: number, role: Role): string {
  if (port < 20000 || port >= 50000) throw new Error(`Port ${port} is outside the old range`);
  for (let i = 0; ; i++) {
    const path = join(scratch, `port-${port}-${i}`);
    if (portOf(path, role) === port) { mkdirSync(path); return path; }
  }
}
/** Listens the way a build before s20c locks: exclusive on 127.0.0.1. Null when the port is taken. */
function listenOld(port: number, onConnection: (socket: Socket) => void): Promise<Server | null> {
  const server = createServer(socket => { sockets.push(socket); onConnection(socket); });
  return new Promise(resolve => {
    server.once('error', () => resolve(null));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { servers.push(server); resolve(server); });
  });
}
/** What a peer reads from `port` before the other end closes; null when it is refused or nothing ends within a second. */
function answer(port: number): Promise<string | null> {
  const socket = connect({ host: '127.0.0.1', port });
  sockets.push(socket);
  socket.setTimeout(1000, () => socket.destroy());
  socket.on('error', () => {});
  let data = '';
  socket.on('data', chunk => { data += String(chunk); });
  return new Promise(resolve => {
    socket.once('end', () => resolve(data));
    socket.once('close', () => resolve(null));
  });
}
/** Holds `role` of a new home in this process, on a home whose old port it took: another socket may have that port. */
async function holdWithOldPort(role: Role): Promise<{ home: string; mutex: Mutex }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const home = newHome();
    const mutex = await acquireMutex(home, role, 0);
    if (await answer(legacyPort(home, role)) === MARKER) return { home, mutex };
    await closeMutex(mutex);
  }
  throw new Error('No free old port for the fixture');
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
});

describe('the transition from builds before s20c', () => {
  /** A home whose old `role` port a build before s20c holds. */
  async function oldBuild(role: Role, onConnection: (socket: Socket) => void): Promise<{ home: string; server: Server }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const home = newHome();
      const server = await listenOld(legacyPort(home, role), onConnection);
      if (server) return { home, server };
    }
    throw new Error('No free old port for the fixture');
  }

  it.each<[string, (socket: Socket) => void]>([
    ['closes every connection', socket => socket.destroy()],
    ['accepts and never answers', () => {}],
  ])('waits for an old holder that %s, and gives the new lock back at the deadline', async (_case, onConnection) => {
    const { home, server } = await oldBuild('host', onConnection);
    const started = Date.now();
    await expect(acquireMutex(home, 'host', 300)).rejects.toThrow(busy('host'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    // The new lock was given back: a leftover would refuse this same process.
    await closeMutex(await acquireMutex(home, 'host', 0));
  });

  it('takes the lock when the old port is only some connection\'s local port', async () => {
    let local: Socket | undefined;
    for (let attempt = 0; attempt < 400 && !local; attempt++) {
      // Linux numbers the local ports towards one destination from a hashed start, so each try uses a new one.
      const address = (await listenOld(0, () => {}))?.address();
      if (!address || typeof address === 'string') throw new Error('No fixture port');
      const socket = connect({ host: '127.0.0.1', port: address.port });
      sockets.push(socket);
      await once(socket, 'connect');
      if (socket.localPort !== undefined && socket.localPort >= 20000 && socket.localPort < 50000) local = socket;
      else socket.destroy();
    }
    if (!local?.localPort) throw new Error('No ephemeral port in the old range');
    const home = homeOnPort(local.localPort, 'service');
    // As in #339's CI: the port cannot be bound, yet nothing listens on it. Checked on Linux only, where it was seen.
    if (platform() === 'linux') expect(await listenOld(local.localPort, () => {})).toBeNull();
    await closeMutex(await acquireMutex(home, 'service', 0));
  });

  it('takes the lock when connecting to the taken old port is refused', async () => {
    // What #339's CI met: the bind fails, yet nothing listens. Simulated, because macOS can let that bind succeed.
    const { home } = await oldBuild('host', socket => socket.destroy());
    probe.fail = 'ECONNREFUSED';
    await closeMutex(await acquireMutex(home, 'host', 0));
  });

  it.each(['EMFILE', 'EADDRNOTAVAIL'])('stays busy when the probe of a taken old port fails with %s', async code => {
    const { home, server } = await oldBuild('host', socket => socket.destroy());
    probe.fail = code;
    await expect(acquireMutex(home, 'host', 0)).rejects.toThrow(busy('host'));
    probe.fail = undefined;
    await new Promise(resolve => server.close(resolve));
    await closeMutex(await acquireMutex(home, 'host', 0));
  });

  it('takes the lock when a newer holder of another root has the same old port', async () => {
    let port = 0;
    for (let attempt = 0; attempt < 5 && !port; attempt++) {
      const first = newHome();
      const holder = await holdMutex(entry, first, 'host');
      children.push(holder.child);
      // The holder answers with the marker on its old port; another socket may have had that port, so try another root.
      if (await answer(legacyPort(first, 'host')) === MARKER) port = legacyPort(first, 'host');
      else holder.child.kill('SIGKILL');
    }
    if (!port) throw new Error('No free old port for the fixture');
    const second = homeOnPort(port, 'admission');
    await closeMutex(await acquireMutex(second, 'admission', 0));
  });

  it('gives both locks back while a peer keeps its connection to the old port open', async () => {
    const { home, mutex } = await holdWithOldPort('host');
    const peer = connect({ host: '127.0.0.1', port: legacyPort(home, 'host'), allowHalfOpen: true });
    sockets.push(peer);
    peer.resume();
    await once(peer, 'end');
    const released = await Promise.race([closeMutex(mutex).then(() => true), new Promise(resolve => setTimeout(resolve, 1000, false))]);
    expect(released).toBe(true);
    await closeMutex(await acquireMutex(home, 'host', 0));
  });

  it.each(roles)('keeps builds before s20c out of %s while it holds the lock', async role => {
    const { home, mutex } = await holdWithOldPort(role);
    try { expect(await listenOld(legacyPort(home, role), () => {})).toBeNull(); }
    finally { await closeMutex(mutex); }
    expect(await listenOld(legacyPort(home, role), () => {})).not.toBeNull();
  });
});
