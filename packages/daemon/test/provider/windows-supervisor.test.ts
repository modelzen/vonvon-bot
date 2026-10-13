import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HolderChannel } from '../../src/provider/process/holder-channel';
import { validateSignalReceipt, type HolderCommand } from '../../src/provider/process/holder-protocol';
import { windowsCommandLine } from '../../src/provider/process/windows-command-line';
import { newPipeName, POWERSHELL, spawnWindowsSupervisor, type WindowsSupervisorOptions } from '../../src/provider/process/windows-supervisor';
import { alive, recordReceipts, until } from './channel-recorder';

const NODE = process.execPath;
const ENV = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
const ARMED_GRANDCHILD = `process.on('SIGTERM', () => {}); process.stdout.write('armed'); setInterval(() => {}, 1000)`;
const TREE_STAY = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); const g = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(ARMED_GRANDCHILD)}], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); g.stdout.once('data', () => { g.stdout.unref(); process.stdout.write('gc ' + g.pid + '\\n'); }); g.unref();`;
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const psArgs = (script: string): string[] => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];

const channels: HolderChannel[] = [];
const helpers: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const channel of channels.splice(0)) {
    channel.close();
    const ended = await Promise.race([channel.exited, new Promise(resolve => setTimeout(resolve, 15_000, 'stuck'))]);
    if (ended === 'stuck') { try { process.kill(channel.holderPid); } catch { /* gone */ } }
  }
  for (const helper of helpers.splice(0)) { try { helper.kill(); } catch { /* gone */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vonvon-supervisor-test-'));
  dirs.push(dir);
  return dir;
}

async function start(options: Partial<WindowsSupervisorOptions> = {}) {
  const dir = tempDir();
  const jobName = options.jobName ?? `Local\\vonvon-test-${randomUUID()}`;
  const logPath = join(dir, 'supervisor.log');
  const channel = await spawnWindowsSupervisor({ jobName, logPath, ...options });
  channels.push(channel);
  const stdout: Buffer[] = [];
  let stdoutEnded = false;
  channel.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  channel.stdout.once('end', () => { stdoutEnded = true; });
  return { channel, jobName, dir, logPath, ...recordReceipts(channel, logPath), out: () => Buffer.concat(stdout).toString(), outEnded: () => stdoutEnded };
}

const launch = (file: string, args: string[], extra: Partial<Extract<HolderCommand, { command: 'launch' }>> = {}): HolderCommand =>
  ({ command: 'launch', nonce: 'l1', file, args: [windowsCommandLine(file, args, { shim: false })], env: ENV, ...extra });
const launchNode = (script: string, ...rest: string[]) => launch(NODE, ['-e', script, ...rest]);

/** A PowerShell helper process the test keeps alive; resolves once it wrote its marker file. */
async function helperProcess(script: string, marker: string): Promise<ChildProcess> {
  const file = join(tempDir(), 'helper.ps1');
  writeFileSync(file, script, 'utf8');
  const child = spawn(POWERSHELL, psArgs(file), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  helpers.push(child);
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  await until(() => existsSync(marker) || child.exitCode !== null, `helper marker ${marker}`, 60_000);
  if (!existsSync(marker)) throw new Error(`helper exited ${child.exitCode}: ${stderr}`);
  return child;
}

async function probeUntilEmpty(s: Awaited<ReturnType<typeof start>>): Promise<void> {
  for (let i = 0; i < 250; i++) {
    s.channel.send({ command: 'probe', nonce: `p${i}` });
    const answer = await s.takeAny(['empty', 'live', 'probe-unknown']);
    if (answer.kind === 'empty') return;
    if (answer.kind === 'probe-unknown') throw new Error(`probe-unknown ${answer.errno}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Job never emptied; ${s.context()}`);
}

describe.skipIf(process.platform !== 'win32')('the Windows supervisor', () => {
  it('authenticates: hello carries its pid, session, and creation FILETIME, and a later connection is refused', async () => {
    const pipeName = newPipeName();
    const s = await start({ pipeName });
    expect(s.channel.platform).toBe('win32');
    expect(s.channel.holderPid).toBeGreaterThan(0);
    expect(s.channel.osSession).toBeTypeOf('number');
    expect(s.channel.start).toMatch(/^win32:\d+$/);
    const refused = await new Promise<string>(resolve => {
      const late = connect(pipeName);
      late.once('error', error => resolve((error as NodeJS.ErrnoException).code ?? 'error'));
      late.once('connect', () => { late.destroy(); resolve('connected'); });
    });
    expect(refused).not.toBe('connected');
  }, 120_000);

  it('rejects a wrong token on the first connection, and the supervisor never gets to launch', async () => {
    const pipeName = newPipeName();
    const dir = tempDir();
    const spawning = spawnWindowsSupervisor({ pipeName, jobName: `Local\\vonvon-test-${randomUUID()}`, logPath: join(dir, 'log') });
    const impostor = connect(pipeName, () => impostor.write(`hello ${'0'.repeat(64)} 1 1 1\n`));
    impostor.on('error', () => { /* destroyed by the daemon */ });
    await expect(spawning).rejects.toThrow(/wrong token/);
    impostor.destroy();
  }, 120_000);

  it('round-trips tricky argv through the command line, streams provider stdout to EOF, and reports provider-exit 0 -', async () => {
    const s = await start();
    const argv = ['has space', 'say "hi"', 'back\\"slash', 'trailing\\', '', '& | < > ^ % !', 'C:\\dir\\'];
    s.channel.send({ command: 'probe', nonce: 'p0' });
    expect(await s.take('refused')).toEqual({ kind: 'refused', command: 'probe', nonce: 'p0', reason: 'not-launched' });
    s.channel.send(launchNode(`process.stdout.write(JSON.stringify(process.argv.slice(1)))`, ...argv));
    const ready = await s.take('ready');
    expect(ready).toMatchObject({ nonce: 'l1' });
    expect(ready.pid).toBeGreaterThan(0);
    expect(await s.take('provider-exit')).toEqual({ kind: 'provider-exit', code: 0, signal: null });
    await until(s.outEnded, 'provider stdout EOF');
    expect(JSON.parse(s.out())).toEqual(argv);
    s.channel.send({ command: 'reap', nonce: 'r1' });
    expect(await s.take('reaped')).toEqual({ kind: 'reaped', nonce: 'r1' });
    await probeUntilEmpty(s);
    s.channel.send({ command: 'exit', nonce: 'x1' });
    expect(await s.channel.exited).toEqual({ code: 0, signal: null });
  }, 120_000);

  it('reports the provider\'s own exit code', async () => {
    const s = await start();
    s.channel.send(launchNode('process.exit(7)'));
    await s.take('ready');
    expect(await s.take('provider-exit')).toEqual({ kind: 'provider-exit', code: 7, signal: null });
  }, 120_000);

  it('term is accepted and does nothing; kill ends a TERM-ignoring tree with a grandchild; reap and probe follow the contract', async () => {
    const s = await start();
    s.channel.send(launchNode(TREE_STAY));
    const ready = await s.take('ready');
    await until(() => /gc \d+\n/.test(s.out()), 'the grandchild pid');
    const grandchild = Number(/gc (\d+)/.exec(s.out())?.[1]);
    s.channel.send({ command: 'reap', nonce: 'r0' });
    expect(await s.take('not-ready')).toEqual({ kind: 'not-ready', nonce: 'r0' });
    s.channel.send({ ...launchNode('0'), nonce: 'l2' });
    expect(await s.take('refused')).toEqual({ kind: 'refused', command: 'launch', nonce: 'l2', reason: 'already-created' });
    s.channel.send({ command: 'term', nonce: 't1' });
    const accepted = await s.take('accepted');
    expect(validateSignalReceipt({ command: 'term', nonce: 't1' }, accepted, 'win32')).toBe('accepted');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(s.peek('provider-exit')).toEqual([]);
    expect(alive(ready.pid ?? 0)).toBe(true);
    s.channel.send({ command: 'kill', nonce: 'k1' });
    const sent = await s.take('sent');
    expect(validateSignalReceipt({ command: 'kill', nonce: 'k1' }, sent, 'win32')).toBe('sent');
    expect(await s.take('provider-exit')).toEqual({ kind: 'provider-exit', code: 1, signal: null });
    await probeUntilEmpty(s);
    await until(() => !alive(grandchild), 'grandchild death');
    s.channel.send({ command: 'reap', nonce: 'r1' });
    expect(await s.take('reaped')).toEqual({ kind: 'reaped', nonce: 'r1' });
    s.channel.send({ command: 'kill', nonce: 'k2' });
    expect(await s.take('refused')).toEqual({ kind: 'refused', command: 'kill', nonce: 'k2', reason: 'reaped' });
  }, 120_000);

  it('keeps a grandchild that asks for breakaway inside the Job, and the kill rung drains it', async () => {
    const s = await start();
    const dir = tempDir();
    const result = join(dir, 'result');
    const script = join(dir, 'breakaway.ps1');
    writeFileSync(script, [
      "$ErrorActionPreference='Stop'",
      `Add-Type -TypeDefinition ${literal(BREAKAWAY_SOURCE)}`,
      `[IO.File]::WriteAllText(${literal(result + '.tmp')}, [Breakaway]::Try(${literal(NODE)}, ${literal(`"${NODE}" -e "setInterval(()=>{},1000)"`)}, ${literal(s.jobName)}))`,
      `[IO.File]::Move(${literal(result + '.tmp')}, ${literal(result)})`,
      'Start-Sleep -Seconds 600',
    ].join('\n'), 'utf8');
    s.channel.send(launch(POWERSHELL, psArgs(script)));
    await s.take('ready');
    await until(() => existsSync(result), 'the breakaway probe result', 60_000);
    const outcome = readFileSync(result, 'utf8');
    expect(outcome, 'the probe runs inside the Job, and a breakaway request is refused or stays a Job member').toMatch(/^caller in (error 5|created [1-9]\d* in)$/);
    const created = / created ([1-9]\d*) /.exec(outcome);
    s.channel.send({ command: 'kill', nonce: 'k1' });
    expect(await s.take('sent')).toMatchObject({ rung: 'kill' });
    await s.take('provider-exit');
    await probeUntilEmpty(s);
    if (created) await until(() => !alive(Number(created[1])), 'the breakaway grandchild ended with the Job');
  }, 180_000);

  it('refuses a Job name that already exists with job-collision and exits 11 without touching the foreign Job', async () => {
    const jobName = `Local\\vonvon-test-${randomUUID()}`;
    const marker = join(tempDir(), 'held');
    await helperProcess([
      "$ErrorActionPreference='Stop'",
      `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class J { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a, string n); }'`,
      `$h = [J]::CreateJobObject([IntPtr]::Zero, ${literal(jobName)})`,
      'if ($h -eq [IntPtr]::Zero) { exit 1 }',
      `[IO.File]::WriteAllText(${literal(marker)}, 'held')`,
      'Start-Sleep -Seconds 600',
    ].join('\n'), marker);
    const s = await start({ jobName });
    s.channel.send(launchNode('0'));
    expect(await s.take('job-collision')).toEqual({ kind: 'job-collision', nonce: 'l1' });
    expect(await s.channel.exited).toEqual({ code: 11, signal: null });
    expect(s.peek('ready')).toEqual([]);
  }, 120_000);

  it('on daemon death after launch, ends the tree itself and exits 0', async () => {
    const s = await start();
    s.channel.send(launchNode(TREE_STAY));
    const ready = await s.take('ready');
    await until(() => /gc \d+\n/.test(s.out()), 'the grandchild pid');
    const grandchild = Number(/gc (\d+)/.exec(s.out())?.[1]);
    s.channel.close();
    expect(await s.channel.exited).toEqual({ code: 0, signal: null });
    expect(alive(ready.pid ?? 0)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  }, 120_000);

  it('abandon before launch exits 10, and so does EOF before launch', async () => {
    const first = await start();
    first.channel.send({ command: 'abandon', nonce: 'a1' });
    expect(await first.channel.exited).toEqual({ code: 10, signal: null });
    const second = await start();
    second.channel.close();
    expect(await second.channel.exited).toEqual({ code: 10, signal: null });
  }, 120_000);

  it('reports launch-failed with the Win32 error and exits 11 when the executable does not exist', async () => {
    const s = await start();
    const missing = 'C:\\vonvon-missing\\nope.exe';
    s.channel.send(launch(missing, []));
    expect(await s.take('launch-failed')).toEqual({ kind: 'launch-failed', nonce: 'l1', errno: 2 });
    expect(await s.channel.exited).toEqual({ code: 11, signal: null });
    expect(s.peek('ready')).toEqual([]);
  }, 120_000);
});

