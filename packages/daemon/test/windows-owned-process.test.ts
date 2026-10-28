import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeOwnedProviderProcesses, OwnedProviderProcess, ProviderProcessExitError } from '../src/agent/owned-process';

describe.runIf(process.platform === 'win32')('Windows provider cleanup', () => {
  it('accepts a completed version probe and preserves an unexpected exit failure', async () => {
    const success = new OwnedProviderProcess(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await success.exited;
    await expect(success.close()).resolves.toBeUndefined();
    const failure = new OwnedProviderProcess(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
    await failure.exited;
    await expect(failure.close()).rejects.toBeInstanceOf(ProviderProcessExitError);
  }, 30_000);

  it('kills descendants even after their direct parent has exited successfully', async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, windowsHide: true, stdio: 'ignore' });
      child.unref();
      console.log(child.pid);
      setTimeout(() => process.exit(0), 100);
    `;
    const owned = new OwnedProviderProcess(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    owned.child.stdout!.on('data', chunk => { output += String(chunk); });
    try {
      await owned.exited;
      const descendant = Number(output.trim());
      expect(descendant).toBeGreaterThan(0);
      expect(() => process.kill(descendant, 0)).not.toThrow();
      await owned.close();
      expect(() => process.kill(descendant, 0)).toThrow();
    } finally { await owned.close(); }
  }, 30_000);

  it('can close while the supervisor is still starting', async () => {
    const owned = new OwnedProviderProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await expect(owned.close()).resolves.toBeUndefined();
    expect(() => process.kill(owned.child.pid!, 0)).toThrow();
  }, 30_000);

  it('preserves cmd shim quoting, cwd, environment and output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vonvon-owned-shim-'));
    const shim = join(directory, 'probe.cmd');
    await writeFile(shim, `@"${process.execPath}" -e "process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),value:process.env.OWNED_TEST}))" %*\r\n`);
    const owned = new OwnedProviderProcess(shim, ['space value', 'a&b'], { cwd: directory, env: { ...process.env, OWNED_TEST: 'retained' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    owned.child.stdout!.on('data', chunk => { output += String(chunk); });
    try {
      await owned.exited;
      await owned.close();
      expect(JSON.parse(output)).toEqual({ args: ['space value', 'a&b'], cwd: directory, value: 'retained' });
    } finally { await owned.close(); await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it('closes the provider and its child without waiting on POSIX process groups', async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
      child.once('spawn', () => console.log(child.pid));
      setInterval(() => {}, 1000);
    `;
    const owned = new OwnedProviderProcess(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const [chunk] = await once(owned.child.stdout!, 'data');
      const descendant = Number(String(chunk).trim());
      expect(descendant).toBeGreaterThan(0);
      expect(() => process.kill(descendant, 0)).not.toThrow();
      await owned.close();
      expect(() => process.kill(owned.child.pid!, 0)).toThrow();
      expect(() => process.kill(descendant, 0)).toThrow();
    } finally {
      await owned.close();
    }
  }, 30_000);

  it('does not emit close or resolve cleanup before paused output is consumed', async () => {
    const owned = new OwnedProviderProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(8192)); process.stderr.write('y'.repeat(8192));"], { stdio: ['ignore', 'pipe', 'pipe'] });
    owned.child.stdout!.pause();
    owned.child.stderr!.pause();
    let closed = false;
    owned.child.on('close', () => { closed = true; });
    await owned.exited;
    let settled = false;
    const closing = owned.close().then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(closed).toBe(false);
    expect(settled).toBe(false);
    let stdout = '', stderr = '';
    owned.child.stdout!.on('data', chunk => { stdout += String(chunk); });
    owned.child.stderr!.on('data', chunk => { stderr += String(chunk); });
    owned.child.stdout!.resume();
    owned.child.stderr!.resume();
    await closing;
    expect(closed).toBe(true);
    expect(stdout).toBe('x'.repeat(8192));
    expect(stderr).toBe('y'.repeat(8192));
  }, 30_000);

  // Last: closing the registry stops admission for this module instance.
  it('reports launch failures once and retires failures that never created a provider', async () => {
    for (const [command, cwd, expected] of [
      [join(tmpdir(), 'vonvon-missing-executable.exe'), undefined, 'executable was not found'],
      [process.execPath, join(tmpdir(), `vonvon-missing-cwd-${process.pid}`), 'launch-failed'],
    ] as const) {
      const owned = new OwnedProviderProcess(command, ['-e', ''], { cwd, stdio: 'ignore' });
      const errors: Error[] = [];
      let closes = 0;
      owned.child.on('error', error => errors.push(error));
      const closed = new Promise<void>(resolve => owned.child.on('close', () => { closes++; resolve(); }));
      await expect(owned.exited).rejects.toThrow(expected);
      await expect(owned.close()).rejects.toThrow();
      await closed;
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain(expected);
      expect(closes).toBe(1);
    }
    await expect(closeOwnedProviderProcesses()).resolves.toBeUndefined();
  }, 30_000);
});
