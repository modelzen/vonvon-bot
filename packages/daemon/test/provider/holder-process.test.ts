import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { TERM_WAIT_MS } from '../../src/provider/engines/engine';
import { HolderProcessError, specOf, type HolderProcess } from '../../src/provider/process/holder-process';
import type { HostPlatform } from '../../src/provider/process/ledger';
import { ProcessHost, Reservation } from '../../src/provider/process/process-host';
import { alive, until } from './channel-recorder';
import { compileHolder, type HolderBinary } from './native/holder-driver';

const NODE = process.execPath;
const FAKE = fileURLToPath(new URL('./fixtures/fake-child.mjs', import.meta.url));
const PLATFORM: HostPlatform = process.platform === 'win32' ? 'win32' : 'posix';
const POSIX = PLATFORM === 'posix';
/** The whole string environment: node.exe under the Windows supervisor needs more than PATH. */
const ENV = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
/** TerminateJobObject exits with 1 and no signal; POSIX kill is SIGKILL to the group. */
const KILLED: [number | null, string | null] = POSIX ? [null, 'SIGKILL'] : [1, null];
const groupEmpty = (pid: number): boolean => { try { process.kill(-pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const WAIT = POSIX ? 10_000 : 30_000;
const LIMIT = POSIX ? 30_000 : 120_000;

let binary: HolderBinary | undefined;
const hosts: ProcessHost[] = [];
const dirOf = new Map<ProcessHost, string>();
const groups: number[] = [];

beforeAll(() => { if (POSIX) binary = compileHolder(); });
afterAll(() => binary?.dispose());
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.closeAll()));
  for (const pid of groups.splice(0)) { try { process.kill(POSIX ? -pid : pid, 'SIGKILL'); } catch { } }
  for (const dir of dirOf.values()) rmSync(dir, { recursive: true, force: true });
  dirOf.clear();
});

function newHost(spawnDeadlineMs = 20_000): ProcessHost {
  const dir = mkdtempSync(join(tmpdir(), 'vonvon-holder-process-'));
  const host = new ProcessHost({ dataDir: dir, daemonBootId: randomUUID(), spawnDeadlineMs, ...(binary ? { platform: 'posix', holderPath: binary.path } : { platform: 'win32' }) });
  hosts.push(host);
  dirOf.set(host, dir);
  return host;
}

type Seen = { exits: Array<[number | null, string | null]>; errors: HolderProcessError[]; order: string[] };

/** What a failed real-process case prints: provider output, facade events, the records, the ledger, and the holder or supervisor logs. */
function evidence(host: ProcessHost, stdout: string, seen: Seen): string {
  const dir = dirOf.get(host) ?? '';
  const logDir = join(dir, 'holder-logs');
  const logs = existsSync(logDir) ? readdirSync(logDir).map(name => `${name}: ${readFileSync(join(logDir, name), 'utf8')}`) : [];
  const ledger = existsSync(join(dir, 'process-owners.json')) ? readFileSync(join(dir, 'process-owners.json'), 'utf8') : 'absent';
  return JSON.stringify({ platform: PLATFORM, stdout, seen: { ...seen, errors: seen.errors.map(error => error.code) }, snapshot: host.snapshot(), ledger, holderLogs: logs }, null, 1);
}

