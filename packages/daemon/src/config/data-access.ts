import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer, type ListenOptions, type Server } from 'node:net';
import { platform } from 'node:os';
import { join } from 'node:path';

export class DataAccessError extends Error {}
/** `service` serializes `vonvon service install|uninstall`, whoever runs it: the terminal, the daemon's helper or the desktop's. */
type MutexRole = 'admission' | 'host' | 'keystore' | 'service' | 'bots' | 'projects';
export interface DataLease { release(): void }
/** A held coordination mutex. `closeMutex` releases it; the kernel releases it when the process dies. */
export interface Mutex { readonly role: MutexRole }

export function isDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
    throw new DataAccessError(`Cannot establish whether process ${pid} has exited.`, { cause: error });
  }
}

// The real OS, from Node's own process object: provider-lock-retention stubs the global `process` as darwin or win32
// on Linux, and a lock chosen from that stub would not be one this kernel provides.
const OS = platform();
/** <sys/fcntl.h> on macOS; `fs.constants` has no O_EXLOCK. */
const O_EXLOCK = 0x20;
type Release = () => Promise<void>;
const errorCode = (error: unknown): unknown => error instanceof Error && 'code' in error ? error.code : undefined;
const closeServer = (server: Server): Promise<void> => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

/** Listens on `address`; false when another socket already has it. */
async function listenOn(server: Server, address: ListenOptions): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    return true;
  } catch (error) {
    server.close();
    if (errorCode(error) === 'EADDRINUSE') return false;
    throw error;
  }
}

const portHash = (path: string, role: MutexRole): Buffer => createHash('sha256').update(`vonvon-bot-v2:${role}:${path}`).digest();
const legacyPort = (path: string, role: MutexRole): number => 20000 + portHash(path, role).readUInt32BE(0) % 30000;

/**
 * One try at this OS's lock for `role` on the data root `path`; null while someone holds it. Linux: an abstract Unix
 * socket, which leaves no file and no TIME_WAIT. macOS: `flock` through O_EXLOCK on `.locks/<role>.lock`, never
 * unlinked. The kernel releases both when the process dies, and both are close-on-exec, so children never hold them.
 * Other platforms keep the lock builds before s20c used: a named pipe on Windows, the port elsewhere.
 */
async function tryLock(path: string, role: MutexRole): Promise<Release | null> {
  if (OS === 'darwin') {
    const dir = join(path, '.locks');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    requirePrivateDirectory(dir, 'lock');
    let fd: number;
    try { fd = openSync(join(dir, `${role}.lock`), constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW | O_EXLOCK, 0o600); }
    catch (error) {
      if (errorCode(error) === 'EAGAIN' || errorCode(error) === 'EWOULDBLOCK') return null;
      throw error;
    }
    return async () => closeSync(fd);
  }
  const server = createServer((socket) => socket.destroy());
  return await listenOn(server, socketAddress(path, role)) ? () => closeServer(server) : null;
}

function socketAddress(path: string, role: MutexRole): ListenOptions {
  if (OS === 'linux') return { path: `\0vonvon-bot-mutex-v3:${role}:${createHash('sha256').update(path).digest('hex')}` };
  if (OS === 'win32') return { path: `\\\\.\\pipe\\vonvon-bot-${role}-${portHash(path.toLowerCase(), role).toString('hex')}` };
  return { host: '127.0.0.1', port: legacyPort(path, role), exclusive: true };
}

// --- Transition from builds before s20c. Delete it and its tests once no pre-s20c build is installed (docs/v1-plan.md
// s20c). Those builds lock only by listening on the port, so a holder of the new lock takes the port too when it can.
const LEGACY_MARKER = 'vonvon-mutex-v3\n';
const noRelease: Release = async () => {};

/** Who answers on the old port: a pre-s20c mutex closes without a word, a newer holder of another key sends the marker. */
function legacyOwner(port: number): Promise<'old-build' | 'not-a-lock'> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let connected = false;
    let data = '';
    const settle = (owner: 'old-build' | 'not-a-lock'): void => { socket.destroy(); resolve(owner); };
    // An old daemon whose event loop is blocked still completes the handshake, so silence counts as one.
    socket.setTimeout(1000, () => settle('old-build'));
    socket.setEncoding('utf8');
    socket.once('connect', () => { connected = true; });
    socket.on('data', (chunk: string) => {
      data += chunk;
      if (data === LEGACY_MARKER) settle('not-a-lock');
      else if (!LEGACY_MARKER.startsWith(data)) settle('old-build');
    });
    socket.once('end', () => settle('old-build'));
    // Refused: some connection's local port or a TIME_WAIT, not a listener. Any other failure may hide an old build.
    socket.on('error', (error) => settle(!connected && errorCode(error) === 'ECONNREFUSED' ? 'not-a-lock' : 'old-build'));
  });
}

