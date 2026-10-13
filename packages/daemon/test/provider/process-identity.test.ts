import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostBootMs, readDarwin, readStartToken, startTokenFromFileTime } from '../../src/provider/process/identity';

const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }));
});

async function sleeper(): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  await once(child, 'spawn');
  if (child.pid === undefined) throw new Error('sleeper has no pid');
  return child as ChildProcess & { pid: number };
}

describe('readStartToken against real processes', () => {
  it('reads a live child the same way twice', async () => {
    const child = await sleeper();
    const token = await readStartToken(child.pid);
    expect(token).not.toBe('absent');
    expect(token).not.toBe('unreadable');
    expect(await readStartToken(child.pid)).toBe(token);
  }, 30_000);

  it.skipIf(process.platform !== 'darwin')('keeps the same token when the daemon timezone changes', async () => {
    const child = await sleeper();
    const timezone = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const token = await readStartToken(child.pid);
      expect(token).not.toBe('absent');
      expect(token).not.toBe('unreadable');
      process.env.TZ = 'America/Los_Angeles';
      expect(await readStartToken(child.pid)).toBe(token);
    } finally {
      if (timezone === undefined) delete process.env.TZ;
      else process.env.TZ = timezone;
    }
  });

  // Tokens are start marks with a clock resolution (Linux 10 ms ticks, macOS one second), so siblings born
  // inside one step may share a token; the contract compares tokens only for the same pid.
  it('tells apart a child born one resolution step later', async () => {
    const first = await sleeper();
    const token = await readStartToken(first.pid);
    await new Promise(resolve => setTimeout(resolve, process.platform === 'darwin' ? 1100 : 50));
    const second = await sleeper();
    expect(await readStartToken(second.pid)).not.toBe(token);
  }, 30_000);

  it('reads an exited and reaped child as absent', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    children.push(child);
    await once(child, 'exit');
    expect(await readStartToken(child.pid!)).toBe('absent');
  }, 30_000);

  it.skipIf(process.platform !== 'linux')('reads a Linux process whose name holds spaces and parentheses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vonvon-comm-'));
    try {
      const odd = join(dir, 'a) 1 2 (b');
      symlinkSync(process.execPath, odd);
      const child = spawn(odd, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      children.push(child);
      await once(child, 'spawn');
      const control = await sleeper();
      const [token, reference] = await Promise.all([readStartToken(child.pid!), readStartToken(control.pid)]);
      expect(token).toMatch(/^linux:[0-9a-f-]+:\d+$/);
      expect(Number(String(token).split(':')[2])).toBeCloseTo(Number(String(reference).split(':')[2]), -2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('equals the creation FILETIME a Windows child prints for itself', async () => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::Out.WriteLine([Diagnostics.Process]::GetCurrentProcess().StartTime.ToFileTimeUtc()); Start-Sleep -Seconds 60'], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    let printed = '';
    child.stdout!.setEncoding('utf8');
    for await (const chunk of child.stdout!) {
      printed += chunk;
      if (printed.includes('\n')) break;
    }
    expect(await readStartToken(child.pid!)).toBe(startTokenFromFileTime(printed.trim()));
  }, 60_000);
});

describe.skipIf(process.platform === 'win32')('the macOS reader against a scripted ps', () => {
  let dir: string;
  let path: string | undefined;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vonvon-ps-')); path = process.env.PATH; });
  afterEach(() => { process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); });
  function fakePs(script: string): void {
    writeFileSync(join(dir, 'ps'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, 'ps'), 0o755);
    process.env.PATH = `${dir}:${path}`;
  }

  it('reads a ps failure on a live pid as unreadable, never absent', async () => {
    const child = await sleeper();
    fakePs("echo 'simulated ps operational failure' >&2; exit 1");
    expect(await readDarwin(child.pid)).toBe('unreadable');
    fakePs('exit 1');
    expect(await readDarwin(child.pid)).toBe('unreadable');
  });

  it('reads absent only when the kernel has no such pid', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    children.push(child);
    await once(child, 'exit');
    fakePs('exit 1');
    expect(await readDarwin(child.pid!)).toBe('absent');
  });

  it('turns lstart output into a token and output on stderr into unreadable', async () => {
    const child = await sleeper();
    fakePs("echo 'Tue Oct 13 20:26:47 2026'");
    expect(await readDarwin(child.pid)).toBe('darwin:Tue Oct 13 20:26:47 2026');
    fakePs("echo 'Tue Oct 13 20:26:47 2026'; echo warning >&2");
    expect(await readDarwin(child.pid)).toBe('unreadable');
  });
});

describe('host boot time', () => {
  it('lies before this process started and stays put between reads', () => {
    const first = hostBootMs();
    expect(first).toBeLessThan(Date.now() - process.uptime() * 1000);
    expect(Math.abs(hostBootMs() - first)).toBeLessThan(1000);
  });
});
