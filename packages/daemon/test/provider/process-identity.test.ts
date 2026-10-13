import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostBootMs, readStartToken, startTokenFromFileTime } from '../../src/provider/process/identity';

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
  it('reads a live child the same way twice and tells a second child apart', async () => {
    const first = await sleeper();
    const token = await readStartToken(first.pid);
    expect(token).not.toBe('absent');
    expect(token).not.toBe('unreadable');
    expect(await readStartToken(first.pid)).toBe(token);
    // A token is a start mark (Linux clock ticks, macOS seconds), so the second child must be born later.
    await new Promise(resolve => setTimeout(resolve, 1100));
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

describe('host boot time', () => {
  it('lies before this process started and stays put between reads', () => {
    const first = hostBootMs();
    expect(first).toBeLessThan(Date.now() - process.uptime() * 1000);
    expect(Math.abs(hostBootMs() - first)).toBeLessThan(1000);
  });
});
