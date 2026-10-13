import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TERM_WAIT_MS } from '../../src/provider/engines/engine';
import { HolderProcessError, specOf } from '../../src/provider/process/holder-process';
import { ProcessHost, Reservation } from '../../src/provider/process/process-host';
import { alive, until } from './channel-recorder';
import { compileHolder, type HolderBinary } from './native/holder-driver';

const NODE = process.execPath;
const FAKE = fileURLToPath(new URL('./fixtures/fake-child.mjs', import.meta.url));
const groupEmpty = (pid: number): boolean => { try { process.kill(-pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let binary: HolderBinary | undefined;
const hosts: ProcessHost[] = [];
const dirs: string[] = [];
const groups: number[] = [];

afterAll(() => binary?.dispose());
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.closeAll()));
  for (const pid of groups.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch { } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newHost(spawnDeadlineMs = 20_000): ProcessHost {
  const dir = mkdtempSync(join(tmpdir(), 'vonvon-holder-process-'));
  dirs.push(dir);
  const host = new ProcessHost({ dataDir: dir, daemonBootId: randomUUID(), spawnDeadlineMs, platform: 'posix', holderPath: (binary as HolderBinary).path });
  hosts.push(host);
  return host;
}

type Seen = { exits: Array<[number | null, string | null]>; errors: HolderProcessError[] };

/** Attaches `exit` and `error` at once, as the SDK's ProcessTransport does. */
async function adoptFake(host: ProcessHost, args: string[], options: { signal?: AbortSignal; command?: string; listen?: boolean; armed?: boolean } = {}) {
  const reservation = await host.reserve('claude', 'session-1');
  if (!(reservation instanceof Reservation)) throw new Error('reservation refused');
  const proc = reservation.adopt({
    command: options.command ?? NODE, args: [FAKE, ...args],
    env: { PATH: process.env.PATH ?? '', VONVON_UNSET: undefined }, signal: options.signal ?? new AbortController().signal,
  });
  const seen: Seen = { exits: [], errors: [] };
  if (options.listen !== false) {
    proc.on('exit', (code: number | null, signal: string | null) => seen.exits.push([code, signal]));
    proc.on('error', (error: HolderProcessError) => seen.errors.push(error));
  }
  let text = '';
  proc.stdout.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  let pid = 0;
  if (options.armed !== false) {
    await until(() => text.includes('armed\n'), 'fake child armed');
    pid = Number(/pid (\d+)/.exec(text)?.[1]);
    groups.push(pid);
  }
  return { proc, seen, pid };
}

describe('specOf', () => {
  it('drops env entries the SDK left undefined', () => {
    expect(specOf({ command: 'claude', args: ['-p'], cwd: '/w', env: { A: '1', B: undefined }, signal: new AbortController().signal }))
      .toEqual({ file: 'claude', args: ['-p'], cwd: '/w', env: { A: '1' } });
  });
});

describe.skipIf(process.platform === 'win32')('HolderProcess on POSIX', () => {
  beforeAll(() => { binary = compileHolder(); });

  it('SDK close on a child that exits at stdin EOF: exit fires once with its code, and the delayed SIGTERM and SIGKILL do nothing, even with a replacement running', async () => {
    const host = newHost();
    const { proc, seen, pid } = await adoptFake(host, ['--exit-on-eof']);
    expect(proc.exitCode).toBeNull();
    expect(proc.killed).toBe(false);
    expect('pid' in proc).toBe(false);
    proc.stdin.end();
    await until(() => seen.exits.length === 1 && host.snapshot().length === 0, 'exit and settlement');
    expect(seen.exits).toEqual([[0, null]]);
    expect(proc.exitCode).toBe(0);
    expect(proc.signalCode).toBeNull();
    expect(alive(pid)).toBe(false);

    const replacement = await adoptFake(host, ['--ignore-term']);
    expect(proc.kill('SIGTERM')).toBe(false);
    expect(proc.kill('SIGKILL')).toBe(false);
    expect(proc.killed).toBe(false);
    await sleep(300);
    expect(alive(replacement.pid)).toBe(true);
    expect(replacement.seen.exits).toEqual([]);
    expect(seen).toEqual({ exits: [[0, null]], errors: [] });
    expect(replacement.proc.kill('SIGKILL')).toBe(true);
    await until(() => replacement.seen.exits.length === 1, 'replacement exit');
  }, 30_000);

  it('SDK close on a child that ignores EOF and SIGTERM: SIGTERM queues term, SIGKILL ends the group, and a SIGKILL after settlement returns false', async () => {
    const host = newHost();
    const { proc, seen, pid } = await adoptFake(host, ['--ignore-term', '--grandchildren', '1']);
    proc.stdin.end();
    expect(proc.kill('SIGTERM')).toBe(true);
    expect(proc.killed).toBe(true);
    await sleep(300);
    expect(alive(pid)).toBe(true);
    expect(proc.exitCode).toBeNull();
    expect(proc.kill('SIGKILL')).toBe(true);
    await until(() => host.snapshot().length === 0, 'record settled after SIGKILL');
    expect(seen).toEqual({ exits: [[null, 'SIGKILL']], errors: [] });
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
    expect(seen).toEqual({ exits: [[0, null]], errors: [] });
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

  it('a command that cannot start raises launch-failed and retires the record without an exit', async () => {
    const host = newHost();
    const { proc, seen } = await adoptFake(host, [], { command: '/nonexistent/vonvon-claude', armed: false });
    await expect(proc.ready).rejects.toMatchObject({ code: 'launch-failed' });
    await until(() => seen.errors.length === 1 && host.snapshot().length === 0, 'launch-failed settled');
    expect(seen.errors.map(error => error.code)).toEqual(['launch-failed']);
    expect(seen.exits).toEqual([]);
    expect(proc.kill('SIGKILL')).toBe(false);
  }, 30_000);

  it('the spawn deadline raises holder-not-ready', async () => {
    const host = newHost(0);
    const { proc, seen } = await adoptFake(host, ['--ignore-term'], { armed: false });
    await expect(proc.ready).rejects.toMatchObject({ code: 'holder-not-ready' });
    expect(seen.errors.map(error => error.code)).toEqual(['holder-not-ready']);
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

  it('exit, error, and ready raised before any listener are replayed once, on the first on or once', async () => {
    const host = newHost();
    const exited = await adoptFake(host, ['--exit-on-eof'], { listen: false });
    exited.proc.stdin.end();
    await until(() => exited.proc.exitCode === 0 && host.snapshot().length === 0, 'unobserved exit');
    const exits: unknown[][] = [];
    exited.proc.once('exit', (...args: unknown[]) => exits.push(args));
    expect(exits).toEqual([[0, null]]);
    exited.proc.on('exit', (...args: unknown[]) => exits.push(args));
    expect(exits).toHaveLength(1);
    let readies = 0;
    exited.proc.on('ready', () => { readies += 1; });
    expect(readies).toBe(1);

    const failed = await adoptFake(host, [], { command: '/nonexistent/vonvon-claude', listen: false, armed: false });
    await expect(failed.proc.ready).rejects.toBeInstanceOf(HolderProcessError);
    const errors: HolderProcessError[] = [];
    failed.proc.on('error', (error: HolderProcessError) => errors.push(error));
    expect(errors.map(error => error.code)).toEqual(['launch-failed']);
  }, 30_000);

  it('aborting options.signal queues term', async () => {
    const host = newHost();
    const controller = new AbortController();
    const { proc, seen } = await adoptFake(host, ['--term-exit-ms', '100'], { signal: controller.signal });
    controller.abort();
    expect(proc.killed).toBe(true);
    await until(() => seen.exits.length === 1 && host.snapshot().length === 0, 'exit after abort');
    expect(seen).toEqual({ exits: [[0, null]], errors: [] });
  }, 30_000);

  it('a signal already aborted at adopt never lets the provider run', async () => {
    const host = newHost();
    const controller = new AbortController();
    controller.abort();
    const { proc, seen } = await adoptFake(host, [], { signal: controller.signal, armed: false });
    expect(proc.killed).toBe(true);
    await until(() => host.snapshot().length === 0, 'record retired');
    await expect(proc.ready).rejects.toMatchObject({ code: 'cancelled' });
    expect(seen).toEqual({ exits: [], errors: [expect.objectContaining({ code: 'cancelled' })] });
  }, 30_000);
});
