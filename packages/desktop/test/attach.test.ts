import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  readRunning: vi.fn(),
  current: vi.fn(),
  running: vi.fn(),
  verify: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('../../daemon/src/server/pid-lock.js', () => ({
  readRunningPidLock: fake.readRunning,
  getPidLockInfo: fake.current,
  isPidLockOwnerRunning: fake.running,
}));
vi.mock('../../daemon/src/server/owner-verification.js', () => ({ verifyPidLockOwner: fake.verify }));
vi.mock('@vonvon/client/browser', () => ({ connectBrowser: fake.connect }));

import { attachExisting, AttachError } from '../src/attach.js';

const identity = { pid: 4321, startedAt: '2026-10-11T00:00:00.000Z', listen: '127.0.0.1:42345' };
const credential = 'a'.repeat(64);
const serverInfo = { type: 'serverInfo', machineId: '00000000-0000-4000-8000-000000000000', version: '0.9.0', protocolVersion: 2, deviceName: 'mac', platform: 'macos', capabilities: ['device'], principal: 'owner:local' };
let root: string;
let close: ReturnType<typeof vi.fn>;
let admin: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'vonvon-attach-')));
  await writeFile(join(root, 'local-credential'), `${credential}\n`);
  close = vi.fn(async () => {});
  admin = vi.fn(async () => ({ kind: 'daemonStatus', status: { running: true, pid: identity.pid } }));
  fake.readRunning.mockReset().mockResolvedValue(identity);
  fake.current.mockReset().mockResolvedValue(identity);
  fake.running.mockReset().mockReturnValue(true);
  fake.verify.mockReset().mockResolvedValue(undefined);
  fake.connect.mockReset().mockResolvedValue({ client: { admin, close }, serverInfo });
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('read-only desktop attachment', () => {
  it('verifies the owner, connects as desktop, checks status on that connection, and closes once', async () => {
    const attached = await attachExisting(root);
    expect(fake.verify).toHaveBeenCalledExactlyOnceWith(root, identity);
    expect(fake.connect).toHaveBeenCalledExactlyOnceWith({ url: `ws://${identity.listen}`, credential, clientKind: 'desktop' });
    expect(admin).toHaveBeenCalledExactlyOnceWith({ type: 'daemonStatus' });
    expect(attached.identity).toEqual(identity);
    expect(attached.serverInfo).toEqual(serverInfo);
    await Promise.all([attached.dispose(), attached.dispose()]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('rereads the listener and credential when attaching again after a restart', async () => {
    const first = await attachExisting(root);
    await first.dispose();
    const successor = { ...identity, pid: 4322, startedAt: 'later', listen: '127.0.0.1:43567' };
    const rotated = 'b'.repeat(64);
    await writeFile(join(root, 'local-credential'), rotated);
    fake.readRunning.mockResolvedValue(successor);
    fake.current.mockResolvedValue(successor);
    admin.mockResolvedValue({ kind: 'daemonStatus', status: { running: true, pid: successor.pid } });
    const next = await attachExisting(root);
    expect(fake.connect).toHaveBeenLastCalledWith({ url: `ws://${successor.listen}`, credential: rotated, clientKind: 'desktop' });
    expect(next.identity).toEqual(successor);
    await next.dispose();
  });

  it('refuses a missing or invalid owner before reading the credential or connecting', async () => {
    fake.readRunning.mockResolvedValue(null);
    await expect(attachExisting(root)).rejects.toMatchObject({ reason: 'owner' });
    fake.readRunning.mockResolvedValue({ ...identity, listen: '0.0.0.0:42345' });
    await expect(attachExisting(root)).rejects.toMatchObject({ reason: 'owner' });
    expect(fake.verify).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it('refuses a noncanonical root without owner verification', async () => {
    await expect(attachExisting(`${root}/.`)).rejects.toBeInstanceOf(AttachError);
    expect(fake.readRunning).not.toHaveBeenCalled();
  });

  it('does not create a missing credential or expose its read error', async () => {
    await rm(join(root, 'local-credential'));
    await expect(attachExisting(root)).rejects.toMatchObject({ reason: 'credential', message: '本机 daemon 凭据不可用。' });
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it('rejects status or lock incarnation mismatch and physically closes the candidate', async () => {
    admin.mockResolvedValueOnce({ kind: 'daemonStatus', status: { running: true, pid: 9999 } });
    await expect(attachExisting(root)).rejects.toMatchObject({ reason: 'identity' });
    expect(close).toHaveBeenCalledOnce();
    close.mockClear();
    fake.current.mockResolvedValue({ ...identity, startedAt: '2026-10-11T00:01:00.000Z' });
    await expect(attachExisting(root)).rejects.toMatchObject({ reason: 'identity' });
    expect(close).toHaveBeenCalledOnce();
  });

  // devices 4.5: until U2 lets it in for maintenance, a daemon of another protocol still fails the attach, so startup repairs as before
  it('refuses a daemon of another protocol and closes the candidate', async () => {
    fake.connect.mockResolvedValueOnce({ client: { admin, close }, serverInfo: { ...serverInfo, protocolVersion: 1 } });
    await expect(attachExisting(root)).rejects.toMatchObject({ reason: 'connection' });
    expect(admin).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps a physical close failure visible when rejecting an owner mismatch', async () => {
    fake.current.mockResolvedValue(null);
    const failure = new Error('physical close failed');
    close.mockRejectedValue(failure);
    await expect(attachExisting(root)).rejects.toMatchObject({ errors: [expect.any(AttachError), failure] });
    expect(close).toHaveBeenCalledOnce();
  });
});
