import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProcessFact } from '../../src/provider/engines/engine';
import { readStartToken } from '../../src/provider/process/identity';
import { readLedger, type HostPlatform } from '../../src/provider/process/ledger';
import { probeWindowsJob } from '../../src/provider/process/windows-job-probe';
import { nextStep, ProcessHost, Reservation, type HostedProcess, type Identity, type Phase, type Step } from '../../src/provider/process/process-host';
import { alive, until } from './channel-recorder';
import { compileHolder, type HolderBinary } from './native/holder-driver';

const NODE = process.execPath;
const FAKE = fileURLToPath(new URL('./fixtures/fake-child.mjs', import.meta.url));
const HOST_DAEMON = fileURLToPath(new URL('./fixtures/host-daemon.ts', import.meta.url));
const PLATFORM: HostPlatform = process.platform === 'win32' ? 'win32' : 'posix';
const groupEmpty = (pid: number): boolean => { try { process.kill(-pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };

let binary: HolderBinary | undefined;
const hosts: ProcessHost[] = [];
const dirs: string[] = [];
const groups: number[] = [];

beforeAll(() => { if (PLATFORM === 'posix') binary = compileHolder(); });
afterAll(() => binary?.dispose());
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.closeAll()));
  for (const pid of groups.splice(0)) { try { process.kill(PLATFORM === 'posix' ? -pid : pid, 'SIGKILL'); } catch { } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vonvon-process-host-'));
  dirs.push(dir);
  return dir;
}
function newHost(dir: string, spawnDeadlineMs = 20_000): ProcessHost {
  const host = new ProcessHost({ dataDir: dir, daemonBootId: randomUUID(), spawnDeadlineMs, ...(binary ? { platform: 'posix', holderPath: binary.path } : { platform: 'win32' }) });
  hosts.push(host);
  return host;
}
const ledgerOf = (dir: string) => readLedger(join(dir, 'process-owners.json'));
/** The provider's environment: the whole string environment, as the Windows supervisor tests pass it. node.exe needs more than PATH. */
const ENV = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

/** Everything a failed real-process case must show: provider stdio and exit facts, the supervisor log, and the ledger. */
function evidence(dir: string, host: ProcessHost, text: string, errors: string, facts: ProcessFact[]): string {
  const logs = existsSync(join(dir, 'holder-logs')) ? readdirSync(join(dir, 'holder-logs')).map(name => `${name}: ${readFileSync(join(dir, 'holder-logs', name), 'utf8')}`) : [];
  const ledger = existsSync(join(dir, 'process-owners.json')) ? readFileSync(join(dir, 'process-owners.json'), 'utf8') : 'absent';
  return JSON.stringify({ stdout: text, stderr: errors, facts, snapshot: host.snapshot(), ledger, holderLogs: logs }, null, 1);
}

async function spawnFake(host: ProcessHost, args: string[], dir?: string): Promise<{ hosted: HostedProcess; pid: number; grandchildren: number[]; facts: ProcessFact[] }> {
  const hosted = await host.spawn('codex', 'session-1', { file: NODE, args: [FAKE, ...args], env: ENV });
  const facts: ProcessFact[] = [];
  hosted.watch(fact => facts.push(fact));
  let text = '';
  let errors = '';
  hosted.stdout.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  hosted.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
  try { await until(() => text.includes('armed\n'), 'fake child armed'); }
  catch (error) { throw new Error(`${(error as Error).message}; evidence ${evidence(dir ?? '', host, text, errors, facts)}`); }
  const pid = Number(/pid (\d+)/.exec(text)?.[1]);
  groups.push(pid);
  const grandchildren = [...text.matchAll(/gc (\d+)/g)].map(match => Number(match[1]));
  return { hosted, pid, grandchildren, facts };
}

