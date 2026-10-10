import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stopChild } from '../src/host/lifecycle';
import { readHostEndpoint } from '../src/host/discovery';
import { acquirePidLock, publishPidLock, releasePidLock } from '../src/server/pid-lock';

describe('Host child shutdown', () => {
  it('waits for delayed IPC cleanup after the shutdown request', async () => {
    const child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{}); process.on('message', m => { if(m.type==='bridge:shutdown') setTimeout(()=>process.exit(0),200); }); process.send('ready');`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise((resolve) => child.once('message', resolve));
    const start = Date.now();
    await stopChild(child, 2000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(180);
    expect(child.exitCode).toBe(0);
  });
  it('reports forced shutdown and waits for actual exit', async () => {
    const child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{}); process.on('message',()=>{}); process.send('ready');`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise((resolve) => child.once('message', resolve));
    await expect(stopChild(child, 30)).rejects.toThrow(/forced termination/);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
  it('retains a child cleanup failure across repeated stop attempts', async () => {
    const child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{}); process.on('message',()=>process.exit(1)); process.send('ready');`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      await new Promise((resolve) => child.once('message', resolve));
      await expect(stopChild(child, 1000)).rejects.toThrow(/code 1/);
      await expect(stopChild(child, 1000)).rejects.toThrow(/code 1/);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
  it('rejects unexpected signal exits', async () => {
    const child = spawn(process.execPath, ['-e', `process.on('message',()=>process.kill(process.pid,'SIGKILL')); process.on('SIGTERM',()=>{}); process.send('ready');`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      await new Promise((resolve) => child.once('message', resolve));
      await expect(stopChild(child, 1000)).rejects.toThrow(process.platform === 'win32' ? /code 1/ : /signal SIGKILL/);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
  it('refuses a live lock until its endpoint proves ownership', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vonvon-host-discovery-'));
    try {
      const owner = await acquirePidLock(home);
      expect(await readHostEndpoint(home, true)).toMatchObject({ kind: 'blocked', reason: 'busy' });
      await publishPidLock(home, owner, '127.0.0.1:49152');
      expect(await readHostEndpoint(home, true)).toMatchObject({ kind: 'blocked', reason: 'inspection-failed' });
      await publishPidLock(home, owner, '0.0.0.0:49152');
      expect(await readHostEndpoint(home, true)).toMatchObject({ kind: 'blocked', reason: 'inspection-failed' });
      await releasePidLock(home, owner);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
