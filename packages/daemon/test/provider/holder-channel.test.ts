import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { channelOver, exitOf, spawnPosixHolder, type HolderChannel } from '../../src/provider/process/holder-channel';
import { validateSignalReceipt } from '../../src/provider/process/holder-protocol';
import { recordReceipts, until } from './channel-recorder';
import { compileHolder, type HolderBinary } from './native/holder-driver';

let binary: HolderBinary;
const channels: HolderChannel[] = [];
const dirs: string[] = [];

beforeAll(() => { binary = compileHolder(); });
afterAll(() => binary.dispose());
afterEach(async () => {
  for (const channel of channels.splice(0)) {
    try { process.kill(channel.holderPid, 'SIGKILL'); } catch { /* already gone */ }
    await channel.exited;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeHolder(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vonvon-fake-holder-'));
  dirs.push(dir);
  const file = join(dir, 'holder');
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe.skipIf(process.platform === 'win32')('spawnPosixHolder', () => {
  it('returns a channel once the real holder says hello, with its pid and a start token read for that pid', async () => {
    const channel = await spawnPosixHolder(binary.path);
    channels.push(channel);
    expect(channel.platform).toBe('posix');
    expect(channel.holderPid).toBeGreaterThan(1);
    expect(channel.osSession).toBeUndefined();
    if (process.platform === 'linux') expect(channel.start).toMatch(/^linux:[0-9a-f-]+:\d+$/);
  });

  it('drives launch, go, ready, provider stdout, a validated kill receipt, provider-exit, exit, and reports the holder gone', async () => {
    const channel = await spawnPosixHolder(binary.path);
    channels.push(channel);
    const receipts = recordReceipts(channel);
    const chunks: Buffer[] = [];
    channel.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    expect(channel.send({ command: 'launch', nonce: 'l1', file: process.execPath, args: ['-e', `process.on('SIGTERM', () => {}); process.stdout.write('armed'); setInterval(() => {}, 1000)`], env: {} })).toBe(true);
    const created = await receipts.take('created');
    channel.send({ command: 'go', nonce: 'g1' });
    expect(await receipts.take('ready')).toEqual({ kind: 'ready', nonce: 'l1' });
    await until(() => Buffer.concat(chunks).toString() === 'armed', 'provider stdout on the channel');
    channel.send({ command: 'kill', nonce: 'k1' });
    const sent = await receipts.take('sent');
    expect(validateSignalReceipt({ command: 'kill', nonce: 'k1' }, sent, 'posix')).toBe('sent');
    expect(validateSignalReceipt({ command: 'kill', nonce: 'k1' }, sent, 'win32')).toBe('sent');
    expect(await receipts.take('provider-exit')).toEqual({ kind: 'provider-exit', code: null, signal: 'SIGKILL' });
    channel.send({ command: 'reap', nonce: 'r1' });
    await receipts.take('reaped');
    channel.send({ command: 'exit', nonce: 'x1' });
    expect(await channel.exited).toEqual({ code: 0, signal: null });
    await channel.closed;
    expect(channel.send({ command: 'probe', nonce: 'p1' })).toBe(false);
    expect(() => process.kill(created.pid, 0)).toThrow();
  });

  it('close() is the daemon-death signal: an unlaunched holder exits 10 and the channel reports closed', async () => {
    const channel = await spawnPosixHolder(binary.path);
    channels.push(channel);
    channel.close();
    expect(await channel.exited).toEqual({ code: 10, signal: null });
    await channel.closed;
  });

  it('rejects a holder whose first line is not the hello and leaves no process behind', async () => {
    const fake = fakeHolder('printf "hello nope 1\\n" >&1; exec sleep 30');
    await expect(spawnPosixHolder(fake)).rejects.toThrow(/unexpected first receipt/);
    const silent = fakeHolder('exit 0');
    await expect(spawnPosixHolder(silent)).rejects.toThrow(/no hello \(eof\)/);
    const mute = fakeHolder('exec sleep 30');
    await expect(spawnPosixHolder(mute, { helloTimeoutMs: 300 })).rejects.toThrow(/no hello \(timeout\)/);
  });
});

describe('holder process lifecycle on every platform', () => {
  const missing = join(tmpdir(), 'vonvon-definitely-missing-holder', 'vonvon-holder');

  it.skipIf(process.platform === 'win32')('rejects a missing holder binary instead of crashing the daemon with an unhandled error', async () => {
    await expect(spawnPosixHolder(missing)).rejects.toThrow(/ENOENT/);
  });

  it('exitOf settles with no code when the spawn itself failed, so no caller waits forever', async () => {
    const child = spawn(missing, [], { stdio: 'ignore' });
    const result = await Promise.race([exitOf(child), new Promise(resolve => setTimeout(() => resolve('timeout'), 2000))]);
    expect(result).toEqual({ code: null, signal: null });
  });

  it('reports closed and refuses sends after close() destroys a real duplex socket, which emits close but never end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vonvon-channel-sock-'));
    dirs.push(dir);
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\vonvon-channel-${process.pid}-${Date.now()}` : join(dir, 'sock');
    const server = createServer();
    const accepted = once(server, 'connection') as Promise<[Socket]>;
    await new Promise<void>(resolve => server.listen(path, resolve));
    const socket = connect(path);
    await once(socket, 'connect');
    const [peer] = await accepted;
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const channel = channelOver({
        platform: 'win32', child, commands: socket, receipts: socket, close: () => socket.destroy(),
        stdio: { stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr! },
      });
      channel.close();
      const result = await Promise.race([channel.closed.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('timeout'), 2000))]);
      expect(result).toBe('closed');
      expect(channel.send({ command: 'probe', nonce: 'p1' })).toBe(false);
    } finally {
      child.kill('SIGKILL');
      peer.destroy();
      server.close();
    }
  });
});
