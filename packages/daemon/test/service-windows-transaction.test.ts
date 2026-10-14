import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PidLockInfo } from '../src/server/pid-lock';
import type { Registration, WindowsRunObservation } from '../src/service/registration';

const files = vi.hoisted(() => ({ bytes: new Map<string, Buffer>(), events: [] as string[], failRename: '', failUnlink: '', persistentUnlink: '', persistentRename: '', readFaultPath: '', failTemporaryCleanup: false, failRead: false }));
vi.mock('node:fs/promises', () => ({
  realpath: vi.fn(async (path: string) => path),
  stat: vi.fn(async () => ({ isDirectory: () => true })),
  lstat: vi.fn(async (path: string) => {
    const bytes = files.bytes.get(path);
    if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { isFile: () => true, size: bytes.length, ino: 1, dev: 1, mtimeMs: 1 };
  }),
  readFile: vi.fn(async (path: string) => {
    if (files.readFaultPath === path) throw new Error(`EACCES: unreadable ${path}`);
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
    if (files.persistentRename === to) throw new Error(`EACCES: replacement ${to}`);
    if (files.failRename === to) { files.failRename = ''; throw new Error('rename failed'); }
    const bytes = files.bytes.get(from);
    if (!bytes) throw new Error('temporary missing');
    files.bytes.set(to, bytes); files.bytes.delete(from);
  }),
  unlink: vi.fn(async (path: string) => {
    files.events.push(`unlink:${path}`);
    if (files.failTemporaryCleanup && path.endsWith('.tmp')) throw new Error(`EACCES: temporary cleanup ${path}`);
    if (files.persistentUnlink === path) throw Object.assign(new Error(`EACCES: persistent unlink ${path}`), { code: 'EACCES' });
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

beforeEach(() => { files.bytes.clear(); files.events.length = 0; files.failRename = ''; files.failUnlink = ''; files.persistentUnlink = ''; files.persistentRename = ''; files.readFaultPath = ''; files.failTemporaryCleanup = false; files.failRead = false; });
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
  expect(result.kind).toBe('uninstalled');
  expect(result.retained).toEqual({ pid: originalOwner.pid, startedAt: originalOwner.startedAt });
  expect(await f.readOwner()).toBe(originalOwner);
  expect(files.events).toEqual([`unlink:${cmdPath}`, `unlink:${vbsPath}`]);
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
  expect(result.retained).toEqual({ pid: originalOwner.pid, startedAt: originalOwner.startedAt });
  expect(await f.readOwner()).toBe(originalOwner);
  expect(files.bytes.get(cmdPath)).toEqual(Buffer.from(f.rendered.cmd));
  expect(files.bytes.get(vbsPath)).toEqual(Buffer.from(f.rendered.vbs));
  expect(f.launch).not.toHaveBeenCalled();
});

it('restores launcher bytes and Run value after unload failure without relaunching', async () => {
  const f = await setup({ installed: true, owner: originalOwner });
  files.failUnlink = vbsPath;
  const result = await f.service.uninstall();
  expect(result.kind).toBe('uninstall_rolled_back');
  expect(result.retained).toBeNull();
  expect(f.getRun()).toBe(f.rendered.runValue);
  expect(files.bytes.get(cmdPath)).toEqual(Buffer.from(f.rendered.cmd));
  expect(files.bytes.get(vbsPath)).toEqual(Buffer.from(f.rendered.vbs));
  expect(f.launch).not.toHaveBeenCalled();
  expect(await f.readOwner()).toBeNull();
  expect(files.events.filter(event => /^(reg:|stop$|unlink:|rename:|launch$)/.test(event))).toEqual(['reg:delete', 'stop', `unlink:${cmdPath}`, `unlink:${vbsPath}`, `rename:${cmdPath}`, 'reg:add']);
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

it('reports an uncertain Run registration failure and converges on a later install', async () => {
  const f = await setup();
  const run = f.run.getMockImplementation();
  if (!run) throw new Error('Missing registry fixture');
  let failed = false;
  f.run.mockImplementation(args => {
    if (args[0] === 'add' && !failed) { failed = true; return { status: 1, stdout: '', stderr: 'write denied' }; }
    return run(args);
  });
  expect((await f.service.install()).kind).toBe('install_incomplete');
  expect(files.bytes.size).toBe(2); expect(f.getRun()).toBeNull();
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
  const result = await f.service.uninstall();
  expect(result.kind).toBe('uninstall_rolled_back');
  expect(result.retained).toBeNull();
  expect(f.getRun()).toBe(f.rendered.runValue);
  expect(files.bytes.get(cmdPath)).toEqual(Buffer.from(f.rendered.cmd));
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
  expect(files.bytes.get(vbsPath)).toEqual(Buffer.from(f.rendered.vbs));
  expect(files.events).toEqual(['reg:delete', 'reg:add']);
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
  expect(result.retained).toBeNull();
  expect(files.bytes.get(vbsPath)).toEqual(Buffer.from(f.rendered.vbs));
  expect(files.events.filter(event => /^(reg:|stop$|unlink:|rename:|launch$)/.test(event))).toEqual(['reg:query', `rename:${cmdPath}`, `rename:${vbsPath}`, 'reg:add', 'reg:delete', 'reg:add']);
});

it('restores previous definition without deleting an unchanged vbs during rollback', async () => {
  const f = await setup({ installed: true });
  f.distribution.mockResolvedValue({ kind: 'global-npm', cliPath: 'C:\\new\\vonvon.mjs' });
  f.launch.mockRejectedValue(new Error('launch failed'));
  files.failUnlink = vbsPath;
  const result = await f.service.install();
  expect(result.kind).toBe('install_rolled_back');
  expect(f.getRun()).toBe(f.rendered.runValue);
  expect(files.bytes.get(cmdPath)).toEqual(Buffer.from(f.rendered.cmd));
  expect(f.stopOwner).not.toHaveBeenCalled();
  expect(result.retained).toBeNull();
  expect(files.bytes.get(vbsPath)).toEqual(Buffer.from(f.rendered.vbs));
  expect(files.events.filter(event => /^(reg:|stop$|unlink:|rename:|launch$)/.test(event))).toEqual(['reg:query', `rename:${cmdPath}`, 'reg:delete', `unlink:${cmdPath}`, `rename:${cmdPath}`, 'reg:add']);
});

it.each(['read', 'unlink'] as const)('resumed Windows %s failure retains the owner and converges without stop', async boundary => {
  const f = await setup({ owner: originalOwner });
  files.bytes.set(cmdPath, Buffer.from(f.rendered.cmd));
  if (boundary === 'read') f.readOwner.mockRejectedValueOnce(new Error('lock read failed'));
  else files.failUnlink = cmdPath;
  const result = await f.service.uninstall();
  expect(result.kind).toBe('uninstall_incomplete');
  expect(result.detail).toContain(boundary === 'read' ? 'query_failed' : 'unlink failed');
  expect(result.retained).toEqual({ pid: originalOwner.pid, startedAt: originalOwner.startedAt });
  expect(await f.readOwner()).toBe(originalOwner);
  expect(f.getRun()).toBeNull(); expect(files.bytes.get(cmdPath)).toEqual(Buffer.from(f.rendered.cmd));
  expect(files.bytes.has(vbsPath)).toBe(false);
  expect(files.events).toEqual(boundary === 'read' ? [] : [`unlink:${cmdPath}`]);
  files.events.length = 0;
  const resumed = await f.service.uninstall();
  expect(resumed.kind).toBe('uninstalled'); expect(resumed.retained).toEqual(result.retained);
  expect(files.events).toEqual([`unlink:${cmdPath}`]); expect(files.bytes.size).toBe(0);
  expect((await f.service.uninstall()).kind).toBe('not-installed');
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
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

it('late step 5 stop_unconfirmed keeps launchers absent and retains the late owner', async () => {
  const f = await setup({ installed: true });
  f.readOwner.mockImplementation(async () => {
    if (files.bytes.size !== 0) return null;
    f.setOwner(originalOwner);
    return originalOwner;
  });
  f.stopOwner.mockImplementation(async () => {
    files.events.push('stop-unconfirmed');
    expect(f.getRun()).toBeNull(); expect(files.bytes.size).toBe(0);
    throw new Error('stop acknowledgment lost');
  });
  const result = await f.service.uninstall();
  expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('stop_unconfirmed');
  expect(result.detail).toContain(String(originalOwner.pid));
  expect(result.retained).toEqual({ pid: originalOwner.pid, startedAt: originalOwner.startedAt });
  expect(await f.readOwner()).toBe(originalOwner);
  expect(f.getRun()).toBeNull(); expect(files.bytes.size).toBe(0);
  expect(files.events).toEqual(['reg:delete', `unlink:${cmdPath}`, `unlink:${vbsPath}`, 'stop-unconfirmed']);
  expect(f.stopOwner).toHaveBeenCalledExactlyOnceWith(rootPath, originalOwner);
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.run.mock.calls.map(([args]) => args[0])).toEqual(['delete']);
});

const persistentCases = [
  { name: 'cmd', path: cmdPath, previous: false },
  { name: 'vbs', path: vbsPath, previous: false },
  { name: 'cmd', path: cmdPath, previous: true },
  { name: 'vbs', path: vbsPath, previous: true },
] as const;

async function persistentRollback(path: string, previous: boolean) {
  const f = await setup({ installed: previous });
  const work: string[] = [];
  f.readOwner.mockImplementation(async () => { files.events.push('owner:null'); return null; });
  files.persistentUnlink = path;
  let newCmd: Buffer | undefined;
  let newVbs: Buffer | undefined;
  f.launch.mockImplementation(async () => {
    files.events.push('launch');
    newCmd = files.bytes.get(cmdPath); newVbs = files.bytes.get(vbsPath);
    throw new Error('fixture launch failed');
  });
  const result = await f.service.install({ port: 4321 });
  expect(result.kind).toBe(previous ? 'install_rolled_back' : 'install_incomplete');
  expect(result.retained).toBeNull();
  const refusal = `${path}: EACCES: persistent unlink ${path}`;
  expect(result.detail).toBe(previous && path === vbsPath ? 'fixture launch failed; transaction launchers removed' : `fixture launch failed; ${refusal}${previous ? '' : `; restore failed: ${refusal}`}`);
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(work).toEqual([]);
  expect(newCmd).toBeDefined(); expect(newVbs).toBeDefined();
  expect(newCmd).not.toEqual(Buffer.from(f.rendered.cmd));
  const events = files.events;
  const withdrawn = events.indexOf('reg:delete');
  expect(withdrawn).toBeGreaterThan(-1);
  expect(events.indexOf('owner:null', withdrawn)).toBeLessThan(events.indexOf(`unlink:${cmdPath}`));
  expect(events.indexOf('owner:null', withdrawn)).toBeGreaterThan(withdrawn);
  return { ...f, result, newCmd, newVbs, work };
}

const persistentMutations = () => files.events.filter(event => event === 'launch' || event.startsWith('rename:') || event.startsWith('unlink:') || event.startsWith('reg:'));

it.each(persistentCases)('persistent Windows $name unlink with previous=$previous reports exact partial state and fresh uninstall converges', async ({ path, name, previous }) => {
  const f = await persistentRollback(path, previous);
  const initial = previous ? ['reg:query', `rename:${cmdPath}`, 'launch', 'reg:delete']
    : ['reg:query', `rename:${cmdPath}`, `rename:${vbsPath}`, 'reg:add', 'launch', 'reg:delete'];
  const deletion = previous ? [`unlink:${cmdPath}`] : [`unlink:${cmdPath}`, `unlink:${vbsPath}`];
  const recovery = previous ? [`rename:${cmdPath}`, 'reg:add'] : [`unlink:${path}`];
  expect(persistentMutations()).toEqual([...initial, ...deletion, ...recovery]);
  const expectedCmd = previous ? Buffer.from(f.rendered.cmd) : name === 'cmd' ? f.newCmd : undefined;
  const expectedVbs = previous ? Buffer.from(f.rendered.vbs) : name === 'vbs' ? f.newVbs : undefined;
  expect(files.bytes.get(cmdPath)).toEqual(expectedCmd);
  expect(files.bytes.get(vbsPath)).toEqual(expectedVbs);
  expect(f.getRun()).toBe(previous ? f.rendered.runValue : null);
  expect(f.result.leftovers).toEqual([
    ...(previous ? ['Run value Vonvon Bot'] : []),
    ...(expectedCmd ? [`launcher ${cmdPath}`] : []), ...(expectedVbs ? [`launcher ${vbsPath}`] : []),
  ]);
  files.events.length = 0;
  const retry = await f.service.uninstall();
  expect(retry.kind).toBe(previous ? 'uninstall_rolled_back' : 'uninstall_incomplete');
  expect(retry.detail).toBe(`${path}: EACCES: persistent unlink ${path}`);
  expect(retry.retained).toBeNull(); expect(retry.leftovers).toEqual(f.result.leftovers);
  expect(files.bytes.get(cmdPath)).toEqual(expectedCmd); expect(files.bytes.get(vbsPath)).toEqual(expectedVbs);
  expect(f.getRun()).toBe(previous ? f.rendered.runValue : null);
  expect(persistentMutations()).toEqual(previous
    ? ['reg:delete', `unlink:${cmdPath}`, `unlink:${vbsPath}`, `rename:${name === 'cmd' ? vbsPath : cmdPath}`, 'reg:add']
    : [`unlink:${path}`]);
  files.persistentUnlink = '';
  files.events.length = 0;
  const recovered = await f.service.uninstall();
  expect(recovered).toEqual({ kind: 'uninstalled', detail: 'Uninstalled', retained: null, leftovers: [] });
  expect(files.bytes.size).toBe(0); expect(f.getRun()).toBeNull();
  expect(persistentMutations()).toEqual([...(previous ? ['reg:delete'] : []), ...(expectedCmd ? [`unlink:${cmdPath}`] : []), ...(expectedVbs ? [`unlink:${vbsPath}`] : [])]);
  expect((await f.service.uninstall()).kind).toBe('not-installed');
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.work).toEqual([]);
  expect(f.launch).toHaveBeenCalledOnce();
});

it.each(persistentCases)('persistent Windows $name unlink approved row16 exact P-or-refused-remnant contract with previous=$previous', async ({ path, previous }) => {
  const f = await persistentRollback(path, previous);
  expect(f.getRun()).toBe(previous ? f.rendered.runValue : null);
  expect(files.bytes.get(cmdPath) ?? null).toEqual(previous ? Buffer.from(f.rendered.cmd) : path === cmdPath ? f.newCmd : null);
  expect(files.bytes.get(vbsPath) ?? null).toEqual(previous ? Buffer.from(f.rendered.vbs) : path === vbsPath ? f.newVbs : null);
});

async function refusedReplacement(options: { changedOwner?: boolean; temporary?: boolean } = {}) {
  const f = await setup({ installed: true });
  let newCmd: Buffer | undefined;
  f.launch.mockImplementation(async () => {
    files.events.push('launch');
    newCmd = files.bytes.get(cmdPath);
    files.persistentUnlink = cmdPath;
    if (!options.changedOwner) files.persistentRename = cmdPath;
    files.failTemporaryCleanup = options.temporary ?? false;
    if (options.changedOwner) f.setOwner(originalOwner);
    throw new Error('fixture launch failed');
  });
  const result = await f.service.install({ port: 4321 });
  expect(result.kind).toBe('install_incomplete');
  expect(result.detail).toContain(`${cmdPath}: EACCES: persistent unlink ${cmdPath}`);
  expect(f.getRun()).toBe(options.changedOwner ? f.rendered.runValue : null);
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.launch).toHaveBeenCalledOnce();
  expect(files.bytes.get(vbsPath)).toEqual(Buffer.from(f.rendered.vbs));
  return { ...f, result, newCmd };
}

it('persistent case e retains refused N cmd and P vbs, then independently removes vbs on resumed uninstall', async () => {
  const f = await refusedReplacement();
  expect(f.result.detail).toContain(`restore failed: ${cmdPath}: EACCES: replacement ${cmdPath}`);
  expect(files.bytes.get(cmdPath)).toEqual(f.newCmd);
  expect(f.result.retained).toBeNull();
  expect(f.result.leftovers).toEqual([`launcher ${cmdPath}`, `launcher ${vbsPath}`]);
  const mutations = persistentMutations();
  expect(mutations.slice(0, 6)).toEqual(['reg:query', `rename:${cmdPath}`, 'launch', 'reg:delete', `unlink:${cmdPath}`, `rename:${cmdPath}`]);
  expect(mutations).toHaveLength(7); expect(mutations[6]).toMatch(/\.tmp$/);
  files.events.length = 0;
  const retry = await f.service.uninstall();
  expect(retry.kind).toBe('uninstall_incomplete');
  expect(retry.detail).toBe(`${cmdPath}: EACCES: persistent unlink ${cmdPath}`);
  expect(retry.leftovers).toEqual([`launcher ${cmdPath}`]);
  expect(files.bytes.get(cmdPath)).toEqual(f.newCmd); expect(files.bytes.has(vbsPath)).toBe(false);
  expect(persistentMutations()).toEqual([`unlink:${cmdPath}`, `unlink:${vbsPath}`]);
  files.persistentUnlink = ''; files.persistentRename = '';
  expect((await f.service.uninstall()).kind).toBe('uninstalled');
  expect((await f.service.uninstall()).kind).toBe('not-installed');
  expect(files.bytes.size).toBe(0); expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.launch).toHaveBeenCalledOnce();
});

it('persistent case f exact P restoration with changed owner stays incomplete and preserves that owner', async () => {
  const f = await refusedReplacement({ changedOwner: true });
  expect(f.result.detail).toContain('owner changed since preflight');
  expect(f.result.retained).toEqual({ pid: originalOwner.pid, startedAt: originalOwner.startedAt });
  expect(await f.readOwner()).toEqual(originalOwner);
  expect(files.bytes.get(cmdPath)).toEqual(Buffer.from(f.rendered.cmd));
  expect(f.result.leftovers).toEqual([`retained pid ${originalOwner.pid}`, 'Run value Vonvon Bot', `launcher ${cmdPath}`, `launcher ${vbsPath}`]);
  expect(persistentMutations()).toEqual(['reg:query', `rename:${cmdPath}`, 'launch', 'reg:delete', `unlink:${cmdPath}`, `rename:${cmdPath}`, 'reg:add']);
  f.setOwner(null);
  expect((await f.service.uninstall()).kind).toBe('uninstall_rolled_back');
  files.persistentUnlink = '';
  expect((await f.service.uninstall()).kind).toBe('uninstalled');
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.launch).toHaveBeenCalledOnce();
});

it('persistent case g failed kept cmd replacement after deletion leaves Run absent and only kept vbs', async () => {
  const f = await setup({ installed: true });
  files.persistentUnlink = vbsPath; files.persistentRename = cmdPath;
  const result = await f.service.uninstall();
  expect(result.kind).toBe('uninstall_incomplete');
  expect(result.detail).toContain(`${vbsPath}: EACCES: persistent unlink ${vbsPath}`);
  expect(result.detail).toContain(`restore failed: ${cmdPath}: EACCES: replacement ${cmdPath}`);
  expect(result.retained).toBeNull(); expect(result.leftovers).toEqual([`launcher ${vbsPath}`]);
  expect(f.getRun()).toBeNull(); expect(files.bytes.has(cmdPath)).toBe(false);
  expect(files.bytes.get(vbsPath)).toEqual(Buffer.from(f.rendered.vbs));
  const mutations = persistentMutations();
  expect(mutations.slice(0, 4)).toEqual(['reg:delete', `unlink:${cmdPath}`, `unlink:${vbsPath}`, `rename:${cmdPath}`]);
  expect(mutations).toHaveLength(5); expect(mutations[4]).toMatch(/\.tmp$/);
  expect((await f.service.uninstall()).kind).toBe('uninstall_incomplete');
  files.persistentUnlink = ''; files.persistentRename = '';
  expect((await f.service.uninstall()).kind).toBe('uninstalled');
  expect((await f.service.uninstall()).kind).toBe('not-installed');
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
});

it('persistent case h unreadable launcher after withdrawal is unknown and prevents Run writeback', async () => {
  const f = await setup({ installed: true });
  f.launch.mockRejectedValue(new Error('fixture launch failed'));
  const readOwner = f.readOwner.getMockImplementation()!;
  f.readOwner.mockImplementation(async () => {
    if (f.getRun() === null) files.readFaultPath = cmdPath;
    return readOwner();
  });
  const result = await f.service.install({ port: 4321 });
  expect(result.kind).toBe('install_incomplete');
  expect(result.detail).toContain(`Launcher unknown ${cmdPath}: EACCES: unreadable ${cmdPath}`);
  expect(result.leftovers).toEqual([`launcher ${cmdPath}: EACCES: unreadable ${cmdPath}`, `launcher ${vbsPath}`]);
  expect(f.getRun()).toBeNull(); expect(files.bytes.get(cmdPath)?.toString()).toContain('--port 4321');
  expect(files.bytes.get(vbsPath)).toEqual(Buffer.from(f.rendered.vbs));
  expect(persistentMutations()).toEqual(['reg:query', `rename:${cmdPath}`, 'reg:delete']);
  files.readFaultPath = ''; f.readOwner.mockImplementation(readOwner);
  expect((await f.service.uninstall()).kind).toBe('uninstalled');
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.launch).toHaveBeenCalledOnce();
});

it.each(['withdrawal-not-applied', 'withdrawal-readback', 'restore-readback'] as const)('persistent case h %s prevents additional Run mutation and reports unknown', async boundary => {
  const f = await setup({ installed: true });
  f.launch.mockRejectedValue(new Error('fixture launch failed'));
  const run = f.run.getMockImplementation()!;
  f.run.mockImplementation(args => {
    if (boundary === 'withdrawal-not-applied' && args[0] === 'delete') {
      files.events.push('reg:delete');
      return { status: 0, stdout: '', stderr: '' };
    }
    const result = run(args);
    if ((boundary === 'withdrawal-readback' && args[0] === 'delete') || (boundary === 'restore-readback' && args[0] === 'add')) {
      f.readRun.mockImplementationOnce(() => { throw new Error('fixture Run readback failed'); });
    }
    return result;
  });
  const result = await f.service.install({ port: 4321 });
  expect(result.kind).toBe('install_incomplete');
  expect(result.detail).toContain('Run value unknown:');
  expect(result.leftovers[0]).toContain('Run value unknown:');
  expect(result.leftovers.slice(1)).toEqual([`launcher ${cmdPath}`, `launcher ${vbsPath}`]);
  expect(f.getRun()).toBe(boundary === 'withdrawal-readback' ? null : f.rendered.runValue);
  expect(persistentMutations()).toEqual(boundary === 'restore-readback'
    ? ['reg:query', `rename:${cmdPath}`, 'reg:delete', `unlink:${cmdPath}`, `rename:${cmdPath}`, 'reg:add']
    : ['reg:query', `rename:${cmdPath}`, 'reg:delete']);
  expect(files.bytes.get(cmdPath)).toEqual(boundary === 'restore-readback' ? Buffer.from(f.rendered.cmd) : Buffer.from(Buffer.from(f.rendered.cmd).toString().replace('--port 3210', '--port 4321')));
  expect(files.bytes.get(vbsPath)).toEqual(Buffer.from(f.rendered.vbs));
  f.run.mockImplementation(run);
  expect((await f.service.uninstall()).kind).toBe('uninstalled');
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.launch).toHaveBeenCalledOnce();
});