/** Attaches `exit` and `error` at once, as the SDK's ProcessTransport does. */
async function adoptFake(host: ProcessHost, args: string[], options: { signal?: AbortSignal; command?: string; listen?: boolean; armed?: boolean; onStderr?: (chunk: string) => void } = {}) {
  const reservation = await host.reserve('claude', 'session-1');
  if (!(reservation instanceof Reservation)) throw new Error('reservation refused');
  const proc: HolderProcess = reservation.adopt({
    command: options.command ?? NODE, args: [FAKE, ...args],
    env: { ...ENV, VONVON_UNSET: undefined }, signal: options.signal ?? new AbortController().signal,
  }, { onStderr: options.onStderr });
  const seen: Seen = { exits: [], errors: [], order: [] };
  if (options.listen !== false) {
    proc.on('exit', (code: number | null, signal: string | null) => { seen.exits.push([code, signal]); seen.order.push('exit'); });
    proc.on('error', (error: HolderProcessError) => { seen.errors.push(error); seen.order.push(error.code); });
  }
  let text = '';
  proc.stdout.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  onTestFailed(() => { console.log(`[holder-process evidence] ${evidence(host, text, seen)}`); });
  let pid = 0;
  if (options.armed !== false) {
    await until(() => text.includes('armed\n'), 'fake child armed', WAIT);
    pid = Number(/pid (\d+)/.exec(text)?.[1]);
    groups.push(pid);
  }
  return { proc, seen, pid, text: () => text };
}

describe('specOf', () => {
  it('drops env entries the SDK left undefined', () => {
    expect(specOf({ command: 'claude', args: ['-p'], cwd: '/w', env: { A: '1', B: undefined }, signal: new AbortController().signal }))
      .toEqual({ file: 'claude', args: ['-p'], cwd: '/w', env: { A: '1' } });
  });
});