const BREAKAWAY_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Breakaway {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint size; public string reserved,desktop,title; public uint x,y,xsize,ysize,xchars,ychars,fill,flags;
    public ushort show,reservedSize; public IntPtr reservedData,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder args,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32.dll", EntryPoint="OpenJobObjectW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Member(IntPtr process,IntPtr job) {
    bool member;
    return IsProcessInJob(process,job,out member) ? (member ? "in" : "out") : "query-error-"+Marshal.GetLastWin32Error();
  }
  public static string Try(string app,string line,string name) {
    const uint JOB_OBJECT_QUERY=0x0004, CREATE_BREAKAWAY_FROM_JOB=0x01000000, CREATE_NO_WINDOW=0x08000000;
    IntPtr job=OpenJobObject(JOB_OBJECT_QUERY,false,name);
    if(job==IntPtr.Zero) return "open-error "+Marshal.GetLastWin32Error();
    var child=new ProcessInfo();
    try {
      string caller=Member(GetCurrentProcess(),job);
      var startup=new Startup(); startup.size=(uint)Marshal.SizeOf(typeof(Startup));
      if(CreateProcess(app,new StringBuilder(line),IntPtr.Zero,IntPtr.Zero,false,CREATE_BREAKAWAY_FROM_JOB|CREATE_NO_WINDOW,IntPtr.Zero,null,ref startup,out child))
        return "caller "+caller+" created "+child.pid+" "+Member(child.process,job);
      return "caller "+caller+" error "+Marshal.GetLastWin32Error();
    } finally {
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      if(child.process!=IntPtr.Zero) CloseHandle(child.process);
      CloseHandle(job);
    }
  }
}`;
