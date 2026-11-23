import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { PROTOCOL_VERSION } from '@vonvon/protocol';
import { AttachError } from '../src/attach.js';
import { createDaemonDependencies, prepareDesktopRoot } from '../src/daemon-dependencies.js';
import type { Registration } from '../src/daemon-manager.js';
import { planStartupRepair } from '../src/login-item.js';
import { isPidLockOwnerRunning, readRunningPidLock } from '../../daemon/src/server/pid-lock.js';
import { verifyPidLockOwner } from '../../daemon/src/server/owner-verification.js';
import { toolDirectories } from '../../daemon/src/platform/tool-path.js';
import { renderDefinition } from '../../daemon/src/service/definitions.js';
import { serviceTarget, type CanonicalRoot } from '../../daemon/src/service/identity.js';

const attach = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));
vi.mock('../../daemon/src/server/pid-lock.js', () => ({ readRunningPidLock: vi.fn(), isPidLockOwnerRunning: vi.fn() }));
vi.mock('../../daemon/src/server/owner-verification.js', () => ({ verifyPidLockOwner: vi.fn() }));
vi.mock('../src/attach.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/attach.js')>(), attachExisting: attach }));

const roots: string[] = [];
const owner = { pid: 12345, startedAt: '2026-10-11T00:00:00.000Z', listen: '127.0.0.1:54321' };
const dependencies = () => createDaemonDependencies({ root: '/owned/data', home: '/owned/home', resources: '/owned/resources', executable: '/owned/Electron', packaged: false });