/** Holds the pre-s20c port as well where the new lock is not that port; null while an old build holds it. */
async function holdLegacyPort(path: string, role: MutexRole): Promise<Release | null> {
  if (OS !== 'linux' && OS !== 'darwin') return noRelease;
  const port = legacyPort(path, role);
  // Destroyed once the marker is out: a peer that keeps its end open would otherwise hold up `closeServer`.
  const server = createServer((socket) => { socket.on('error', () => {}); socket.end(LEGACY_MARKER, () => socket.destroy()); });
  if (await listenOn(server, { host: '127.0.0.1', port, exclusive: true })) return () => closeServer(server);
  return await legacyOwner(port) === 'old-build' ? null : noRelease;
}
// --- End of the transition.

const mutexReleases = new WeakMap<Mutex, Release>();

export async function acquireMutex(home: string, role: MutexRole, timeoutMs = 1500): Promise<Mutex> {
  const path = realpathSync(home);
  const deadline = Date.now() + timeoutMs;
  let lock: Release | null = null;
  try {
    for (;;) {
      lock ??= await tryLock(path, role);
      if (lock) {
        const legacy = role === 'projects' ? noRelease : await holdLegacyPort(path, role);
        if (legacy) return heldMutex(role, [legacy, lock]);
      }
      if (Date.now() >= deadline) throw new DataAccessError(`Bridge ${role} is busy on its local coordination endpoint.`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  } catch (error) {
    // Busy or failed: nothing stays held, the new lock included.
    if (lock) await lock().catch(() => {});
    throw error;
  }
}

function heldMutex(role: MutexRole, releases: Release[]): Mutex {
  const mutex: Mutex = Object.freeze({ role });
  let released: Promise<void> | undefined;
  mutexReleases.set(mutex, () => released ??= releaseAll(role, releases));
  return mutex;
}

async function releaseAll(role: MutexRole, releases: Release[]): Promise<void> {
  const errors: unknown[] = [];
  for (const release of releases) {
    try { await release(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, `Cannot release the Bridge ${role} mutex.`);
}

/** Releases the mutex; calling it again returns the first call's result. */
export function closeMutex(mutex: Mutex): Promise<void> {
  const release = mutexReleases.get(mutex);
  return release ? release() : Promise.reject(new TypeError('Not a mutex from acquireMutex.'));
}

const leaseDirectory = (home: string): string => join(realpathSync(home), '.access');

function requirePrivateDirectory(path: string, kind = 'admission'): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DataAccessError(`Invalid ${kind} directory ${path}.`);
}

export function assertNoDataLeases(home: string): void {
  const dir = leaseDirectory(home);
  let files: string[];
  try { requirePrivateDirectory(dir); files = readdirSync(dir); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const file of files) {
    const path = join(dir, file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new DataAccessError(`Invalid admission record ${path}.`);
    const record: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof record !== 'object' || record === null || !('version' in record) || record.version !== 1
      || !('pid' in record) || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || Object.keys(record).length !== 2) throw new DataAccessError(`Incomplete admission record ${path}.`);
    if (!isDead(record.pid)) throw new DataAccessError(`Bridge data is in use by process ${record.pid}.`);
    unlinkSync(path);
  }
}

export async function enterDataAccess(home: string): Promise<DataLease> {
  const mutex = await acquireMutex(home, 'admission');
  try {
    const dir = leaseDirectory(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    requirePrivateDirectory(dir);
    const path = join(dir, `${process.pid}-${randomUUID()}.json`);
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid })); fsyncSync(fd); }
    finally { closeSync(fd); }
    let released = false;
    const release = (): void => {
      if (released) return;
      unlinkSync(path);
      released = true;
      process.removeListener('exit', onExit);
    };
    const onExit = (): void => {
      try { release(); }
      catch (error) { console.error('Unable to release Bridge data lease:', error instanceof Error ? error.message : String(error)); }
    };
    process.once('exit', onExit);
    return { release };
  } finally { await closeMutex(mutex); }
}