it.each(['launcher', 'Run'] as const)('persistent case i foreign %s change fails closed before cleanup', async boundary => {
  const f = await setup({ installed: true });
  f.launch.mockImplementation(async () => {
    if (boundary === 'launcher') files.bytes.set(cmdPath, Buffer.from('foreign bytes'));
    else {
      const run = f.run.getMockImplementation()!;
      run(['add', WINDOWS_RUN_KEY, '/d', 'foreign Run']);
    }
    throw new Error('fixture launch failed');
  });
  const result = await f.service.install({ port: 4321 });
  expect(result.kind).toBe('install_incomplete');
  expect(result.detail).toContain(boundary === 'launcher' ? `Launcher changed before mutation: ${cmdPath}` : 'Windows Run registration changed before mutation');
  expect(persistentMutations()).toEqual(['reg:query', `rename:${cmdPath}`, ...(boundary === 'Run' ? ['reg:add'] : [])]);
  expect(f.getRun()).toBe(boundary === 'Run' ? 'foreign Run' : f.rendered.runValue);
  expect(files.bytes.get(cmdPath)?.toString()).toBe(boundary === 'launcher' ? 'foreign bytes' : Buffer.from(f.rendered.cmd).toString().replace('--port 3210', '--port 4321'));
  expect(files.bytes.get(vbsPath)).toEqual(Buffer.from(f.rendered.vbs));
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.launch).toHaveBeenCalledOnce();
  expect((await f.service.uninstall()).kind).toBe('uninstall_refused');
});

