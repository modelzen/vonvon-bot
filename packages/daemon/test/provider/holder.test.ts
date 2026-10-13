import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HolderCommand } from '../../src/provider/process/holder-protocol';
import { compileHolder, HolderDriver, type HolderBinary } from './native/holder-driver';

const NODE = process.execPath;
// `ready` only says execve succeeded; a node provider installs its handlers tens of milliseconds later, so each
// fixture announces `armed` (and a grandchild's pid only once the grandchild is armed) before a test signals it.
const ARMED_GRANDCHILD = `process.on('SIGTERM', () => {}); process.stdout.write('armed'); setInterval(() => {}, 1000)`;
const SPAWN_GRANDCHILD = `const g = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(ARMED_GRANDCHILD)}], { stdio: ['ignore', 'pipe', 'ignore'] }); g.stdout.once('data', () => { g.stdout.unref(); process.stdout.write('gc ' + g.pid + '\\n', armed); }); g.unref();`;
const SCRIPTS = {
  echo: `process.stdin.pipe(process.stdout)`,
  ignoreTerm: `process.on('SIGTERM', () => {}); process.stdout.write('armed'); setInterval(() => {}, 1000)`,
  treeThenExit: `const armed = () => process.exit(0); ${SPAWN_GRANDCHILD}`,
  treeStay: `const armed = () => {}; process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); ${SPAWN_GRANDCHILD}`,
  stopSelf: `process.on('SIGTERM', () => { process.stdout.write('got-term', () => process.exit(3)); }); setInterval(() => {}, 1000); process.stdout.write('stopping', () => process.kill(process.pid, 'SIGSTOP'))`,
  fds: `const fs = require('fs'); const pipes = []; for (let fd = 0; fd < 256; fd++) { try { const st = fs.fstatSync(fd); if (st.isFIFO() || st.isSocket()) pipes.push(fd); } catch {} } process.stdout.write(JSON.stringify(pipes))`,
  args: `process.stdout.write(JSON.stringify({ argv: process.argv.slice(-2), a: process.env.A, b: process.env.B }))`,
};

let binary: HolderBinary;
const holders: HolderDriver[] = [];
const groups: number[] = [];
const tempDirs: string[] = [];