async function packagedDependencies() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-launch-')));
  roots.push(root);
  const resources = join(root, 'resources');
  const files: Array<[string, string]> = [
    ['daemon/package.json', JSON.stringify({ name: '@vonvon/daemon', bin: { vonvon: 'bin/vonvon.mjs' } })],
    ['daemon/bin/vonvon.mjs', ''],
    ['daemon/dist/cli.js', ''],
    ['app.asar/package.json', JSON.stringify({ name: 'vonvon-bot-desktop', main: 'desktop/main.cjs' })],
    ['app.asar/desktop/main.cjs', ''],
  ];
  for (const [file, content] of files) {
    const path = join(resources, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return { resources, dependencies: createDaemonDependencies({ root, home: root, resources, executable: '/owned/Electron', packaged: true }) };
}

afterEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('desktop daemon dependencies', () => {
  it('Preview ignores a prior service registration and refuses managed startup before spawning', async () => {
    const preview = createDaemonDependencies({ root: '/owned/preview', home: '/owned/home', resources: '/owned/resources', executable: '/owned/Electron', packaged: true, allowRegisteredService: false });
    await expect(preview.readRegistration()).resolves.toEqual({ kind: 'absent' });
    await expect(preview.startManaged(0)).rejects.toThrow('预览版不启动登录服务');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runs the bundled daemon without a service registration on Windows', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
    try {
      await expect(dependencies().readRegistration()).resolves.toEqual({ kind: 'absent' });
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  it('s18g ownerRunning asks only whether the old process is alive', async () => {
    vi.mocked(isPidLockOwnerRunning).mockReturnValue(true);
    const previous = { pid: 12345, startedAt: owner.startedAt };
    await expect(dependencies().ownerRunning(previous)).resolves.toBe(true);
    expect(isPidLockOwnerRunning).toHaveBeenCalledExactlyOnceWith({ ...previous, listen: null });
    expect(readRunningPidLock).not.toHaveBeenCalled();
    vi.mocked(isPidLockOwnerRunning).mockReturnValue(false);
    await expect(dependencies().ownerRunning(previous)).resolves.toBe(false);
  });

  it('s18g ownerRunning uses real process liveness without a PID lock file', async () => {
    const actual = await vi.importActual<typeof import('../../daemon/src/server/pid-lock.js')>('../../daemon/src/server/pid-lock.js');
    vi.mocked(isPidLockOwnerRunning).mockImplementation(actual.isPidLockOwnerRunning);
    await expect(dependencies().ownerRunning({ pid: process.pid, startedAt: new Date().toISOString() })).resolves.toBe(true);
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.pid).toBeTypeOf('number');
    await expect(dependencies().ownerRunning({ pid: child.pid!, startedAt: new Date().toISOString() })).resolves.toBe(false);
    expect(readRunningPidLock).not.toHaveBeenCalled();
  });

  it('creates a fresh private root and refuses a symlink root', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'desktop-root-')));
    roots.push(parent);
    const path = join(parent, 'data');
    expect(await prepareDesktopRoot({ kind: 'fresh', path })).toBe(path);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o700);
    const alias = join(parent, 'alias');
    await symlink(path, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(prepareDesktopRoot({ kind: 'canonical', path: alias })).rejects.toThrow('必须是真实目录');
  });

  it('never turns failed owner authentication into an absent owner', async () => {
    vi.mocked(readRunningPidLock).mockResolvedValue(owner);
    vi.mocked(verifyPidLockOwner).mockRejectedValue(new Error('protocol mismatch'));
    await expect(dependencies().readVerifiedDaemon()).rejects.toThrow('先别关它');
  });

  it('authenticates a published lock before returning it', async () => {
    vi.mocked(readRunningPidLock).mockResolvedValue(owner);
    await expect(dependencies().readVerifiedDaemon()).resolves.toEqual(owner);
    expect(verifyPidLockOwner).toHaveBeenCalledExactlyOnceWith('/owned/data', owner);
  });

  it('passes the lock\'s daemon version on for the startup repair', async () => {
    vi.mocked(readRunningPidLock).mockResolvedValue({ ...owner, version: '0.2.0' });
    await expect(dependencies().readVerifiedDaemon()).resolves.toEqual({ ...owner, version: '0.2.0' });
  });

  it.skipIf(process.platform === 'win32')('returns what an installed definition starts, and why one is unrecognized', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-registration-')));
    roots.push(root);
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const target = platform === 'darwin' ? serviceTarget({ platform, home: root, root })
      : serviceTarget({ platform, home: root, root, xdgConfigHome: undefined });
    const file = target.platform === 'darwin' ? target.plistPath : target.unitPath;
    const distribution = { kind: 'desktop' as const, executable: '/Applications/Vonvon Bot.app/Contents/MacOS/Vonvon Bot',
      entry: '/Applications/Vonvon Bot.app/Contents/Resources/daemon/bin/vonvon.mjs' };
    const rendered = renderDefinition({ target, root: root as CanonicalRoot, port: 4321, distribution, capturedPath: '/usr/bin:/bin' });
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, rendered.platform === 'darwin' ? rendered.plist : rendered.unit);
    const read = createDaemonDependencies({ root, home: root, resources: '/owned/resources', executable: '/owned/Electron', packaged: true });
    await expect(read.readRegistration()).resolves.toEqual({ kind: 'ours', definition: { ...distribution, port: 4321 } });
    // The startup repair rewrites an older format but leaves a symlink alone; both come from the daemon's real refusal.
    const plan = (registration: Registration) => planStartupRepair({ platform: 'darwin', packaged: true, executable: distribution.executable,
      registration, running: null, bundledVersion: '0.2.0', exists: () => true });
    await writeFile(file, 'an older format');
    const older = await read.readRegistration();
    expect(older).toEqual({ kind: 'unrecognized', file, replaceable: true });
    expect(plan(older)).toBe('reinstall');
    await rm(file);
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), file);
    const linked = await read.readRegistration();
    expect(linked).toEqual({ kind: 'unrecognized', file, replaceable: false });
    expect(plan(linked)).toBe('none');
  });

  it('checks the attached identity and closes the probe', async () => {
    const dispose = vi.fn(async () => {});
    attach.mockResolvedValue({ identity: owner, dispose });
    await expect(dependencies().checkProtocol(owner)).resolves.toBe(PROTOCOL_VERSION);
    await expect(dependencies().checkProtocol({ ...owner, pid: owner.pid + 1 })).rejects.toThrow('后台的所有者变了');
    expect(dispose).toHaveBeenCalledTimes(2);
  });
  // devices 4.5: a daemon of another protocol answers with its version, so the manager's message names both (it said "start the daemon")
  it('answers the version of a daemon that runs another protocol', async () => {
    attach.mockRejectedValueOnce(new AttachError('protocol', undefined, 1));
    await expect(dependencies().checkProtocol(owner)).resolves.toBe(1);
    attach.mockRejectedValueOnce(new AttachError('connection'));
    await expect(dependencies().checkProtocol(owner)).rejects.toMatchObject({ reason: 'connection' });
  });

  it('refuses a development runtime instead of spawning a global CLI', async () => {
    await expect(dependencies().startBundled(0)).rejects.toThrow('打包的 Vonvon 后台服务不可用');
  });

  it('returns the selected child PID and forwards the exact Bot as one argument', async () => {
    const { resources, dependencies } = await packagedDependencies();
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 9876 });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    await expect(dependencies.startSelectedBot(0, 'exact Bot; ID')).resolves.toBe(9876);
    expect(spawn).toHaveBeenCalledExactlyOnceWith('/owned/Electron', [
      join(resources, 'daemon', 'bin', 'vonvon.mjs'), 'daemon', 'run', '--port', '0', '--bot', 'exact Bot; ID',
    ], expect.objectContaining({ detached: true, windowsHide: true }));
  });

  it('gives the daemon the tool directories a Finder launch lacks, in Node mode', async () => {
    vi.stubEnv('PATH', ['/usr/bin', '/bin'].join(delimiter));
    const { resources, dependencies } = await packagedDependencies();
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 9876 });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    await dependencies.startSelectedBot(0, 'Bot');
    const env = vi.mocked(spawn).mock.calls[0]?.[2]?.env;
    expect(env?.PATH).toBe(['/usr/bin', '/bin', ...toolDirectories(dirname(resources))].join(delimiter));
    expect(env?.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('does not confirm a selected launch when the spawn event has no child PID', async () => {
    const { dependencies } = await packagedDependencies();
    vi.mocked(spawn).mockImplementation(() => {
      const child = new ChildProcess();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    await expect(dependencies.startSelectedBot(0, 'cli_selected')).rejects.toThrow('没有返回进程号');
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('preserves selected launch errors without reporting a PID', async () => {
    const { dependencies } = await packagedDependencies();
    vi.mocked(spawn).mockImplementation(() => {
      const child = new ChildProcess();
      queueMicrotask(() => child.emit('error', new Error('spawn denied')));
      return child;
    });
    await expect(dependencies.startSelectedBot(0, 'cli_selected')).rejects.toThrow('spawn denied');
    expect(spawn).toHaveBeenCalledOnce();
  });
});