it('persistent temporary cleanup failure lists the exact temporary leftover', async () => {
  const f = await refusedReplacement({ temporary: true });
  const temporaries = [...files.bytes.keys()].filter(path => path.endsWith('.tmp'));
  expect(temporaries).toHaveLength(1);
  expect(f.result.leftovers).toEqual([`temporary file ${temporaries[0]}`, `launcher ${cmdPath}`, `launcher ${vbsPath}`]);
  expect(f.result.kind).toBe('install_incomplete');
});

it('persistent final verification refuses rollback success after a late foreign launcher change', async () => {
  const f = await setup({ installed: true });
  f.launch.mockRejectedValue(new Error('fixture launch failed'));
  let reads = 0;
  f.readOwner.mockImplementation(async () => {
    reads++;
    if (reads === 3) files.bytes.set(cmdPath, Buffer.from('late foreign bytes'));
    return null;
  });
  const result = await f.service.install({ port: 4321 });
  expect(result.kind).toBe('install_incomplete');
  expect(result.detail).toContain(`final verification failed: Launcher changed before mutation: ${cmdPath}`);
  expect(files.bytes.get(cmdPath)).toEqual(Buffer.from('late foreign bytes'));
  expect(f.getRun()).toBe(f.rendered.runValue);
  expect(persistentMutations()).toEqual(['reg:query', `rename:${cmdPath}`, 'reg:delete', `unlink:${cmdPath}`, `rename:${cmdPath}`, 'reg:add']);
  expect(f.stopOwner).not.toHaveBeenCalled();
});

it('latches a one-shot Run read failure after the first launcher rename without further mutation', async () => {
  const f = await setup();
  const readRun = f.readRun.getMockImplementation()!;
  let failed = false;
  f.readRun.mockImplementation(() => {
    if (!failed && files.events.includes(`rename:${cmdPath}`)) {
      failed = true;
      throw new Error('fixture Run read failed');
    }
    return readRun();
  });
  const result = await f.service.install();
  expect(failed).toBe(true);
  expect(result.kind).toBe('install_incomplete');
  expect(result.detail).toContain('Run value unknown: fixture Run read failed');
  expect(result.leftovers).toEqual(['Run value unknown: fixture Run read failed', `launcher ${cmdPath}`]);
  expect(files.bytes.get(cmdPath)).toEqual(Buffer.from(f.rendered.cmd));
  expect(files.bytes.has(vbsPath)).toBe(false);
  expect(f.getRun()).toBeNull();
  expect(f.readRun()).toEqual({ kind: 'absent' });
  expect(result.retained).toBeNull();
  expect(persistentMutations()).toEqual(['reg:query', `rename:${cmdPath}`]);
  expect(f.stopOwner).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
});