beforeAll(() => { binary = compileHolder(); });
afterAll(() => binary.dispose());
afterEach(async () => {
  await Promise.all(holders.splice(0).map(holder => holder.dispose()));
  for (const pid of groups.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already empty */ } }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupEmpty = (pid: number): boolean => { try { process.kill(-pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await sleep(20); }
}

function start(): HolderDriver {
  const holder = new HolderDriver(binary.path);
  holders.push(holder);
  return holder;
}
const nodeLaunch = (script: string, extra: Partial<Extract<HolderCommand, { command: 'launch' }>> = {}): HolderCommand =>
  ({ command: 'launch', nonce: 'l1', file: NODE, args: ['-e', script], env: {}, ...extra });

/** launch, created, go, ready; returns the provider pid and registers its group for cleanup. */
async function running(holder: HolderDriver, launch: HolderCommand): Promise<number> {
  await holder.take('hello');
  holder.send(launch);
  const created = await holder.take('created');
  groups.push(created.pid);
  holder.send({ command: 'go', nonce: 'g1' });
  await holder.take('ready');
  return created.pid;
}

describe.skipIf(process.platform === 'win32')('vonvon-holder', () => {
  it('greets with protocol version 1 before any command, so a daemon never reads an older grammar', async () => {
    const holder = start();
    expect(await holder.take('hello')).toEqual({ kind: 'hello', version: 1 });
  });

  it('runs created, go, ready, pipes provider stdio through slots 3 and 4, and reports a clean exit as provider-exit 0 -', async () => {
    const holder = start();
    const pid = await running(holder, nodeLaunch(SCRIPTS.echo));
    expect(pid).toBeGreaterThan(1);
    holder.slot(3).write('ping\n');
    expect(await holder.providerStdout(text => text.includes('ping\n'))).toBe('ping\n');
    holder.slot(3).end();
    expect(await holder.take('provider-exit')).toEqual({ kind: 'provider-exit', code: 0, signal: null });
    holder.send({ command: 'reap', nonce: 'r1' });
    expect(await holder.take('reaped')).toMatchObject({ nonce: 'r1' });
    holder.send({ command: 'probe', nonce: 'p1' });
    expect(await holder.take('empty')).toMatchObject({ nonce: 'p1' });
    holder.send({ command: 'exit', nonce: 'x1' });
    expect(await holder.exit).toEqual({ code: 0, signal: null });
  });

  it('term on a TERM-ignoring provider reports sent without an exit; kill then yields provider-exit - SIGKILL, reaped, empty', async () => {
    const holder = start();
    await running(holder, nodeLaunch(SCRIPTS.ignoreTerm));
    await holder.providerStdout(text => text.includes('armed'));
    holder.send({ command: 'term', nonce: 't1' });
    expect(await holder.take('sent')).toEqual({ kind: 'sent', rung: 'term', nonce: 't1' });
    await sleep(300);
    expect(holder.peek('provider-exit')).toEqual([]);
    holder.send({ command: 'kill', nonce: 'k1' });
    expect(await holder.take('sent')).toEqual({ kind: 'sent', rung: 'kill', nonce: 'k1' });
    expect(await holder.take('provider-exit')).toEqual({ kind: 'provider-exit', code: null, signal: 'SIGKILL' });
    holder.send({ command: 'reap', nonce: 'r1' });
    await holder.take('reaped');
    holder.send({ command: 'probe', nonce: 'p1' });
    await holder.take('empty');
  });

  it('keeps the group bound after the provider exits: a TERM-ignoring grandchild dies on the kill rung and the probe ends empty', async () => {
    const holder = start();
    const pid = await running(holder, nodeLaunch(SCRIPTS.treeThenExit));
    const grandchild = Number(/gc (\d+)/.exec(await holder.providerStdout(text => /gc \d+\n/.test(text)))?.[1]);
    expect(await holder.take('provider-exit')).toEqual({ kind: 'provider-exit', code: 0, signal: null });
    expect(alive(grandchild)).toBe(true);
    holder.send({ command: 'term', nonce: 't1' });
    expect(await holder.take('sent')).toMatchObject({ rung: 'term' });
    await sleep(200);
    expect(alive(grandchild)).toBe(true);
    holder.send({ command: 'kill', nonce: 'k1' });
    expect(await holder.take('sent')).toMatchObject({ rung: 'kill' });
    await until(() => !alive(grandchild), 'grandchild death');
    holder.send({ command: 'reap', nonce: 'r1' });
    await holder.take('reaped');
    holder.send({ command: 'probe', nonce: 'p1' });
    await holder.take('empty');
    expect(groupEmpty(pid)).toBe(true);
  });

  it('follows SIGTERM with SIGCONT, so a stopped provider wakes and handles the term', async () => {
    const holder = start();
    const pid = await running(holder, nodeLaunch(SCRIPTS.stopSelf));
    await holder.providerStdout(text => text.includes('stopping'));
    if (process.platform === 'linux') await until(() => readFileSync(`/proc/${pid}/stat`, 'latin1').includes(') T '), 'stopped state');
    else await sleep(300);
    holder.send({ command: 'term', nonce: 't1' });
    expect(await holder.take('sent')).toMatchObject({ rung: 'term' });
    expect(await holder.take('provider-exit')).toEqual({ kind: 'provider-exit', code: 3, signal: null });
    await holder.providerStdout(text => text.includes('got-term'));
  });

  it('answers reap before the observation with not-ready, repeats reaped idempotently, and refuses signals after the reap', async () => {
    const holder = start();
    await running(holder, nodeLaunch(SCRIPTS.ignoreTerm));
    holder.send({ command: 'reap', nonce: 'r0' });
    expect(await holder.take('not-ready')).toMatchObject({ nonce: 'r0' });
    holder.send({ command: 'kill', nonce: 'k1' });
    await holder.take('provider-exit');
    holder.send({ command: 'reap', nonce: 'r1' });
    holder.send({ command: 'reap', nonce: 'r2' });
    expect(await holder.take('reaped')).toMatchObject({ nonce: 'r1' });
    expect(await holder.take('reaped')).toMatchObject({ nonce: 'r2' });
    holder.send({ command: 'kill', nonce: 'k2' });
    expect(await holder.take('refused')).toEqual({ kind: 'refused', command: 'kill', nonce: 'k2', reason: 'reaped' });
  });

  it('treats nothing before the reap as proof: probe says not-ready, the final kill is reported as the call returned, and only the probe after the reap is empty', async () => {
    const holder = start();
    await holder.take('hello');
    holder.send({ command: 'probe', nonce: 'p0' });
    expect(await holder.take('refused')).toEqual({ kind: 'refused', command: 'probe', nonce: 'p0', reason: 'not-launched' });
    holder.send({ command: 'launch', nonce: 'l1', file: NODE, args: ['-e', 'process.exit(5)'], env: {} });
    groups.push((await holder.take('created')).pid);
    holder.send({ command: 'go', nonce: 'g1' });
    await holder.take('ready');
    expect(await holder.take('provider-exit')).toEqual({ kind: 'provider-exit', code: 5, signal: null });
    holder.send({ command: 'probe', nonce: 'p1' });
    expect(await holder.take('not-ready')).toEqual({ kind: 'not-ready', nonce: 'p1' });
    holder.send({ command: 'kill', nonce: 'k1' });
    // A group whose only member is the retained zombie: Linux answers 0, macOS answers EPERM.
    const final = await Promise.race([holder.take('sent'), holder.take('refused')]);
    expect(final).toEqual(process.platform === 'darwin'
      ? { kind: 'refused', command: 'kill', nonce: 'k1', reason: 1 }
      : { kind: 'sent', rung: 'kill', nonce: 'k1' });
    holder.send({ command: 'reap', nonce: 'r1' });
    await holder.take('reaped');
    holder.send({ command: 'probe', nonce: 'p2' });
    expect(await holder.take('empty')).toEqual({ kind: 'empty', nonce: 'p2' });
  });

  for (const path of ['abandon', 'eof', 'term'] as const) {
    it(`cancels an unreleased stub on ${path} before go: cancelled, exit 10, and no provider ran`, async () => {
      const holder = start();
      await holder.take('hello');
      holder.send(nodeLaunch(`process.stdout.write('ran')`));
      groups.push((await holder.take('created')).pid);
      if (path === 'abandon') holder.send({ command: 'abandon', nonce: 'a1' });
      if (path === 'eof') holder.closeCommands();
      if (path === 'term') {
        holder.send({ command: 'term', nonce: 't1' });
        expect(await holder.take('refused')).toEqual({ kind: 'refused', command: 'term', nonce: 't1', reason: 'not-launched' });
      }
      expect(await holder.take('cancelled')).toMatchObject({ nonce: 'l1' });
      expect(await holder.exit).toEqual({ code: 10, signal: null });
      expect(holder.peek('ready')).toEqual([]);
      expect(Buffer.concat(holder.providerOut).toString()).toBe('');
    });
  }

  it('a term before launch latches cancellation for good: launch and go are refused cancelled and nothing is created', async () => {
    const holder = start();
    await holder.take('hello');
    holder.send({ command: 'term', nonce: 't1' });
    expect(await holder.take('refused')).toEqual({ kind: 'refused', command: 'term', nonce: 't1', reason: 'not-launched' });
    holder.send(nodeLaunch(SCRIPTS.echo));
    expect(await holder.take('refused')).toEqual({ kind: 'refused', command: 'launch', nonce: 'l1', reason: 'cancelled' });
    holder.send({ command: 'go', nonce: 'g1' });
    expect(await holder.take('refused')).toEqual({ kind: 'refused', command: 'go', nonce: 'g1', reason: 'cancelled' });
    expect(holder.peek('created')).toEqual([]);
    holder.closeCommands();
    expect(await holder.exit).toEqual({ code: 10, signal: null });
  });

  it('abandon before launch exits never-launched, and EOF before launch does too', async () => {
    const first = start();
    await first.take('hello');
    first.send({ command: 'abandon', nonce: 'a1' });
    expect(await first.exit).toEqual({ code: 10, signal: null });
    const second = start();
    await second.take('hello');
    second.closeCommands();
    expect(await second.exit).toEqual({ code: 10, signal: null });
  });

  it('refuses a second launch as already-created and a second go as already-sent, creating nothing new', async () => {
    const holder = start();
    const pid = await running(holder, nodeLaunch(SCRIPTS.ignoreTerm));
    holder.send(nodeLaunch(SCRIPTS.ignoreTerm, { nonce: 'l2' }));
    expect(await holder.take('refused')).toEqual({ kind: 'refused', command: 'launch', nonce: 'l2', reason: 'already-created' });
    holder.send({ command: 'go', nonce: 'g2' });
    expect(await holder.take('refused')).toEqual({ kind: 'refused', command: 'go', nonce: 'g2', reason: 'already-sent' });
    expect(holder.peek('created')).toEqual([]);
    expect(alive(pid)).toBe(true);
  });

  const failures: Array<[string, Partial<Extract<HolderCommand, { command: 'launch' }>>, string, number]> = [
    ['a command missing from an explicit PATH', { file: 'vonvon-no-such-command', env: { PATH: '/usr/bin:/bin' } }, 'exec', 2],
    ['an empty PATH, which has no candidates', { file: 'sh', env: { PATH: '' } }, 'exec', 2],
    ['a cwd that does not exist', { file: NODE, args: ['-e', '0'], cwd: '/nonexistent-vonvon-dir' }, 'chdir', 2],
  ];
  for (const [what, launch, step, errno] of failures) {
    it(`reports launch-failed ${step} ${errno} and exits 11 for ${what}`, async () => {
      const holder = start();
      await holder.take('hello');
      holder.send({ command: 'launch', nonce: 'l1', file: '', args: [], env: {}, ...launch });
      groups.push((await holder.take('created')).pid);
      holder.send({ command: 'go', nonce: 'g1' });
      expect(await holder.take('launch-failed')).toEqual({ kind: 'launch-failed', nonce: 'l1', step, errno });
      expect(await holder.exit).toEqual({ code: 11, signal: null });
      expect(holder.peek('ready')).toEqual([]);
      expect(holder.peek('provider-exit')).toEqual([]);
    });
  }

  it('finds no candidate on an empty PATH even when the cwd holds an executable of that name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vonvon-emptypath-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'foo'), '#!/bin/sh\necho works\n');
    chmodSync(join(dir, 'foo'), 0o755);
    const holder = start();
    await holder.take('hello');
    holder.send({ command: 'launch', nonce: 'l1', file: 'foo', args: [], env: { PATH: '' }, cwd: dir });
    groups.push((await holder.take('created')).pid);
    holder.send({ command: 'go', nonce: 'g1' });
    expect(await holder.take('launch-failed')).toEqual({ kind: 'launch-failed', nonce: 'l1', step: 'exec', errno: 2 });
    expect(Buffer.concat(holder.providerOut).toString()).toBe('');
  });

  it('keeps every receipt while the daemon is not reading: thousands of answers arrive complete and in order', async () => {
    const holder = start();
    await holder.take('hello');
    const receipts = holder.child.stdout!;
    receipts.pause();
    const count = 5000;
    for (let i = 0; i < count; i++) holder.send({ command: 'probe', nonce: `p${i}` });
    await sleep(500);
    receipts.resume();
    for (let i = 0; i < count; i++) {
      expect(await holder.take('refused')).toEqual({ kind: 'refused', command: 'probe', nonce: `p${i}`, reason: 'not-launched' });
    }
  }, 30_000);

  it('sees command EOF while the receipt reader is stalled, and still ends the tree and exits', async () => {
    const holder = start();
    const pid = await running(holder, nodeLaunch(SCRIPTS.treeStay));
    const grandchild = Number(/gc (\d+)/.exec(await holder.providerStdout(text => /gc \d+\n/.test(text)))?.[1]);
    holder.child.stdout!.pause();
    // Enough answers to overrun the receipt socket's buffer, so the holder holds a backlog when EOF comes.
    for (let i = 0; i < 50_000; i++) holder.send({ command: 'probe', nonce: `p${i}` });
    holder.closeCommands();
    const exit = await Promise.race([holder.exit, sleep(10_000).then(() => 'still running')]);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(groupEmpty(pid)).toBe(true);
    expect(alive(grandchild)).toBe(false);
  }, 20_000);

  it('fails ENOEXEC on an executable file without a valid header instead of running it through a shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vonvon-noexec-'));
    tempDirs.push(dir);
    const file = join(dir, 'script');
    writeFileSync(file, 'echo shell-ran\n');
    chmodSync(file, 0o755);
    const holder = start();
    await holder.take('hello');
    holder.send({ command: 'launch', nonce: 'l1', file, args: [], env: {} });
    groups.push((await holder.take('created')).pid);
    holder.send({ command: 'go', nonce: 'g1' });
    expect(await holder.take('launch-failed')).toEqual({ kind: 'launch-failed', nonce: 'l1', step: 'exec', errno: 8 });
    expect(await holder.exit).toEqual({ code: 11, signal: null });
    expect(Buffer.concat(holder.providerOut).toString()).not.toContain('shell-ran');
  });

  it('resolves a slash-free command on the libc default path when the explicit environment has no PATH', async () => {
    const holder = start();
    await running(holder, { command: 'launch', nonce: 'l1', file: 'sh', args: ['-c', 'echo default-path-ok'], env: {} });
    expect(await holder.providerStdout(text => text.includes('default-path-ok'))).toBe('default-path-ok\n');
    expect(await holder.take('provider-exit')).toMatchObject({ code: 0 });
  });

  it('delivers argv and environment bytes with spaces, newlines, and = unchanged', async () => {
    const holder = start();
    const argv = ['a b=c', 'line1\nline2 =\n'];
    await running(holder, nodeLaunch(SCRIPTS.args, { args: ['-e', SCRIPTS.args, ...argv], env: { A: 'x y=z', B: 'multi\nline==' } }));
    const text = await holder.providerStdout(t => t.endsWith('}'));
    expect(JSON.parse(text)).toEqual({ argv, a: 'x y=z', b: 'multi\nline==' });
  });

  it('on daemon death after go, ends a TERM-ignoring tree itself and exits 0 once the group is empty', async () => {
    const holder = start();
    const pid = await running(holder, nodeLaunch(SCRIPTS.treeStay));
    const grandchild = Number(/gc (\d+)/.exec(await holder.providerStdout(text => /gc \d+\n/.test(text)))?.[1]);
    const closedAt = Date.now();
    holder.closeCommands();
    expect(await holder.exit).toEqual({ code: 0, signal: null });
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(1400);
    expect(groupEmpty(pid)).toBe(true);
    expect(alive(grandchild)).toBe(false);
  }, 20_000);

  it('leaks no holder descriptor into the provider: the same pipe count as a direct spawn, with 0, 1, 2 on the slot pipes', async () => {
    const direct = spawn(NODE, ['-e', SCRIPTS.fds], { stdio: ['pipe', 'pipe', 'pipe'] });
    const baseline: number[] = await new Promise(resolve => {
      const chunks: Buffer[] = [];
      direct.stdout.on('data', chunk => chunks.push(chunk));
      direct.on('exit', () => resolve(JSON.parse(Buffer.concat(chunks).toString()) as number[]));
    });
    const holder = start();
    await running(holder, nodeLaunch(SCRIPTS.fds));
    const viaHolder = JSON.parse(await holder.providerStdout(text => text.endsWith(']'))) as number[];
    expect(viaHolder.slice(0, 3)).toEqual([0, 1, 2]);
    expect(viaHolder.length).toBe(baseline.length);
  });

  it('logs and ignores a malformed command line without disturbing the next command', async () => {
    const holder = start();
    await holder.take('hello');
    holder.commands.write('bogus line with spaces\nprobe not a nonce!\n');
    holder.send({ command: 'probe', nonce: 'p1' });
    expect(await holder.take('refused')).toEqual({ kind: 'refused', command: 'probe', nonce: 'p1', reason: 'not-launched' });
    await until(() => holder.log.join('').includes('malformed'), 'the malformed-command log line');
  });
});
