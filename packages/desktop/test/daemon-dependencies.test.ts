import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@vonvon/protocol';
import { createDaemonDependencies, parseWindowsRunQuery, prepareDesktopRoot } from '../src/daemon-dependencies.js';
import { readRunningPidLock } from '../../daemon/src/server/pid-lock.js';
import { verifyPidLockOwner } from '../../daemon/src/server/owner-verification.js';

const attach = vi.hoisted(() => vi.fn());

vi.mock('../../daemon/src/server/pid-lock.js', () => ({ readRunningPidLock: vi.fn() }));
vi.mock('../../daemon/src/server/owner-verification.js', () => ({ verifyPidLockOwner: vi.fn() }));
vi.mock('../src/attach.js', () => ({ attachExisting: attach }));

const roots: string[] = [];
const owner = { pid: 12345, startedAt: '2026-10-11T00:00:00.000Z', listen: '127.0.0.1:54321' };
const dependencies = () => createDaemonDependencies({ root: '/owned/data', home: '/owned/home', resources: '/owned/resources', executable: '/owned/Electron', packaged: false });

afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('desktop daemon dependencies', () => {
  it('creates a fresh private root and refuses a symlink root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'desktop-root-'));
    roots.push(parent);
    const path = join(parent, 'data');
    expect(await prepareDesktopRoot({ kind: 'fresh', path })).toBe(path);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o700);
    const alias = join(parent, 'alias');
    await symlink(path, alias, 'dir');
    await expect(prepareDesktopRoot({ kind: 'canonical', path: alias })).rejects.toThrow('physical directory');
  });

  it('never turns failed owner authentication into an absent owner', async () => {
    vi.mocked(readRunningPidLock).mockResolvedValue(owner);
    vi.mocked(verifyPidLockOwner).mockRejectedValue(new Error('protocol mismatch'));
    await expect(dependencies().readVerifiedDaemon()).rejects.toThrow('Leave it running');
  });

  it('authenticates a published lock before returning it', async () => {
    vi.mocked(readRunningPidLock).mockResolvedValue(owner);
    await expect(dependencies().readVerifiedDaemon()).resolves.toEqual(owner);
    expect(verifyPidLockOwner).toHaveBeenCalledExactlyOnceWith('/owned/data', owner);
  });

  it('checks the attached identity and closes the probe', async () => {
    const dispose = vi.fn(async () => {});
    attach.mockResolvedValue({ identity: owner, dispose });
    await expect(dependencies().checkProtocol(owner)).resolves.toBe(PROTOCOL_VERSION);
    await expect(dependencies().checkProtocol({ ...owner, pid: owner.pid + 1 })).rejects.toThrow('owner changed');
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('refuses a development runtime instead of spawning a global CLI', async () => {
    await expect(dependencies().startBundled(0)).rejects.toThrow('packaged Vonvon daemon is unavailable');
  });

  it('requires an observed registry key before reporting absence', () => {
    const key = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    expect(parseWindowsRunQuery('')).toMatchObject({ kind: 'unavailable' });
    expect(parseWindowsRunQuery(key)).toEqual({ kind: 'absent' });
    expect(parseWindowsRunQuery(`${key}\r\n    Other    REG_SZ    unrelated`)).toEqual({ kind: 'absent' });
    expect(parseWindowsRunQuery(`${key}\r\n    Vonvon Bot    REG_SZ    wscript.exe //B "C:\\data\\service\\vonvon-bot.vbs"`)).toEqual({
      kind: 'value', type: 'REG_SZ', value: 'wscript.exe //B "C:\\data\\service\\vonvon-bot.vbs"',
    });
    expect(parseWindowsRunQuery(`${key}\r\n    Vonvon Bot    REG_BINARY    0102`)).toMatchObject({ kind: 'unavailable' });
  });
});
