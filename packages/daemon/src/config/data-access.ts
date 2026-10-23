import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type ListenOptions, type Server } from 'node:net';
import { platform } from 'node:os';
import { join } from 'node:path';

export class DataAccessError extends Error {}
/** The code on acquireMutex's error when the lock stayed held past the wait, as opposed to a lock that cannot be taken
 * at all (macOS: a bad `.locks` directory); admin/secrets.ts tells the two apart by it. */
export const MUTEX_TIMEOUT = 'DATA_MUTEX_TIMEOUT';
/** `service` serializes `vonvon service install|uninstall`, whoever runs it: the terminal, the daemon's helper or the desktop's.
 * `library` is held on `<数据根>/library/` (the project library, project/library.ts); `memory` on the directory of one
 * memory store, a project's `library/<projectId>/` or a bot's own directory, so projects never queue behind each other. */
type MutexRole = 'admission' | 'host' | 'judge-models' | 'keystore' | 'service' | 'bots' | 'library' | 'projects' | 'memory' | 'creation';
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
const portOf = (path: string, role: MutexRole): number => 20000 + portHash(path, role).readUInt32BE(0) % 30000;

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
  return { host: '127.0.0.1', port: portOf(path, role), exclusive: true };
}

const mutexReleases = new WeakMap<Mutex, Release>();

export async function acquireMutex(home: string, role: MutexRole, timeoutMs = 1500): Promise<Mutex> {
  const path = realpathSync(home);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = await tryLock(path, role);
    if (release) return heldMutex(role, release);
    if (Date.now() >= deadline) throw Object.assign(new DataAccessError(`Bridge ${role} is busy on its local coordination endpoint.`), { code: MUTEX_TIMEOUT });
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function heldMutex(role: MutexRole, release: Release): Mutex {
  const mutex: Mutex = Object.freeze({ role });
  let released: Promise<void> | undefined;
  mutexReleases.set(mutex, () => released ??= release());
  return mutex;
}

/** Releases the mutex; calling it again returns the first call's result. */
export function closeMutex(mutex: Mutex): Promise<void> {
  const release = mutexReleases.get(mutex);
  return release ? release() : Promise.reject(new TypeError('Not a mutex from acquireMutex.'));
}

/**
 * The order in which one call may nest these four (memory design §2.1): bots → library → projects → memory. Holding
 * `projects` a call never takes `library`, so a host that holds `library` and waits for a bot's `projects` cannot meet
 * a bot that holds `projects` and waits for `library`. {@link holdMutexRole} checks it within one process; the other
 * processes keep it because they run the same code.
 */
const LOCK_ORDER = ['bots', 'library', 'projects', 'memory'] as const;
export type OrderedMutexRole = typeof LOCK_ORDER[number];
export class LockOrderError extends DataAccessError {}
type HeldRole = { readonly role: OrderedMutexRole; held: boolean };
const heldRoles = new AsyncLocalStorage<readonly HeldRole[]>();

/**
 * Runs `operation` as the holder of `role`: inside it, taking `role` again or a role that comes earlier in
 * {@link LOCK_ORDER} is refused with {@link LockOrderError} before it waits. Again is refused too: each role's
 * operations queue one at a time in this process, so a nested one would wait for its own caller, and two memory
 * stores held at once could be taken in opposite order by two processes. The role counts as held from this call
 * until `operation` settles; work `operation` started and left running sees it released from then on.
 * Only project/registry.ts (`projects`) and project/library.ts (`library`, `memory`) mark their roles; `bots` is not
 * marked, so taking it inside the others is not caught here.
 */
export function holdMutexRole<T>(role: OrderedMutexRole, operation: () => Promise<T>): Promise<T> {
  const holding = (heldRoles.getStore() ?? []).filter(entry => entry.held);
  const later = holding.find(entry => LOCK_ORDER.indexOf(entry.role) >= LOCK_ORDER.indexOf(role));
  if (later) return Promise.reject(new LockOrderError(`Lock order is ${LOCK_ORDER.join(' → ')}, each once: ${role} cannot be taken while ${later.role} is held.`));
  const entry: HeldRole = { role, held: true };
  let run: Promise<T>;
  try { run = heldRoles.run([...holding, entry], operation); }
  catch (error) { entry.held = false; return Promise.reject(error); }
  return run.finally(() => { entry.held = false; });
}

const leaseDirectory = (home: string): string => join(realpathSync(home), '.access');

function requirePrivateDirectory(path: string, kind = 'admission'): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DataAccessError(`Invalid ${kind} directory ${path}.`);
}

/** Whether another vonvon command holds a data lease. secrets get never does: sandboxed readers cannot use
 * admission sockets or writes and read the keystore lock-free. Moving or deleting the data root, or replacing
 * master.key, must exclude keystore readers by another protocol rather than relying on this check. */
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

/** Held for the lifetime of CLI commands not let through by cli/index.ts; secrets get is let through. */
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