describe('nextStep', () => {
  const rows: Array<[Identity, Phase, Step]> = [
    ['retained', 'signalling', { send: 'kill' }],
    ['retained', 'receipted', { wait: true }],
    ['retained', 'reapable', { send: 'reap' }],
    ['retained', 'reaped', { send: 'probe' }],
    ['retained', 'probed', { done: 'gone' }],
    ['reaped', 'signalling', { send: 'probe' }],
    ['reaped', 'reapable', { send: 'probe' }],
    ['reaped', 'reaped', { send: 'probe' }],
    ['reaped', 'probed', { done: 'gone' }],
    ['lost', 'signalling', { probe: 'daemon' }],
    ['lost', 'reaped', { probe: 'daemon' }],
    ['lost', 'probed', { done: 'gone' }],
  ];
  it.each(rows)('%s + %s -> %j', (identity, phase, step) => {
    expect(nextStep({ identity, phase })).toEqual(step);
  });
  it('never signals once the identity is reaped or lost', () => {
    for (const identity of ['reaped', 'lost'] as const) {
      for (const phase of ['signalling', 'receipted', 'reapable', 'reaped', 'probed'] as const) {
        const step = nextStep({ identity, phase });
        expect('send' in step && (step.send === 'kill' || step.send === 'reap')).toBe(false);
      }
    }
  });
});

