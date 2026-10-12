import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { spawnProcess } from '../../src/platform/spawn';
import { linuxProcessIdentity } from '../../src/provider/process/linux-identity';
import { nativeProcessIdentity } from '../../src/provider/process/native-identity';
import type { OwnedProcess } from '../../src/provider/process/owned-process';
import { PosixProcessDriver } from '../../src/provider/process/posix-driver';
import { ProcessHost } from '../../src/provider/process/process-host';

const fixturePath = fileURLToPath(new URL('./fixtures/fake-child.mjs', import.meta.url));
const directories: string[] = [];
const ownedProcesses: OwnedProcess[] = [];
const hosts: ProcessHost[] = [];
const readySchema = z.object({ kind: z.literal('ready'), pid: z.number().int().positive(), descendants: z.array(z.number().int().positive()) });

afterEach(async () => {
  const results = await Promise.allSettled(ownedProcesses.splice(0).map(owned => owned.killTree()));
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  const closed = await Promise.allSettled(hosts.splice(0).map(host => host.close()));
  failures.push(...closed.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
  if (failures.length) throw new AggregateError(failures, 'Native ProcessHost fixture cleanup is unconfirmed; evidence retained');
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function driver(): PosixProcessDriver {
  if (process.platform === 'linux') {
    const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
    return new PosixProcessDriver({ readIdentity: linuxProcessIdentity(ticks) });
  }
  const helper = process.env.VONVON_TEST_PROCESS_IDENTITY_HELPER;
  if (process.platform !== 'darwin' || !helper) {
    throw new Error('Build macos-identity.c and set VONVON_TEST_PROCESS_IDENTITY_HELPER; this native lane cannot be skipped');
  }
  return new PosixProcessDriver({ readIdentity: nativeProcessIdentity(helper) });
}

async function hostFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'vonvon-process-native-'));
  directories.push(dataDir);
  const processDriver = driver();
  const host = new ProcessHost({ dataDir, daemonBootId: 'native-boot-one', driver: processDriver });
  hosts.push(host);
  return { dataDir, processDriver, host };
}

function ready(child: ChildProcess): Promise<z.infer<typeof readySchema>> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const finish = (): void => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };
    const onExit = (): void => { finish(); reject(new Error('Fixture exited before readiness')); };
    const onData = (chunk: string): void => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let result;
        try { result = readySchema.safeParse(JSON.parse(line)); }
        catch { continue; }
        if (result.success) { finish(); resolve(result.data); return; }
      }
    };
    const timeout = setTimeout(() => { finish(); reject(new Error('Fixture readiness timed out')); }, 10_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', onData);
    child.stderr?.resume();
    child.once('exit', onExit);
  });
}

function groupAbsent(pid: number): boolean {
  try { process.kill(-pid, 0); return false; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
    throw error;
  }
}

describe.skipIf(process.platform === 'win32')('ProcessHost native POSIX acceptance', () => {
  it('persists an OS identity and kills every member after a TERM timeout', async () => {
    const { host, dataDir } = await hostFixture();
    const owned = await host.spawn({ command: process.execPath, args: [fixturePath, '--ignore-term', '--grandchild', '--slow-frames'], providerId: 'codex', sessionId: 'native-tree' });
    ownedProcesses.push(owned);
    const record: unknown = JSON.parse(await readFile(join(dataDir, 'owned-pids.json'), 'utf8'));
    expect(record).toEqual([{ ...owned.record }]);
    const running = await ready(owned.child);
    expect(running.descendants).toHaveLength(1);
    expect(host.owesWork()).toBe(true);
    expect(await owned.terminateTree(50)).toBe('timeout');
    await owned.killTree();
    expect(groupAbsent(running.pid)).toBe(true);
    expect(host.owesWork()).toBe(false);
    expect(await host.ledger.read()).toEqual([]);
  }, 20_000);

  it('adopts a detached SDK-style child with the same TERM and KILL behavior', async () => {
    const { host, processDriver } = await hostFixture();
    await processDriver.available(performance.now() + 2000);
    const child = spawnProcess(process.execPath, [fixturePath, '--ignore-term', '--grandchild', '--slow-frames'], { detached: true });
    const owned = await host.adopt(child, { providerId: 'claude', sessionId: 'native-adopt' });
    ownedProcesses.push(owned);
    const running = await ready(child);
    expect((await host.ledger.read())[0]?.providerId).toBe('claude');
    expect(await owned.terminateTree(50)).toBe('timeout');
    await owned.killTree();
    expect(groupAbsent(running.pid)).toBe(true);
    expect(host.owesWork()).toBe(false);
  }, 20_000);

  it('leaves a live process untouched when the recorded birth does not match', async () => {
    const { host, dataDir, processDriver } = await hostFixture();
    const owned = await host.spawn({ command: process.execPath, args: [fixturePath, '--ignore-term', '--slow-frames'], providerId: 'codex', sessionId: 'birth-mismatch' });
    ownedProcesses.push(owned);
    await ready(owned.child);
    await writeFile(join(dataDir, 'owned-pids.json'), JSON.stringify([{ ...owned.record, startedAtMs: owned.record.startedAtMs - 1 }]));
    const restarted = new ProcessHost({ dataDir, daemonBootId: 'native-boot-two', driver: processDriver });
    expect(await restarted.sweepOrphans()).toEqual({ killed: 0, skipped: 1, unconfirmed: [] });
    expect(groupAbsent(owned.pid)).toBe(false);
    expect(owned.child.exitCode).toBeNull();
  }, 20_000);

  it('requires a matching old-daemon identity to produce killed: 1 and an absent tree', async () => {
    const { host, dataDir, processDriver } = await hostFixture();
    const owned = await host.spawn({ command: process.execPath, args: [fixturePath, '--ignore-term', '--grandchild', '--slow-frames'], providerId: 'codex', sessionId: 'native-recovery' });
    ownedProcesses.push(owned);
    await ready(owned.child);
    const restarted = new ProcessHost({ dataDir, daemonBootId: 'native-boot-two', driver: processDriver });
    expect(await restarted.sweepOrphans()).toEqual({ killed: 1, skipped: 0, unconfirmed: [] });
    expect(groupAbsent(owned.pid)).toBe(true);
  }, 20_000);

  it.todo('lane 10: kills the daemon fixture, then proves orphan recovery after an actual process restart');
});

describe.skipIf(process.platform !== 'win32')('ProcessHost native Windows acceptance', () => {
  it.todo('spawns into a Job, persists an exact OS birth identity, and proves the Job is empty after termination');
  it.todo('adopts the SDK child into a Job without a spawn-before-assignment gap');
  it.todo('recovers the prior daemon Job while preserving a reused PID');
});
