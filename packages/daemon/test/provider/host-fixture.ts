import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { readStartToken, type StartRead } from '../../src/provider/process/identity';
import { readLedger, type HolderIdentity, type HostPlatform } from '../../src/provider/process/ledger';
import { ProcessHost, Reservation } from '../../src/provider/process/process-host';
import { alive } from './channel-recorder';
import { compileHolder, type HolderBinary } from './native/holder-driver';

export const PLATFORM: HostPlatform = process.platform === 'win32' ? 'win32' : 'posix';
const POSIX = PLATFORM === 'posix';
/** How long a holder may outlive `closeAll` before the hook kills it and fails the test. */
const EXIT_WAIT_MS = POSIX ? 5_000 : 15_000;
const KILL_WAIT_MS = 3_000;
const IDENTITY_WAIT_MS = 1_000;
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
        const outcomes = await Promise.all(leaked.map(forceHolder));
        const attempted = outcomes.flatMap(outcome => outcome.kind === 'attempted' ? [outcome.holder] : []);
        const unverified = outcomes.flatMap(outcome => outcome.kind === 'unverified' ? [outcome.holder] : []);
        const immortal = await survivors(attempted, KILL_WAIT_MS);
        if (attempted.length > 0 || unverified.length > 0) {
          failures.push(new Error(`holders ${pids([...attempted, ...unverified])} outlived closeAll by ${EXIT_WAIT_MS} ms${attempted.length > 0 ? `; fixture attempted SIGKILL on ${pids(attempted)}` : ''}${unverified.length > 0 ? `; identity unverified for ${pids(unverified)}, not signalled` : ''}${immortal.length > 0 ? `; ${pids(immortal)} still present after SIGKILL` : ''}`));
        }
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

type ForceOutcome =
  | { kind: 'gone' }
  | { kind: 'attempted'; holder: HolderIdentity }
  | { kind: 'unverified'; holder: HolderIdentity };

async function readStartWithin(pid: number, deadline: number): Promise<StartRead> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return 'unreadable';
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      readStartToken(pid),
      new Promise<StartRead>(resolve => { timer = setTimeout(resolve, remaining, 'unreadable'); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function forceHolder(holder: HolderIdentity): Promise<ForceOutcome> {
  if (!alive(holder.pid)) return { kind: 'gone' };
  if (holder.start === undefined) return { kind: 'unverified', holder };
  const read = await readStartWithin(holder.pid, Date.now() + IDENTITY_WAIT_MS);
  if (read === 'unreadable') return { kind: 'unverified', holder };
  if (read !== holder.start) return { kind: 'gone' };
  killQuietly(holder.pid);
  return { kind: 'attempted', holder };
}

async function reused(holder: HolderIdentity, deadline: number): Promise<boolean> {
  if (holder.start === undefined) return false;
  const read = await readStartWithin(holder.pid, deadline);
  return read === 'absent' || (read !== 'unreadable' && read !== holder.start);
}

/** The holders still present at the shared deadline. */
async function survivors(candidates: HolderIdentity[], timeoutMs: number): Promise<HolderIdentity[]> {
  const deadline = Date.now() + timeoutMs;
  const left = await Promise.all(candidates.map(async holder => {
    if (!alive(holder.pid) || await reused(holder, deadline)) return undefined;
    while (alive(holder.pid)) {
      if (Date.now() > deadline) return holder;
      await sleep(20);
    }
    return undefined;
  }));
  return left.filter((holder): holder is HolderIdentity => holder !== undefined);
}
