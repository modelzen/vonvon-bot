import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PidLockInfo } from '../src/server/pid-lock';
import type { Registration, WindowsRunObservation } from '../src/service/registration';

const files = vi.hoisted(() => ({ bytes: new Map<string, Buffer>(), events: [] as string[], failRename: '', failUnlink: '', failRead: false }));
vi.mock('node:fs/promises', () => ({
  realpath: vi.fn(async (path: string) => path),
  stat: vi.fn(async () => ({ isDirectory: () => true })),
  lstat: vi.fn(async (path: string) => {
    const bytes = files.bytes.get(path);
    if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { isFile: () => true, size: bytes.length, ino: 1, dev: 1, mtimeMs: 1 };
  }),
  readFile: vi.fn(async (path: string) => {
    const bytes = files.bytes.get(path);
    if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return bytes;
  }),
  mkdir: vi.fn(async () => { files.events.push('mkdir'); }),
  open: vi.fn(async (path: string) => {
    files.events.push(`open:${path}`);
    return {
      writeFile: async (content: Uint8Array) => { files.bytes.set(path, Buffer.from(content)); },
      sync: async () => { files.events.push(`sync:${path}`); },
      close: async () => {},
    };
  }),
  rename: vi.fn(async (from: string, to: string) => {
    files.events.push(`rename:${to}`);
    if (files.failRename === to) { files.failRename = ''; throw new Error('rename failed'); }
    const bytes = files.bytes.get(from);
    if (!bytes) throw new Error('temporary missing');
    files.bytes.set(to, bytes); files.bytes.delete(from);
  }),
  unlink: vi.fn(async (path: string) => {
    files.events.push(`unlink:${path}`);
    if (files.failUnlink === path) { files.failUnlink = ''; throw new Error('unlink failed'); }
    if (!files.bytes.delete(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }),
}));

import { createWindowsService } from '../src/service/windows';
import { decodeGeneratedDefinition, renderDefinition, type Definition } from '../src/service/definitions';
import { resolveServiceRoot, WINDOWS_RUN_KEY } from '../src/service/identity';

const rootPath = 'C:\\Vonvon fixture';
const cmdPath = `${rootPath}\\service\\vonvon-bot.cmd`;
const vbsPath = `${rootPath}\\service\\vonvon-bot.vbs`;
const target = { platform: 'win32', cmdPath, vbsPath } as const;
const originalOwner: PidLockInfo = { pid: 4321, startedAt: '2026-10-12T00:00:00.000Z', listen: '127.0.0.1:3210' };

async function setup(options: { installed?: boolean; owner?: PidLockInfo | null } = {}) {
  const root = await resolveServiceRoot(rootPath);
  const definition: Definition = { root, port: 3210, capturedPath: 'C:\\Windows', distribution: { kind: 'npm', executable: 'C:\\node.exe', entry: 'C:\\pkg\\bin\\vonvon.mjs' } };
  const rendered = renderDefinition({ target, ...definition });
  if (rendered.platform !== 'win32') throw new Error('Invalid fixture');
  let value: string | null = options.installed ? rendered.runValue : null;
  let owner: PidLockInfo | null = options.owner ?? null;
  let now = 0;
  if (options.installed) { files.bytes.set(cmdPath, Buffer.from(rendered.cmd)); files.bytes.set(vbsPath, Buffer.from(rendered.vbs)); }
  const readRun = vi.fn((): WindowsRunObservation => value === null ? { kind: 'absent' } : { kind: 'value', type: 'REG_SZ', value });
  const registration = vi.fn(async (): Promise<Registration> => {
    if (value === null) return { kind: 'absent' };
    const cmd = files.bytes.get(cmdPath); const vbs = files.bytes.get(vbsPath);
    if (!cmd || !vbs) return { kind: 'unrecognized', location: rootPath, reason: 'missing launcher' };
    try {
      const decoded = decodeGeneratedDefinition(target, { platform: 'win32', cmd, vbs, runValue: value });
      return { kind: 'ours', definition: { ...decoded, root } };
    } catch { return { kind: 'unrecognized', location: rootPath, reason: 'invalid launcher' }; }
  });
  const run = vi.fn((args: string[]) => {
    files.events.push(`reg:${args[0]}`);
    if (args[0] === 'delete') value = null;
    if (args[0] === 'add') value = args[args.indexOf('/d') + 1] ?? null;
    return { status: 0, stdout: '', stderr: '' };
  });
  const launch = vi.fn(async () => { files.events.push('launch'); owner = { ...originalOwner }; });
  const readOwner = vi.fn(async () => {
    if (files.failRead) throw new Error('lock read failed');
    return owner;
  });
  const verifyOwner = vi.fn(async () => {});
  const stopOwner = vi.fn(async () => { files.events.push('stop'); owner = null; });
  const distribution = vi.fn(async () => ({ kind: 'global-npm' as const, cliPath: definition.distribution.entry }));
  const service = createWindowsService({ root: rootPath }, {
    run, readRun, registration, launch, readOwner, verifyOwner, stopOwner, distribution,
    executable: definition.distribution.executable, capturedPath: definition.capturedPath,
    freePort: async () => 3210, now: () => now, pause: async ms => { now += ms; },
  });
  return { service, run, launch, readRun, readOwner, verifyOwner, stopOwner, distribution, registration, rendered,
    getRun: () => value, setOwner: (next: PidLockInfo | null) => { owner = next; } };
}

beforeEach(() => { files.bytes.clear(); files.events.length = 0; files.failRename = ''; files.failUnlink = ''; files.failRead = false; });
afterEach(() => { vi.clearAllMocks(); });

it('writes and fsyncs both launchers before Run registration, then verifies readiness', async () => {
  const f = await setup();
  expect((await f.service.install()).kind).toBe('installed');
  expect(f.run).toHaveBeenCalledWith(['query', WINDOWS_RUN_KEY]);
  expect(files.events.indexOf(`rename:${cmdPath}`)).toBeLessThan(files.events.indexOf('reg:add'));
  expect(files.events.indexOf(`rename:${vbsPath}`)).toBeLessThan(files.events.indexOf('reg:add'));
  expect(files.events.filter(event => event.startsWith('sync:'))).toHaveLength(2);
  expect(files.events.indexOf('reg:add')).toBeLessThan(files.events.indexOf('launch'));
  expect(f.verifyOwner).toHaveBeenCalledWith(rootPath, originalOwner);
  expect(f.getRun()).toBe(f.rendered.runValue);
});

it('keeps an identical stopped installation stopped and starts it only on explicit start', async () => {
  const f = await setup({ installed: true });
  expect((await f.service.install()).kind).toBe('already-installed');
  expect(f.launch).not.toHaveBeenCalled();
  expect(files.events).toEqual(['reg:query']);
  await expect(f.service.start()).resolves.toMatchObject({ pid: originalOwner.pid, port: 3210 });
  expect(f.launch).toHaveBeenCalledWith(vbsPath);
});

it('uses the authenticated self-hosted owner port over explicit input without launching or stopping it', async () => {
  const f = await setup({ owner: originalOwner });
  expect((await f.service.install({ port: 4321 })).kind).toBe('installed');
  expect(files.bytes.get(cmdPath)?.toString()).toContain('daemon run --port 3210');
  expect(f.verifyOwner).toHaveBeenCalledWith(rootPath, originalOwner);
  expect(f.launch).not.toHaveBeenCalled(); expect(f.stopOwner).not.toHaveBeenCalled();
});

it('honors the explicit install port when no owner runs', async () => {
  const f = await setup();
  f.launch.mockImplementation(async () => { f.setOwner({ ...originalOwner, listen: '127.0.0.1:4321' }); });
  expect((await f.service.install({ port: 4321 })).kind).toBe('installed');
  expect(files.bytes.get(cmdPath)?.toString()).toContain('daemon run --port 4321');
});

it('removes the first launcher when writing the second launcher fails before Run registration', async () => {
  const f = await setup();
  files.failRename = vbsPath;
  expect((await f.service.install()).kind).toBe('install_rolled_back');
  expect(files.events).toContain(`rename:${cmdPath}`);
  expect(files.events).toContain(`rename:${vbsPath}`);
  expect(files.events).not.toContain('reg:add');
  expect(files.bytes.size).toBe(0); expect(f.getRun()).toBeNull();
  expect(f.launch).not.toHaveBeenCalled(); expect(f.stopOwner).not.toHaveBeenCalled();
});

it('refuses a replacement with a live owner without touching files or registration', async () => {
  const f = await setup({ installed: true, owner: originalOwner });
  f.distribution.mockResolvedValue({ kind: 'global-npm', cliPath: 'C:\\new\\vonvon.mjs' });
  expect((await f.service.install()).kind).toBe('install_refused');
  expect(files.events).toEqual(['reg:query']);
  expect(f.getRun()).toBe(f.rendered.runValue);
});

it('refuses cross-root registration and invalid ports without writes', async () => {
  const f = await setup();
  const otherRoot = await resolveServiceRoot('C:\\other-root');
  f.registration.mockResolvedValueOnce({ kind: 'other-root', recordedRoot: otherRoot, definition: { root: otherRoot, port: 3210, capturedPath: 'C:\\Windows', distribution: { kind: 'npm', executable: 'C:\\node.exe', entry: 'C:\\pkg\\bin\\vonvon.mjs' } } });
  expect((await f.service.install()).kind).toBe('install_refused');
  f.registration.mockResolvedValueOnce({ kind: 'unrecognized', location: 'other.vbs', reason: 'foreign' });
  expect((await f.service.install()).kind).toBe('install_refused');
  expect((await f.service.install({ port: 0 })).kind).toBe('install_refused');
  expect(files.events).toEqual(['reg:query', 'reg:query', 'reg:query']);
  expect(f.launch).not.toHaveBeenCalled();
});

it('rolls back a partial launcher write and restores previous bytes without starting', async () => {
  const f = await setup({ installed: true });
  f.distribution.mockResolvedValue({ kind: 'global-npm', cliPath: 'C:\\new\\vonvon.mjs' });
  files.failRename = cmdPath;
  const result = await f.service.install();
  expect(result.kind).toBe('install_rolled_back');
  expect(files.bytes.get(cmdPath)).toEqual(Buffer.from(f.rendered.cmd));
  expect(files.bytes.get(vbsPath)).toEqual(Buffer.from(f.rendered.vbs));
  expect(f.getRun()).toBe(f.rendered.runValue);
  expect(f.launch).not.toHaveBeenCalled(); expect(f.stopOwner).not.toHaveBeenCalled();
});

it('retains a newly launched owner on rollback and reports install_incomplete', async () => {
  const f = await setup();
  f.verifyOwner.mockRejectedValue(new Error('authentication failed'));
  const result = await f.service.install();
  expect(result.kind).toBe('install_incomplete');
  expect(result.retained).toEqual({ pid: originalOwner.pid, startedAt: originalOwner.startedAt });
  expect(f.getRun()).toBeNull(); expect(files.bytes.size).toBe(0);
  expect(f.stopOwner).not.toHaveBeenCalled();
});

it('withdraws before stopping an all-owners uninstall, then removes launchers', async () => {
  const f = await setup({ installed: true, owner: originalOwner });
  expect((await f.service.uninstall()).kind).toBe('uninstalled');
  expect(files.events.indexOf('reg:delete')).toBeLessThan(files.events.indexOf('stop'));
  expect(files.events.indexOf('stop')).toBeLessThan(files.events.indexOf(`unlink:${cmdPath}`));
  expect(f.stopOwner).toHaveBeenCalledWith(rootPath, originalOwner);
  expect(f.getRun()).toBeNull(); expect(files.bytes.size).toBe(0);
});

it('never stops a lock owner when resuming absent registration with leftover files', async () => {
  const f = await setup({ owner: originalOwner });
  files.bytes.set(cmdPath, Buffer.from(f.rendered.cmd));
  files.bytes.set(vbsPath, Buffer.from(f.rendered.vbs));
  const result = await f.service.uninstall();
  expect(result.kind).toBe('uninstalled'); expect(result.retained?.pid).toBe(originalOwner.pid);
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  expect(files.bytes.size).toBe(0);
});

it('leaves registration withdrawn and files intact after an unconfirmed stop', async () => {
  const f = await setup({ installed: true, owner: originalOwner });
  f.stopOwner.mockRejectedValue(new Error('stop acknowledgment lost'));
  const result = await f.service.uninstall();
  expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('stop_unconfirmed');
  expect(f.getRun()).toBeNull(); expect(files.bytes.size).toBe(2);
  expect(f.stopOwner).toHaveBeenCalledOnce(); expect(files.events).toEqual(['reg:delete']);
});

it('restores launcher bytes and Run value after unload failure without relaunching', async () => {
  const f = await setup({ installed: true, owner: originalOwner });
  files.failUnlink = vbsPath;
  expect((await f.service.uninstall()).kind).toBe('uninstall_rolled_back');
  expect(f.getRun()).toBe(f.rendered.runValue);
  expect(files.bytes.get(cmdPath)).toEqual(Buffer.from(f.rendered.cmd));
  expect(files.bytes.get(vbsPath)).toEqual(Buffer.from(f.rendered.vbs));
  expect(f.launch).not.toHaveBeenCalled();
});

it('does not launch on registered port mismatch or after launcher failure', async () => {
  const f = await setup({ installed: true });
  await expect(f.service.start({ port: 4321 })).rejects.toThrow('Service uses port 3210');
  expect(f.launch).not.toHaveBeenCalled();
  f.launch.mockRejectedValue(new Error('wscript denied'));
  await expect(f.service.start()).rejects.toThrow('wscript denied');
  expect(f.launch).toHaveBeenCalledOnce();
});

it('refuses an unavailable Run manager without writing a launcher', async () => {
  const f = await setup();
  f.run.mockReturnValue({ status: 1, stdout: '', stderr: 'access denied' });
  expect((await f.service.install()).kind).toBe('install_refused');
  expect(files.bytes.size).toBe(0); expect(f.launch).not.toHaveBeenCalled();
});

it('rolls back a Run registration failure and converges on a later install', async () => {
  const f = await setup();
  const run = f.run.getMockImplementation();
  if (!run) throw new Error('Missing registry fixture');
  let failed = false;
  f.run.mockImplementation(args => {
    if (args[0] === 'add' && !failed) { failed = true; return { status: 1, stdout: '', stderr: 'write denied' }; }
    return run(args);
  });
  expect((await f.service.install()).kind).toBe('install_rolled_back');
  expect(files.bytes.size).toBe(0); expect(f.getRun()).toBeNull();
  expect((await f.service.install()).kind).toBe('installed');
});

it('rolls back a readiness timeout without starting or stopping any owner', async () => {
  const f = await setup();
  f.launch.mockImplementation(async () => {});
  expect((await f.service.install()).kind).toBe('install_rolled_back');
  expect(f.getRun()).toBeNull(); expect(files.bytes.size).toBe(0);
  expect(f.stopOwner).not.toHaveBeenCalled();
});

it('restores the kept registration after an uninstall drain read failure', async () => {
  const f = await setup({ installed: true });
  f.readOwner.mockRejectedValueOnce(new Error('lock read failed'));
  expect((await f.service.uninstall()).kind).toBe('uninstall_rolled_back');
  expect(f.getRun()).toBe(f.rendered.runValue);
  expect(files.bytes.get(cmdPath)).toEqual(Buffer.from(f.rendered.cmd));
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
});

it('restores the new definition after install rollback drain fails and reports incomplete', async () => {
  const f = await setup();
  f.launch.mockRejectedValue(new Error('launch failed'));
  f.readOwner.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('lock read failed'));
  const result = await f.service.install();
  expect(result.kind).toBe('install_incomplete');
  expect(f.getRun()).toBe(f.rendered.runValue);
  expect(files.bytes.get(cmdPath)).toEqual(Buffer.from(f.rendered.cmd));
  expect(f.stopOwner).not.toHaveBeenCalled();
});

it('restores previous definition after install rollback unload fails and reports incomplete', async () => {
  const f = await setup({ installed: true });
  f.distribution.mockResolvedValue({ kind: 'global-npm', cliPath: 'C:\\new\\vonvon.mjs' });
  f.launch.mockRejectedValue(new Error('launch failed'));
  files.failUnlink = vbsPath;
  const result = await f.service.install();
  expect(result.kind).toBe('install_incomplete');
  expect(f.getRun()).toBe(f.rendered.runValue);
  expect(files.bytes.get(cmdPath)).toEqual(Buffer.from(f.rendered.cmd));
  expect(f.stopOwner).not.toHaveBeenCalled();
});

it('keeps absent resumed uninstall incomplete on read or unlink failure, then converges', async () => {
  const f = await setup({ owner: originalOwner });
  files.bytes.set(cmdPath, Buffer.from(f.rendered.cmd));
  f.readOwner.mockRejectedValueOnce(new Error('lock read failed'));
  expect((await f.service.uninstall()).kind).toBe('uninstall_incomplete');
  expect(files.bytes.has(cmdPath)).toBe(true);
  files.failUnlink = cmdPath;
  expect((await f.service.uninstall()).kind).toBe('uninstall_incomplete');
  expect((await f.service.uninstall()).kind).toBe('uninstalled');
  expect((await f.service.uninstall()).kind).toBe('not-installed');
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
});

it('waits for an acknowledged all-owners drain without removing launchers early', async () => {
  const f = await setup({ installed: true, owner: originalOwner });
  let acknowledge: (() => void) | undefined;
  f.stopOwner.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  const result = f.service.uninstall();
  await vi.waitFor(() => expect(acknowledge).toBeDefined());
  expect(f.getRun()).toBeNull(); expect(files.bytes.size).toBe(2);
  f.setOwner(null); acknowledge?.();
  expect((await result).kind).toBe('uninstalled');
});