describe('HolderProcess on both platforms', () => {
  it('SDK close on a child that exits at stdin EOF: exit fires once with its code, survivors are ended, and the delayed SIGTERM and SIGKILL do nothing, even with a replacement running', async () => {
    const host = newHost();
    const { proc, seen, pid, text } = await adoptFake(host, ['--exit-on-eof', '--grandchildren', '1']);
    const grandchild = Number(/gc (\d+)/.exec(text())?.[1]);
    expect(proc.exitCode).toBeNull();
    expect(proc.killed).toBe(false);
    expect('pid' in proc).toBe(false);
    proc.stdin.end();
    await until(() => seen.exits.length === 1 && host.snapshot().length === 0, 'exit and settlement', WAIT);
    expect(seen.exits).toEqual([[0, null]]);
    expect(proc.exitCode).toBe(0);
    expect(proc.signalCode).toBeNull();
    expect(alive(pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    if (POSIX) expect(groupEmpty(pid)).toBe(true);

    const replacement = await adoptFake(host, ['--ignore-term']);
    expect(proc.kill('SIGTERM')).toBe(false);
    expect(proc.kill('SIGKILL')).toBe(false);
    expect(proc.killed).toBe(false);
    await sleep(300);
    expect(alive(replacement.pid)).toBe(true);
    expect(replacement.seen.exits).toEqual([]);
    expect(seen).toMatchObject({ exits: [[0, null]], errors: [] });
    expect(replacement.proc.kill('SIGKILL')).toBe(true);
    await until(() => replacement.seen.exits.length === 1 && host.snapshot().length === 0, 'replacement exit and settlement', WAIT);
    expect(replacement.seen.exits).toEqual([KILLED]);
  }, LIMIT);

  it('drains more stderr than a pipe holds, forwards every byte to onStderr, and keeps it out of stdout', async () => {
    const bytes = 2 * 1024 * 1024;
    const host = newHost();
    let received = 0;
    let foreign = 0;
    const { seen, text } = await adoptFake(host, ['--stderr-bytes', String(bytes)], { onStderr: chunk => { received += chunk.length; foreign += chunk.replaceAll('x', '').length; } });
    await until(() => seen.exits.length === 1 && host.snapshot().length === 0, 'DONE and exit after the stderr flood', WAIT);
    expect(text()).toMatch(/armed\nDONE\n$/);
    expect(seen.exits).toEqual([[0, null]]);
    await until(() => received === bytes, 'every stderr byte forwarded', WAIT);
    expect(foreign).toBe(0);
  }, LIMIT);

  it('drains stderr with no onStderr, so the provider still finishes', async () => {
    const host = newHost();
    const { seen, text } = await adoptFake(host, ['--stderr-bytes', String(2 * 1024 * 1024)]);
    await until(() => seen.exits.length === 1 && host.snapshot().length === 0, 'DONE and exit after the stderr flood', WAIT);
    expect(text()).toMatch(/DONE\n$/);
    expect(seen).toMatchObject({ exits: [[0, null]], errors: [] });
  }, LIMIT);

  it('aborting options.signal queues term and the record is cleaned up', async () => {
    const host = newHost();
    const controller = new AbortController();
    const { proc, seen } = await adoptFake(host, ['--term-exit-ms', '100'], { signal: controller.signal });
    controller.abort();
    expect(proc.killed).toBe(true);
    await until(() => seen.exits.length === 1 && host.snapshot().length === 0, 'exit after abort', WAIT);
    // POSIX: the child honours SIGTERM. Windows: term is accepted and does nothing, so the term wait ends in TerminateJobObject.
    expect(seen).toMatchObject({ exits: [POSIX ? [0, null] : KILLED], errors: [] });
  }, LIMIT);

  it('a signal already aborted at adopt never launches: the provider never executes and the facade raises cancelled', async () => {
    const host = newHost();
    const marker = join(dirOf.get(host) as string, 'provider-ran');
    const controller = new AbortController();
    controller.abort();
    const { proc, seen } = await adoptFake(host, ['--marker', marker], { signal: controller.signal, armed: false });
    await expect(proc.ready).rejects.toMatchObject({ code: 'cancelled' });
    await until(() => host.snapshot().length === 0, 'record retired', WAIT);
    await sleep(500);
    expect(existsSync(marker)).toBe(false);
    expect(seen).toMatchObject({ exits: [], errors: [{ code: 'cancelled' }] });
    expect(proc.killed).toBe(false);
    expect(proc.kill('SIGKILL')).toBe(false);
  }, LIMIT);

  it('a command that cannot start raises launch-failed and retires the record without an exit', async () => {
    const host = newHost();
    const { proc, seen } = await adoptFake(host, [], { command: join(tmpdir(), 'nonexistent', 'vonvon-claude'), armed: false });
    await expect(proc.ready).rejects.toMatchObject({ code: 'launch-failed' });
    await until(() => seen.errors.length === 1 && host.snapshot().length === 0, 'launch-failed settled', WAIT);
    expect(seen.errors.map(error => error.code)).toEqual(['launch-failed']);
    expect(seen.exits).toEqual([]);
    expect(proc.kill('SIGKILL')).toBe(false);
  }, LIMIT);

  it('adopt once closeAll has started throws instead of returning a process that never settles', async () => {
    const host = newHost();
    const reservation = await host.reserve('claude') as Reservation;
    const closing = host.closeAll();
    expect(() => reservation.adopt({ command: NODE, args: [FAKE], env: ENV, signal: new AbortController().signal })).toThrow(/process host is closing/);
    await closing;
    await until(() => host.snapshot().length === 0, 'unused reservation retired', WAIT);
    expect(host.snapshot()).toEqual([]);
  }, LIMIT);

  it.skipIf(!POSIX)('the POSIX zero spawn deadline raises holder-not-ready after reservation', async () => {
    const host = newHost(0);
    const { proc, seen } = await adoptFake(host, ['--ignore-term'], { armed: false });
    await expect(proc.ready).rejects.toMatchObject({ code: 'holder-not-ready' });
    expect(seen.errors.map(error => error.code)).toEqual(['holder-not-ready']);
  }, LIMIT);

  it('exit, error, and ready raised before any listener are replayed once, on the first on or once', async () => {
    const host = newHost();
    const exited = await adoptFake(host, ['--exit-on-eof'], { listen: false });
    exited.proc.stdin.end();
    await until(() => exited.proc.exitCode === 0 && host.snapshot().length === 0, 'unobserved exit', WAIT);
    const exits: unknown[][] = [];
    exited.proc.once('exit', (...args: unknown[]) => exits.push(args));
    expect(exits).toEqual([[0, null]]);
    exited.proc.on('exit', (...args: unknown[]) => exits.push(args));
    expect(exits).toHaveLength(1);
    let readies = 0;
    exited.proc.on('ready', () => { readies += 1; });
    expect(readies).toBe(1);

    const failed = await adoptFake(host, [], { command: join(tmpdir(), 'nonexistent', 'vonvon-claude'), listen: false, armed: false });
    await expect(failed.proc.ready).rejects.toBeInstanceOf(HolderProcessError);
    const errors: HolderProcessError[] = [];
    failed.proc.addListener('error', (error: HolderProcessError) => errors.push(error));
    expect(errors.map(error => error.code)).toEqual(['launch-failed']);
  }, LIMIT);
});

describe.skipIf(PLATFORM !== 'win32')('HolderProcess on Windows', () => {
  it('SIGTERM is accepted and does nothing, SIGKILL is TerminateJobObject for the whole Job, and a SIGKILL after settlement returns false', async () => {
    const host = newHost();
    const { proc, seen, pid, text } = await adoptFake(host, ['--grandchildren', '1']);
    const grandchild = Number(/gc (\d+)/.exec(text())?.[1]);
    proc.stdin.end();
    expect(proc.kill('SIGTERM')).toBe(true);
    expect(proc.killed).toBe(true);
    await sleep(500);
    expect(alive(pid)).toBe(true);
    expect(proc.kill('SIGKILL')).toBe(true);
    await until(() => seen.exits.length === 1 && host.snapshot().length === 0, 'record settled after TerminateJobObject', WAIT);
    expect(seen).toMatchObject({ exits: [KILLED], errors: [] });
    expect(alive(pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    expect(proc.kill('SIGKILL')).toBe(false);
  }, LIMIT);

  it('a supervisor that dies takes the Job with it: holder-lost comes before the containment exit(null, null)', async () => {
    const host = newHost();
    const { seen, pid } = await adoptFake(host, ['--ignore-term']);
    process.kill(host.snapshot()[0]?.holderPid as number, 'SIGKILL');
    await until(() => seen.exits.length === 1, 'containment exit after the supervisor died', 60_000);
    expect(seen.order).toEqual(['holder-lost', 'exit']);
    expect(seen.exits).toEqual([[null, null]]);
    expect(alive(pid)).toBe(false);
    await until(() => host.snapshot().length === 0, 'record retired', WAIT);
  }, LIMIT);
});

describe.skipIf(!POSIX)('HolderProcess on POSIX', () => {
  it('SDK close on a child that ignores EOF and SIGTERM: SIGTERM queues term, SIGKILL ends the group, and a SIGKILL after settlement returns false', async () => {
    const host = newHost();
    const { proc, seen, pid, text } = await adoptFake(host, ['--log-term', '--grandchildren', '1']);
    proc.stdin.end();
    expect(proc.kill('SIGTERM')).toBe(true);
    expect(proc.killed).toBe(true);
    await until(() => text().includes('term\n'), 'the child received SIGTERM');
    expect(alive(pid)).toBe(true);
    expect(proc.exitCode).toBeNull();
    expect(proc.kill('SIGKILL')).toBe(true);
    await until(() => host.snapshot().length === 0, 'record settled after SIGKILL');
    expect(seen).toMatchObject({ exits: [[null, 'SIGKILL']], errors: [] });
    expect(proc.signalCode).toBe('SIGKILL');
    expect(groupEmpty(pid)).toBe(true);
    expect(proc.kill('SIGKILL')).toBe(false);
  }, 30_000);

  it('SIGKILL queues kill at once, without waiting out the term wait', async () => {
    const host = newHost();
    const { proc, seen } = await adoptFake(host, ['--ignore-term']);
    expect(proc.kill('SIGKILL')).toBe(true);
    await until(() => seen.exits.length === 1, 'exit well inside TERM_WAIT_MS', TERM_WAIT_MS / 2);
    expect(seen.exits).toEqual([[null, 'SIGKILL']]);
  }, 30_000);

  it('any other signal queues term, which the child honours', async () => {
    const host = newHost();
    const { proc, seen } = await adoptFake(host, ['--term-exit-ms', '100']);
    expect(proc.kill('SIGINT')).toBe(true);
    await until(() => seen.exits.length === 1, 'exit after term');
    expect(seen).toMatchObject({ exits: [[0, null]], errors: [] });
  }, 30_000);

  it('stdout EOF with no exit fact raises transport-lost once after the hold, with no fabricated exit, and the real exit still follows', async () => {
    const host = newHost();
    const { proc, seen } = await adoptFake(host, ['--ignore-term', '--close-stdout-ms', '100']);
    await until(() => seen.errors.length > 0, 'transport-lost', 5000);
    expect(seen.errors.map(error => error.code)).toEqual(['transport-lost']);
    expect(seen.exits).toEqual([]);
    expect(proc.exitCode).toBeNull();
    expect(proc.kill('SIGKILL')).toBe(true);
    await until(() => seen.exits.length === 1, 'exit after SIGKILL');
    expect(seen.exits).toEqual([[null, 'SIGKILL']]);
    expect(seen.errors).toHaveLength(1);
  }, 30_000);

  it('an attempting write the ledger refuses raises launch-failed carrying the write error, and nothing runs', async () => {
    const host = newHost();
    const obstruction = join(dirOf.get(host) as string, `process-owners.json.${process.pid}.tmp`);
    const reservation = await host.reserve('claude') as Reservation;
    mkdirSync(obstruction);
    const proc = reservation.adopt({ command: NODE, args: [FAKE], env: ENV, signal: new AbortController().signal });
    const errors: HolderProcessError[] = [];
    proc.on('error', (error: HolderProcessError) => errors.push(error));
    await expect(proc.ready).rejects.toThrow(/EISDIR/);
    await until(() => errors.length === 1 && host.snapshot().length === 0, 'launch-failed settled');
    expect(errors[0]).toMatchObject({ code: 'launch-failed', cause: expect.objectContaining({ code: 'EISDIR' }) });
    rmSync(obstruction, { recursive: true });
  }, 30_000);

  it('a holder that dies before an exit fact raises holder-lost', async () => {
    const host = newHost();
    const { seen, pid } = await adoptFake(host, ['--ignore-term']);
    process.kill(host.snapshot()[0]?.holderPid as number, 'SIGKILL');
    await until(() => seen.errors.length === 1, 'holder-lost');
    expect(seen).toMatchObject({ exits: [], errors: [{ code: 'holder-lost' }] });
    process.kill(-pid, 'SIGKILL');
    await until(() => groupEmpty(pid), 'group empty');
    expect(await host.sweepOrphans()).toMatchObject({ gone: 1 });
  }, 30_000);

  it('a containment exit raises holder-lost before exit(null, null), so the SDK never reads it as a clean exit', async () => {
    const host = newHost();
    const { seen, pid } = await adoptFake(host, ['--ignore-term']);
    const holderPid = host.snapshot()[0]?.holderPid as number;
    process.kill(holderPid, 'SIGSTOP');
    process.kill(-pid, 'SIGKILL');
    process.kill(holderPid, 'SIGKILL');
    // Blocks the loop until init reaps the provider, so the host's probe at the holder's exit finds the group empty.
    const deadline = Date.now() + 5000;
    while (!groupEmpty(pid) && Date.now() < deadline) { }
    expect(groupEmpty(pid)).toBe(true);
    await until(() => seen.exits.length === 1, 'containment exit');
    expect(seen.order).toEqual(['holder-lost', 'exit']);
    expect(seen.exits).toEqual([[null, null]]);
  }, 30_000);
});
