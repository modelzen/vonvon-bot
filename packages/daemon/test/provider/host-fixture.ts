import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { readStartToken } from '../../src/provider/process/identity';
import { readLedger, type HolderIdentity, type HostPlatform } from '../../src/provider/process/ledger';
import { ProcessHost, Reservation } from '../../src/provider/process/process-host';
import { alive } from './channel-recorder';
import { compileHolder, type HolderBinary } from './native/holder-driver';

export const PLATFORM: HostPlatform = process.platform === 'win32' ? 'win32' : 'posix';
const POSIX = PLATFORM === 'posix';
/** How long a holder may outlive `closeAll` before the hook kills it and fails the test. */
const EXIT_WAIT_MS = POSIX ? 5_000 : 15_000;
const KILL_WAIT_MS = 3_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const killQuietly = (pid: number) => { try { process.kill(POSIX ? -pid : pid, 'SIGKILL'); } catch { /* exited meanwhile */ } };

export interface HostFixture {
  readonly hosts: readonly ProcessHost[];
  /** Provider process groups the tests observed. Killed best-effort after `closeAll`; the holders are what the hook awaits. */
  readonly groups: number[];
  dataDir(): string;
  newHost(options?: { dir?: string; spawnDeadlineMs?: number }): ProcessHost;
  dirOf(host: ProcessHost): string;
  holderPath(): string | undefined;
}

/**
 * Hosts, their data dirs, and every holder they reserved, with the hooks that compile the holder and clean up.
 * Holders are recorded where they are born: `reserve` is wrapped on each host (`spawn` goes through it too), so
 * a reserve that resolves is always seen, even when `spawn` then rejects or the test retires the record itself.
 * A reserve that rejects after its holder spawned (closeAll racing setup, a born write that fails) is abandoned
 * by the host and not recorded here; the holder exits on `abandon`.
 */
export function hostFixture(prefix: string): HostFixture {
  let binary: HolderBinary | undefined;
  const hosts: ProcessHost[] = [];
  const dirs: string[] = [];
  const dirOf = new Map<ProcessHost, string>();
  const holders: HolderIdentity[] = [];
  const groups: number[] = [];

  beforeAll(() => { if (POSIX) binary = compileHolder(); });
  afterAll(() => binary?.dispose());
  afterEach(cleanUp);

  function dataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function newHost(options: { dir?: string; spawnDeadlineMs?: number } = {}): ProcessHost {
    const dir = options.dir ?? dataDir();
    const host = new ProcessHost({
      dataDir: dir, daemonBootId: randomUUID(), ...(options.spawnDeadlineMs === undefined ? {} : { spawnDeadlineMs: options.spawnDeadlineMs }),
      ...(binary ? { platform: 'posix', holderPath: binary.path } : { platform: 'win32' }),
    });
    const reserve = host.reserve.bind(host);
    host.reserve = async (providerId, sessionId) => {
      const reservation = await reserve(providerId, sessionId);
      if (reservation instanceof Reservation) record(host, dir, reservation.id);
      return reservation;
    };
    hosts.push(host);
    dirOf.set(host, dir);
    return host;
  }

  /** The pid and start token the host wrote at `born`; the same pair the product checks in recovery. */
  function record(host: ProcessHost, dir: string, id: string): void {
    const read = readLedger(join(dir, 'process-owners.json'));
    const stored = read.kind === 'ok' ? read.records.find(r => r.id === id) : undefined;
    const identity = stored && 'holder' in stored ? stored.holder : { pid: host.snapshot().find(s => s.id === id)?.holderPid ?? 0 };
    if (identity.pid > 0) holders.push(identity);
  }

  async function cleanUp(): Promise<void> {
    const failures: unknown[] = [];
    try {
      try { await Promise.all(hosts.splice(0).map(host => host.closeAll())); }
      catch (error) { failures.push(error); }
      for (const pid of groups.splice(0)) killQuietly(pid);
      const leaked = await survivors(holders.splice(0), EXIT_WAIT_MS);
      if (leaked.length > 0) {
        for (const holder of leaked) killQuietly(holder.pid);
        const immortal = await survivors(leaked, KILL_WAIT_MS);
        failures.push(new Error(`holders ${pids(leaked)} outlived closeAll by ${EXIT_WAIT_MS} ms and were killed by the fixture${immortal.length > 0 ? `; ${pids(immortal)} survived SIGKILL` : ''}`));
      }
    } finally {
      for (const dir of dirs.splice(0)) {
        try { rmSync(dir, { recursive: true, force: true }); }
        catch (error) { failures.push(error); }
      }
      dirOf.clear();
    }
    if (failures.length > 0) throw failures[0];
  }

  return { hosts, groups, dataDir, newHost, dirOf: host => dirOf.get(host) ?? '', holderPath: () => binary?.path };
}

const pids = (holders: HolderIdentity[]): string => holders.map(holder => holder.pid).join(', ');

/** A pid now carrying another start token was reused, so the recorded holder is gone. Read once: a token read can exec. */
async function reused(holder: HolderIdentity): Promise<boolean> {
  if (holder.start === undefined) return false;
  const read = await readStartToken(holder.pid);
  return read === 'absent' || (read !== 'unreadable' && read !== holder.start);
}

/** The holders still present at the shared deadline. */
async function survivors(candidates: HolderIdentity[], timeoutMs: number): Promise<HolderIdentity[]> {
  const deadline = Date.now() + timeoutMs;
  const left = await Promise.all(candidates.map(async holder => {
    if (!alive(holder.pid) || await reused(holder)) return undefined;
    while (alive(holder.pid)) {
      if (Date.now() > deadline) return holder;
      await sleep(20);
    }
    return undefined;
  }));
  return left.filter((holder): holder is HolderIdentity => holder !== undefined);
}