describe.skipIf(PLATFORM !== 'posix')('ProcessHost on POSIX', () => {
  it('spawn writes process-owners.json at stage running before it resolves, and end retires the record', async () => {
    const dir = dataDir();
    const host = newHost(dir);
    expect(host.available()).toBe(true);
    const { hosted, pid } = await spawnFake(host, []);
    const holderPid = host.snapshot()[0]?.holderPid as number;
    const read = ledgerOf(dir);
    expect(read.kind).toBe('ok');
    const record = read.kind === 'ok' ? read.records[0] : undefined;
    expect(record?.stage).toBe('running');
    expect(record && 'provider' in record ? record.provider.pid : undefined).toBe(pid);
    expect(record?.sessionId).toBe('session-1');
    expect(host.owesWork()).toBe(true);
    await hosted.end();
    expect(ledgerOf(dir).kind).toBe('missing');
    expect(host.snapshot()).toEqual([]);
    expect(host.owesWork()).toBe(false);
    expect(alive(pid)).toBe(false);
    await until(() => !alive(holderPid), 'holder exit after the exit command');
  }, 30_000);

  it('admit() waits out an end already in flight: a message right after a stop is admitted where admission() refuses', async () => {
    const host = newHost(dataDir());
    const { hosted } = await spawnFake(host, []);
    const ended = hosted.end();
    while (host.snapshot()[0]?.ownership !== 'unknown') {
      if (host.snapshot().length === 0) throw new Error('record retired before its reaped window was observed');
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(host.admission()).toMatchObject({ reason: 'owned-work-unverified' });
    expect(await host.admit()).toBeUndefined();
    expect(host.snapshot()).toEqual([]);
    await ended;
  }, 30_000);

  it('terminateTree on a TERM-ignoring tree returns sent, then killTree removes every pid in the group and watch() reports the exit without transport-lost', async () => {
    const host = newHost(dataDir());
    const { hosted, pid, grandchildren, facts } = await spawnFake(host, ['--ignore-term', '--grandchildren', '1']);
    expect(grandchildren).toHaveLength(1);
    expect(await hosted.term()).toBe('sent');
    expect(alive(pid)).toBe(true);
    expect(await hosted.kill()).toBe('sent');
    await until(() => host.snapshot().length === 0, 'record gone after kill');
    expect(alive(pid)).toBe(false);
    expect(alive(grandchildren[0] as number)).toBe(false);
    expect(groupEmpty(pid)).toBe(true);
    expect(facts).toEqual([{ kind: 'exit', exit: { observed: 'parent', code: null, signal: 'SIGKILL' } }]);
  }, 30_000);

  it('end() on a TERM-honouring child waits out TERM_WAIT_MS: the exit is the child\'s own, not a kill', async () => {
    const host = newHost(dataDir());
    const { hosted, pid, facts } = await spawnFake(host, ['--term-exit-ms', '300']);
    await hosted.end();
    expect(facts).toEqual([{ kind: 'exit', exit: { observed: 'parent', code: 0, signal: null } }]);
    expect(alive(pid)).toBe(false);
    expect(host.snapshot()).toEqual([]);
  }, 30_000);

  it('spawn() ends the record itself when ready misses the spawn deadline, so nothing stays bound without a handle', async () => {
    const dir = dataDir();
    const deadlineMs = 20_000;
    const host = newHost(dir, deadlineMs);
    const reservation = await host.reserve('codex');
    const holderPid = host.snapshot()[0]?.holderPid;
    const reserve = vi.spyOn(host, 'reserve').mockResolvedValueOnce(reservation);
    let rejected: Promise<void>;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      rejected = expect(host.spawn('codex', undefined, { file: NODE, args: [FAKE, '--ignore-term'], env: ENV })).rejects.toThrow('holder-not-ready');
      await Promise.resolve();
      expect(host.snapshot()[0]?.stage).toBe('attempting');
      vi.advanceTimersByTime(deadlineMs);
    } finally {
      vi.useRealTimers();
      reserve.mockRestore();
    }
    await rejected;
    expect(host.snapshot()).toEqual([]);
    expect(ledgerOf(dir).kind).toBe('missing');
    expect(host.owesWork()).toBe(false);
    await until(() => holderPid !== undefined && !alive(holderPid), 'timed-out holder exit');
  }, 30_000);

  it('watch() reports transport-lost after the hold when stdout closes with no exit, and the exit still follows', async () => {
    const host = newHost(dataDir());
    const { hosted, facts } = await spawnFake(host, ['--ignore-term', '--close-stdout-ms', '100']);
    await until(() => facts.length > 0, 'transport-lost', 5000);
    expect(facts).toEqual([{ kind: 'transport-lost' }]);
    await hosted.end();
    expect(facts).toEqual([{ kind: 'transport-lost' }, { kind: 'exit', exit: { observed: 'parent', code: null, signal: 'SIGKILL' } }]);
  }, 30_000);

  it('after the daemon is killed -9, the holder ends the tree itself and the next host sweeps the record as gone: 1', async () => {
    const dir = dataDir();
    const bundle = join(dir, 'host-daemon.mjs');
    await build({ entryPoints: [HOST_DAEMON], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
    const daemon: ChildProcess = spawn(NODE, [bundle], { env: { ...process.env, DATA_DIR: dir, HOLDER: binary?.path as string, FAKE }, stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    daemon.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString(); });
    await until(() => text.includes('\n'), 'first daemon hosting a tree', 20_000);
    const { pid, grandchildren, holderPid } = JSON.parse(text) as { pid: number; grandchildren: number[]; holderPid: number };
    groups.push(pid);
    daemon.kill('SIGKILL');
    await until(() => !alive(holderPid), 'holder exit after daemon death', 20_000);
    expect(ledgerOf(dir).kind).toBe('ok');
    const second = newHost(dir);
    expect(second.snapshot()[0]?.ownership).toBe('unknown');
    expect(await second.sweepOrphans()).toEqual({ gone: 1, unknown: 0, inert: 0, legacy: 0 });
    expect(ledgerOf(dir).kind).toBe('missing');
    expect(groupEmpty(pid)).toBe(true);
    expect(alive(grandchildren[0] as number)).toBe(false);
  }, 40_000);

  it('a record whose holder pid carries another start token is sealed but stays unknown until its probe is empty', async () => {
    const dir = dataDir();
    const leader = spawn(NODE, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const standIn = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    groups.push(leader.pid as number, standIn.pid as number);
    await new Promise(resolve => setTimeout(resolve, 100));
    const record = { id: randomUUID(), daemonBootId: 'earlier-boot', providerId: 'codex', stage: 'running', holder: { pid: standIn.pid, start: 'linux:deadbeef:1' }, provider: { pid: leader.pid } };
    writeFileSync(join(dir, 'process-owners.json'), JSON.stringify({ version: 1, records: [record] }));
    const host = newHost(dir);
    expect(await host.sweepOrphans()).toEqual({ gone: 0, unknown: 1, inert: 0, legacy: 0 });
    const asked = Date.now();
    expect(await host.admit()).toMatchObject({ reason: 'owned-work-unverified' });
    expect(Date.now() - asked).toBeLessThan(200);
    const refusal = await host.reserve('codex');
    expect(refusal).toMatchObject({ reason: 'owned-work-unverified' });
    expect(ledgerOf(dir)).toMatchObject({ kind: 'ok', records: [{ id: record.id }] });
    process.kill(-(leader.pid as number), 'SIGKILL');
    await until(() => groupEmpty(leader.pid as number), 'leader group empty');
    expect(await host.sweepOrphans()).toEqual({ gone: 1, unknown: 0, inert: 0, legacy: 0 });
    const reservation = await host.reserve('codex');
    expect(reservation).toBeInstanceOf(Reservation);
    await (reservation as Reservation).release();
    standIn.kill('SIGKILL');
  }, 30_000);

  it('a holder killed first leaves an unknown record that refuses admission until its members die, then a sweep retires it', async () => {
    const dir = dataDir();
    const host = newHost(dir);
    const { pid, grandchildren } = await spawnFake(host, ['--ignore-term', '--grandchildren', '1']);
    process.kill(host.snapshot()[0]?.holderPid as number, 'SIGKILL');
    await until(() => host.snapshot()[0]?.ownership === 'unknown', 'record unknown after the holder died');
    const asked = Date.now();
    expect(await host.admit()).toMatchObject({ reason: 'owned-work-unverified' });
    expect(Date.now() - asked).toBeLessThan(200);
    expect(await host.reserve('codex')).toMatchObject({ reason: 'owned-work-unverified' });
    expect(alive(pid)).toBe(true);
    expect(host.owesWork()).toBe(true);
    process.kill(-pid, 'SIGKILL');
    await until(() => groupEmpty(pid) && !alive(grandchildren[0] as number), 'members gone');
    expect(await host.sweepOrphans()).toEqual({ gone: 1, unknown: 0, inert: 0, legacy: 0 });
    expect(ledgerOf(dir).kind).toBe('missing');
    const reservation = await host.reserve('codex');
    expect(reservation).toBeInstanceOf(Reservation);
    await (reservation as Reservation).release();
  }, 30_000);

  it('an unreadable ledger refuses admission and is never rewritten', async () => {
    const dir = dataDir();
    const path = join(dir, 'process-owners.json');
    writeFileSync(path, '{"version":1,"records":[{"stage":"nonsense"}]}');
    const before = readFileSync(path);
    const host = newHost(dir);
    expect(await host.reserve('codex')).toMatchObject({ reason: 'owned-work-unverified' });
    expect(await host.sweepOrphans()).toEqual({ gone: 0, unknown: 0, inert: 0, legacy: 0 });
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('lists legacy owned-pids.json records until the host boot time passes their start, then removes them', async () => {
    const dir = dataDir();
    const path = join(dir, 'owned-pids.json');
    const base = { daemonBootId: 'old', providerId: 'codex', sessionId: 's' };
    writeFileSync(path, JSON.stringify([{ pid: 1, startedAtMs: Date.now() + 3_600_000, ...base }, { pid: 2, startedAtMs: 1, ...base }]));
    expect(await newHost(dir).sweepOrphans()).toMatchObject({ legacy: 1 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject([{ pid: 1 }]);
    writeFileSync(path, JSON.stringify([{ pid: 2, startedAtMs: 1, ...base }]));
    expect(await newHost(dir).sweepOrphans()).toMatchObject({ legacy: 0 });
    expect(existsSync(path)).toBe(false);
  });

  it('closeAll releases an unused reservation: the holder exits and the born record is retired', async () => {
    const dir = dataDir();
    const host = newHost(dir);
    const reservation = await host.reserve('codex');
    expect(reservation).toBeInstanceOf(Reservation);
    expect(ledgerOf(dir)).toMatchObject({ kind: 'ok', records: [{ stage: 'born' }] });
    const holderPid = host.snapshot()[0]?.holderPid as number;
    expect(host.owesWork()).toBe(false);
    await host.closeAll();
    expect(alive(holderPid)).toBe(false);
    expect(ledgerOf(dir).kind).toBe('missing');
    expect(host.snapshot()).toEqual([]);
    expect(() => (reservation as Reservation).spawn({ file: NODE, args: [], env: {} })).toThrow(/not an unused reservation/);
  }, 20_000);

  it('release() then spawn() is refused: the reservation is single-use', async () => {
    const host = newHost(dataDir());
    const reservation = await host.reserve('codex') as Reservation;
    const released = reservation.release();
    expect(() => reservation.spawn({ file: NODE, args: [], env: {} })).toThrow(/not an unused reservation/);
    await released;
  }, 20_000);
});

describe.skipIf(PLATFORM !== 'posix')('ProcessHost durability on POSIX', () => {
  /** A directory at the ledger's temporary path makes the next write-and-rename fail with EISDIR, as in Codex's reproduction. */
  const obstruct = (dir: string) => { const path = join(dir, `process-owners.json.${process.pid}.tmp`); mkdirSync(path); return () => rmSync(path, { recursive: true }); };
  const everyPid = (): number[] => hosts.flatMap(host => host.snapshot().flatMap(s => [s.holderPid, s.providerPid].filter((pid): pid is number => pid !== undefined)));

  it('a born write that fails abandons the holder and rejects: no authority survives', async () => {
    const dir = dataDir();
    const host = newHost(dir);
    const reserving = host.reserve('codex');
    const clear = obstruct(dir);
    await expect(reserving).rejects.toThrow(/EISDIR/);
    expect(host.snapshot()).toEqual([]);
    expect(everyPid()).toEqual([]);
    clear();
    expect(ledgerOf(dir).kind).toBe('missing');
    const fresh = newHost(dir);
    expect(await fresh.sweepOrphans()).toEqual({ gone: 0, unknown: 0, inert: 0, legacy: 0 });
    expect(fresh.admission()).toBeUndefined();
  }, 30_000);

  it('an attempting write that fails sends no launch: ready rejects, the holder exits, and nothing executed', async () => {
    const dir = dataDir();
    const host = newHost(dir);
    const reservation = await host.reserve('codex') as Reservation;
    const holderPid = host.snapshot()[0]?.holderPid as number;
    const clear = obstruct(dir);
    const hosted = reservation.spawn({ file: NODE, args: [FAKE], env: ENV });
    let output = '';
    hosted.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await expect(hosted.ready).rejects.toThrow(/EISDIR/);
    await until(() => !alive(holderPid), 'holder exit after abandon');
    expect(output).toBe('');
    expect(host.snapshot()).toEqual([]);
    clear();
    expect(ledgerOf(dir).kind).toBe('missing');
    expect(await newHost(dir).sweepOrphans()).toEqual({ gone: 0, unknown: 0, inert: 0, legacy: 0 });
  }, 30_000);

  it('a launched write that fails sends no GO: the child cancels, ready rejects cancelled, and nothing executed', async () => {
    const dir = dataDir();
    const host = newHost(dir);
    const reservation = await host.reserve('codex') as Reservation;
    const holderPid = host.snapshot()[0]?.holderPid as number;
    const hosted = reservation.spawn({ file: NODE, args: [FAKE], env: ENV });
    const clear = obstruct(dir);
    let output = '';
    hosted.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await expect(hosted.ready).rejects.toThrow(/cancelled|launch-failed/);
    await until(() => !alive(holderPid), 'holder exit after cancel');
    expect(output).toBe('');
    expect(everyPid()).toEqual([]);
    clear();
    expect(ledgerOf(dir).kind).toBe('missing');
    expect(await newHost(dir).sweepOrphans()).toEqual({ gone: 0, unknown: 0, inert: 0, legacy: 0 });
  }, 30_000);

  it('closeAll during an in-flight reserve ends that holder: the reserve rejects and nothing stays alive', async () => {
    const dir = dataDir();
    const host = newHost(dir);
    const reserving = host.reserve('codex');
    await host.closeAll();
    await expect(reserving).rejects.toThrow(/closing/);
    expect(host.snapshot()).toEqual([]);
    expect(ledgerOf(dir).kind).toBe('missing');
    await expect(host.reserve('codex')).rejects.toThrow(/closing/);
  }, 30_000);
});

describe.skipIf(PLATFORM !== 'win32')('ProcessHost on Windows', () => {
  /** Runs node.exe directly with the given environment and reports what happened; the evidence for the PATH-only suspicion. */
  const runNode = (env: Record<string, string>) => new Promise<string>(resolve => {
    execFile(NODE, ['-e', 'process.stdout.write("ok")'], { env, timeout: 15_000, windowsHide: true }, (error, stdout, stderr) =>
      resolve(JSON.stringify({ code: error ? error.code : 0, stdout, stderr: stderr.trim(), keys: Object.keys(env) })));
  });

  it('reports whether node.exe starts with a PATH-only environment, and starts with the whole one', async () => {
    const pathOnly = await runNode({ PATH: process.env.PATH ?? '' });
    const whole = await runNode(ENV);
    console.log(`[process-host evidence] node.exe with PATH only: ${pathOnly}`);
    console.log(`[process-host evidence] node.exe with the whole environment: ${whole}`);
    expect(JSON.parse(whole)).toMatchObject({ code: 0, stdout: 'ok' });
  }, 60_000);

  it('spawns through the supervisor, records running with the Job name, and kill retires the record', async () => {
    const dir = dataDir();
    const host = newHost(dir);
    expect(host.available()).toBe(true);
    const { hosted, pid, facts } = await spawnFake(host, [], dir);
    const holderPid = host.snapshot()[0]?.holderPid;
    expect(ledgerOf(dir)).toMatchObject({ kind: 'ok', records: [{ stage: 'running', provider: { pid }, control: { jobName: expect.stringMatching(/^Local\\vonvon-/) } }] });
    expect(await hosted.term()).toBe('accepted');
    expect(await hosted.kill()).toBe('sent');
    await until(() => host.snapshot().length === 0, 'record gone after kill', 20_000);
    expect(alive(pid)).toBe(false);
    expect(facts[0]).toMatchObject({ kind: 'exit', exit: { observed: 'parent' } });
    await until(() => holderPid !== undefined && !alive(holderPid), 'supervisor exit after kill');
  }, 120_000);

  it('recovers an attempting record from an earlier boot through its Job name and session: a sealed supervisor with no Job is gone', async () => {
    const dir = dataDir();
    const session = await new Promise<number>((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-Command', '[Diagnostics.Process]::GetCurrentProcess().SessionId'], (error, stdout) => error ? reject(error) : resolve(Number(stdout.trim()))));
    const dead = spawn(NODE, ['-e', '0'], { stdio: 'ignore' });
    await new Promise(resolve => dead.once('exit', resolve));
    const id = randomUUID();
    const record = { id, daemonBootId: 'earlier-boot', providerId: 'codex', stage: 'attempting', holder: { pid: dead.pid, start: 'win32:1' }, control: { pipe: `\\\\.\\pipe\\vonvon-${id}`, jobName: `Local\\vonvon-${id}`, osSession: session } };
    writeFileSync(join(dir, 'process-owners.json'), JSON.stringify({ version: 1, records: [record] }));
    const read = await readStartToken(dead.pid as number);
    const probe = await probeWindowsJob({ ...record.control, osSession: session });
    console.log(`[process-host evidence] session ${session}; dead holder ${dead.pid} reads ${JSON.stringify(read)}; probe ${JSON.stringify(probe)}`);
    expect(read, 'a dead pid must read absent for the holder to be sealed').toBe('absent');
    expect(probe, 'OpenJobObjectW on a name nobody holds must fail with ERROR_FILE_NOT_FOUND').toMatchObject({ probe: 'empty', lastError: 2 });
    const host = newHost(dir);
    expect(host.snapshot()[0]?.ownership).toBe('unknown');
    expect(await host.sweepOrphans()).toEqual({ gone: 1, unknown: 0, inert: 0, legacy: 0 });
    expect(ledgerOf(dir).kind).toBe('missing');
  }, 120_000);
});
