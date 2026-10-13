import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import type { Registration } from '../src/service/registration';

const fixture = vi.hoisted(() => ({
  registration: vi.fn<() => Promise<Registration>>(), owner: vi.fn(), acquireMutex: vi.fn(), acquirePidLock: vi.fn(),
  closeMutex: vi.fn(), releasePidLock: vi.fn(), run: vi.fn(), info: vi.fn(), importedRun: vi.fn(), runValue: vi.fn(),
}));
vi.mock('../src/config/paths', () => ({ paths: { appDir: '/owned/root' } }));
vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
vi.mock('../src/config/data-access', () => ({ acquireMutex: fixture.acquireMutex, closeMutex: fixture.closeMutex }));
vi.mock('../src/server/pid-lock', async original => ({ ...await original<typeof import('../src/server/pid-lock')>(), readRunningPidLock: fixture.owner, acquirePidLock: fixture.acquirePidLock, releasePidLock: fixture.releasePidLock, publishPidLock: vi.fn() }));
vi.mock('../src/service/registration', () => ({ readRegistration: fixture.registration }));
vi.mock('../src/service/win-startup', () => ({ readVonvonRunValue: fixture.runValue }));
vi.mock('../src/core/logger', () => ({ log: { info: fixture.info } }));
vi.mock('../src/service/codex-bin', () => ({ readServiceCodexBin: vi.fn() }));
vi.mock('../src/cli/commands/run', () => { fixture.importedRun(); return { runRun: fixture.run }; });
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), realpath: vi.fn(async () => process.platform === 'win32' ? 'C:\\owned\\root' : '/owned/root'), stat: vi.fn(async () => ({ isDirectory: () => true })) }));

import { runHostRuntime } from '../src/host/bootstrap';
import { resolveServiceRoot } from '../src/service/identity';
import type { ShutdownControl } from '../src/host/lifecycle';

const owner = { pid: 4242, startedAt: '2026-10-11T00:00:00.000Z', listen: '127.0.0.1:1234' };
const control: ShutdownControl = {
  requested: false, requestStop: vi.fn(), requestRestart: vi.fn(), waitForRequest: vi.fn(),
  completeShutdown: vi.fn(async (release: () => Promise<void>) => { await release(); }), dispose: vi.fn(),
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(homedir).mockReturnValue('/home/vonvon-fixture');
  vi.stubEnv('XDG_CONFIG_HOME', '/home/vonvon-fixture/.config');
  fixture.registration.mockReset(); fixture.owner.mockReset(); fixture.acquireMutex.mockReset(); fixture.acquirePidLock.mockReset();
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), {
    platform: { value: 'darwin' }, send: { value: undefined }, exitCode: { value: undefined, writable: true },
  }));
  vi.stubEnv('VONVON_SERVICE', 'launchd');
  fixture.registration.mockResolvedValue({ kind: 'ours', definition: { root: await resolveServiceRoot('/owned/root'), port: 1234, capturedPath: '/bin', distribution: { kind: 'npm', executable: '/node', entry: '/cli' } } });
  fixture.owner.mockResolvedValue(null);
  fixture.runValue.mockReturnValue({ kind: 'absent' });
});
afterEach(() => { vi.mocked(homedir).mockReset(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function untouched(): void {
  expect(fixture.acquireMutex).not.toHaveBeenCalled(); expect(fixture.acquirePidLock).not.toHaveBeenCalled();
  expect(fixture.releasePidLock).not.toHaveBeenCalled(); expect(fixture.closeMutex).not.toHaveBeenCalled();
  expect(fixture.run).not.toHaveBeenCalled(); expect(fixture.importedRun).not.toHaveBeenCalled();
}
it('returns zero before either lock when managed registration is absent', async () => {
  fixture.registration.mockResolvedValue({ kind: 'absent' });
  await runHostRuntime({ managed: false, control });
  untouched(); expect(fixture.owner).not.toHaveBeenCalled(); expect(process.exitCode).toBe(0);
  expect(fixture.info).toHaveBeenCalledWith('daemon-startup', 'registration_absent', { kind: 'absent' });
});
it('returns zero for an unrecognized managed registration and logs why', async () => {
  fixture.registration.mockResolvedValue({ kind: 'unrecognized', location: '/service', reason: 'invalid' });
  await runHostRuntime({ managed: false, control });
  untouched(); expect(process.exitCode).toBe(0);
  expect(fixture.info).toHaveBeenCalledWith('daemon-startup', 'registration_absent', { kind: 'unrecognized', location: '/service', reason: 'invalid' });
});
it('returns zero for another root and logs the recorded root', async () => {
  const registration = await fixture.registration();
  if (registration.kind !== 'ours') throw new Error('Missing fixture');
  fixture.registration.mockResolvedValue({ ...registration, kind: 'other-root', recordedRoot: registration.definition.root });
  await runHostRuntime({ managed: false, control });
  untouched(); expect(process.exitCode).toBe(0);
  expect(fixture.info).toHaveBeenCalledWith('daemon-startup', 'registration_absent', { kind: 'other-root', recordedRoot: registration.definition.root });
});
it.each(['windows', ''])('fails before either lock when the Windows Run value cannot be read (VONVON_SERVICE=%j)', async service => {
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), {
    platform: { value: 'win32' }, send: { value: undefined }, exitCode: { value: undefined, writable: true },
  }));
  vi.stubEnv('VONVON_SERVICE', service);
  fixture.runValue.mockReturnValue({ kind: 'unavailable', reason: 'Windows Run query timed out' });
  await expect(runHostRuntime({ managed: false, control })).rejects.toThrow('Windows Run observation unavailable: Windows Run query timed out');
  untouched(); expect(fixture.registration).not.toHaveBeenCalled(); expect(fixture.owner).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});
it('treats a stale lock naming this process as no owner', async () => {
  const mutex = {};
  fixture.owner.mockResolvedValue({ ...owner, pid: process.pid });
  fixture.acquireMutex.mockResolvedValue(mutex);
  fixture.acquirePidLock.mockRejectedValue(new Error('Another Vonvon daemon is already running'));
  await expect(runHostRuntime({ managed: false, control })).rejects.toThrow('Another Vonvon daemon is already running');
  expect(fixture.acquirePidLock).toHaveBeenCalledOnce(); expect(process.exitCode).not.toBe(0);
  expect(fixture.closeMutex).toHaveBeenCalledWith(mutex); expect(fixture.info).not.toHaveBeenCalled();
});
it('returns zero without releasing or overwriting an existing owner', async () => {
  fixture.owner.mockResolvedValue(Object.freeze(owner));
  await runHostRuntime({ managed: false, control });
  untouched(); expect(process.exitCode).toBe(0);
  expect(fixture.info).toHaveBeenCalledWith('daemon-startup', 'owner_present', { pid: owner.pid });
});
it('releases only its own mutex after a pid-lock collision', async () => {
  const mutex = {};
  fixture.acquireMutex.mockResolvedValue(mutex);
  fixture.acquirePidLock.mockRejectedValue(new Error('collision'));
  fixture.owner.mockResolvedValueOnce(null).mockResolvedValueOnce(owner);
  await runHostRuntime({ managed: false, control });
  expect(process.exitCode).toBe(0); expect(fixture.closeMutex).toHaveBeenCalledWith(mutex);
  expect(fixture.releasePidLock).not.toHaveBeenCalled(); expect(fixture.run).not.toHaveBeenCalled();
});
it('returns zero on a mutex collision only when another live owner exists', async () => {
  fixture.acquireMutex.mockRejectedValue(new Error('collision'));
  fixture.owner.mockResolvedValueOnce(null).mockResolvedValueOnce(owner);
  await runHostRuntime({ managed: false, control });
  expect(process.exitCode).toBe(0); expect(fixture.closeMutex).not.toHaveBeenCalled();
  expect(fixture.acquirePidLock).not.toHaveBeenCalled();
});
it('propagates lock failures without another live owner', async () => {
  fixture.acquireMutex.mockRejectedValue(new Error('unavailable'));
  await expect(runHostRuntime({ managed: false, control })).rejects.toThrow('unavailable');
  expect(fixture.run).not.toHaveBeenCalled();
});
it('refuses unmanaged foreground startup with exit one before locks', async () => {
  vi.stubEnv('VONVON_SERVICE', '');
  await expect(runHostRuntime({ managed: false, control })).rejects.toThrow('Use vonvon daemon start or vonvon service uninstall');
  untouched(); expect(process.exitCode).toBeUndefined();
});
it('does not exempt a bot argument without the supervisor IPC channel', async () => {
  vi.stubEnv('VONVON_SERVICE', '');
  await expect(runHostRuntime({ managed: false, bot: 'fixture', control })).rejects.toThrow('Use vonvon daemon start');
  untouched(); expect(process.exitCode).toBeUndefined();
});
it('exempts only the IPC Bot child without reading registration or locks', async () => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'send', { value: vi.fn() }));
  await runHostRuntime({ managed: false, bot: 'fixture', control });
  expect(fixture.registration).not.toHaveBeenCalled(); expect(fixture.owner).not.toHaveBeenCalled();
  expect(fixture.acquireMutex).not.toHaveBeenCalled(); expect(fixture.acquirePidLock).not.toHaveBeenCalled();
  expect(fixture.run).toHaveBeenCalledWith('fixture', expect.objectContaining({ control }));
});
it.each(['darwin', 'win32'] as const)('retains ordinary foreground startup when registration is absent or the existing unmanaged Windows path on %s', async platform => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: platform }));
  vi.stubEnv('VONVON_SERVICE', '');
  fixture.registration.mockResolvedValue({ kind: 'absent' });
  const mutex = {};
  fixture.acquireMutex.mockResolvedValue(mutex);
  fixture.acquirePidLock.mockResolvedValue(owner);
  await runHostRuntime({ managed: false, control });
  expect(fixture.acquireMutex).toHaveBeenCalledWith('/owned/root', 'host');
  expect(fixture.acquirePidLock).toHaveBeenCalledWith('/owned/root');
  expect(fixture.acquireMutex.mock.invocationCallOrder[0]).toBeLessThan(fixture.acquirePidLock.mock.invocationCallOrder[0] ?? 0);
  expect(fixture.run).toHaveBeenCalledOnce();
  expect(fixture.releasePidLock).toHaveBeenCalledWith('/owned/root', owner);
  expect(fixture.closeMutex).toHaveBeenCalledWith(mutex);
});

it('checks Windows registration before locks and exits zero when withdrawn', async () => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }));
  vi.stubEnv('VONVON_SERVICE', 'windows');
  fixture.registration.mockResolvedValue({ kind: 'absent' });
  await runHostRuntime({ managed: false, control });
  untouched(); expect(fixture.registration).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(0);
});

it('keeps Windows managed launches off an existing owner and foreground launches off registration', async () => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }));
  vi.stubEnv('VONVON_SERVICE', 'windows');
  fixture.owner.mockResolvedValue(owner);
  await runHostRuntime({ managed: false, control });
  untouched(); expect(process.exitCode).toBe(0);
  process.exitCode = undefined;
  vi.stubEnv('VONVON_SERVICE', '');
  await expect(runHostRuntime({ managed: false, control })).rejects.toThrow('Use vonvon daemon start');
  untouched(); expect(process.exitCode).toBeUndefined();
});

it.each(['stop', 'restart'] as const)('preserves %s exit zero while reporting a late PID release failure', async intent => {
  const { observeShutdown } = await import('../src/host/lifecycle');
  const shutdown = observeShutdown();
  const failure = new Error('PID release failed');
  fixture.acquirePidLock.mockResolvedValue({ ...owner, pid: process.pid });
  fixture.releasePidLock.mockRejectedValueOnce(failure);
  fixture.run.mockImplementationOnce(async () => {
    if (intent === 'restart') shutdown.requestRestart(1234);
    else shutdown.requestStop();
    await shutdown.completeShutdown(async () => {});
  });
  await expect(runHostRuntime({ managed: false, control: shutdown })).rejects.toBe(failure);
  expect(process.exitCode).toBe(0);
});

it('cancels a requested restart when the runner rejects before completing shutdown', async () => {
  const { observeShutdown } = await import('../src/host/lifecycle');
  const shutdown = observeShutdown();
  const failure = new Error('runner failed during drain');
  fixture.run.mockImplementationOnce(async () => {
    shutdown.requestRestart(1234);
    throw failure;
  });
  await expect(runHostRuntime({ managed: false, control: shutdown })).rejects.toBe(failure);
  expect(process.exitCode).toBe(0);
});

it.each(['success', 'error', 'timeout'] as const)('launchd %s bootstrap composes the actual duplicate pre-lock guard and owner-preserving rollback', async bootstrap => {
  const { mkdtemp, mkdir, open, readFile, writeFile, unlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, basename } = await import('node:path');
  const { createLaunchdService } = await import('../src/service/launchd');
  const { renderDefinition } = await import('../src/service/definitions');
  const directory = await mkdtemp(join(tmpdir(), 'vonvon-composed-prelock-'));
  const root = await resolveServiceRoot('/owned/root');
  const target = { platform: 'darwin' as const, plistPath: join(directory, 'Library/LaunchAgents/com.vonvon.bot.daemon.plist') };
  const definition = { root, port: 1234, capturedPath: '/bin', distribution: { kind: 'npm' as const, executable: '/node', entry: '/cli' } };
  const rendered = renderDefinition({ target, ...definition });
  if (rendered.platform !== 'darwin') throw new Error('Expected plist');
  const work = ['retained-in-flight-work'];
  const ownerBytes = JSON.stringify(owner);
  await writeFile(join(directory, 'daemon.pid'), ownerBytes);
  const observations: string[] = [];
  let loaded = false;
  let failPrint = false;
  const calls: string[] = [];
  const stop = vi.fn(async () => { throw new Error('Unexpected owner stop'); });
  fixture.owner.mockResolvedValue(owner);
  fixture.registration.mockImplementation(async () => {
    try { expect(await readFile(target.plistPath)).toEqual(Buffer.from(rendered.plist)); return { kind: 'ours', definition }; }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'absent' }; throw error; }
  });
  const service = createLaunchdService({ root }, {
    home: directory, uid: 501, resolveRoot: async () => root,
    distribution: async () => ({ kind: 'global-npm', cliPath: '/cli' }), executable: '/node', capturedPath: '/bin',
    readOwner: async () => { observations.push('lock'); return fixture.owner(); }, verifyOwner: async () => {}, stopOwner: stop,
    open: (path, flags, mode) => open(String(path).startsWith('/owned/root/') ? join(directory, basename(String(path))) : path, flags, mode),
    unlink: async path => { await unlink(path); observations.length = 0; },
    pause: async () => { throw new Error('Unexpected retained owner wait'); },
    run: async args => {
      calls.push(args[0] ?? '');
      if (args[0] === 'print' && args[1] === 'gui/501') return { ok: true, stdout: 'domain', stderr: '' };
      if (args[0] === 'print') {
        if (failPrint) { failPrint = false; return { ok: false, stdout: '', stderr: 'verify query failed' }; }
        observations.push('job-empty');
        return loaded ? { ok: true, stdout: 'gui/501/com.vonvon.bot.daemon = {\n\tstate = waiting\n}', stderr: '' }
          : { ok: false, stdout: '', stderr: 'Could not find service' };
      }
      if (args[0] === 'bootstrap') {
        loaded = true;
        await runHostRuntime({ managed: false, control });
        untouched(); expect(process.exitCode).toBe(0);
        expect(work).toEqual(['retained-in-flight-work']);
        if (bootstrap === 'success') failPrint = true;
        return { ok: bootstrap === 'success', stdout: '', stderr: bootstrap === 'success' ? '' : bootstrap };
      }
      if (args[0] === 'bootout') {
        expect.soft((await fixture.registration()).kind).toBe('absent');
        expect.soft(observations.slice(-2)).toEqual(['lock', 'job-empty']);
        loaded = false; return { ok: true, stdout: '', stderr: '' };
      }
      throw new Error('Unexpected manager operation');
    },
  });
  try {
    await mkdir(directory, { recursive: true });
    const result = await service.install();
    expect(result.kind).toBe(bootstrap === 'success' ? 'install_rolled_back' : 'install_incomplete');
    expect(result.retained).toEqual({ pid: owner.pid, startedAt: owner.startedAt });
    expect(await fixture.owner()).toBe(owner); expect(work).toEqual(['retained-in-flight-work']);
    expect(stop).not.toHaveBeenCalled(); untouched();
    expect(await readFile(join(directory, 'daemon.pid'), 'utf8')).toBe(ownerBytes);
    expect((await fixture.registration()).kind).toBe('absent');
    expect(calls.filter(call => call === 'bootout')).toHaveLength(bootstrap === 'success' ? 1 : 0);
    if (bootstrap !== 'success') {
      expect((await service.uninstall()).kind).toBe('uninstalled');
      expect(calls.filter(call => call === 'bootout')).toHaveLength(1);
      expect(await fixture.owner()).toBe(owner); expect(work).toEqual(['retained-in-flight-work']);
      expect(stop).not.toHaveBeenCalled(); untouched();
      expect(await readFile(join(directory, 'daemon.pid'), 'utf8')).toBe(ownerBytes);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('launchd rollback composes modeled W exit and reused manager PID with actual absent pre-lock exit and O4 refusal', async () => {
  const { mkdtemp, open, readFile, writeFile, unlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, basename } = await import('node:path');
  const { createServer } = await import('node:http');
  const { randomUUID } = await import('node:crypto');
  const { machineIdSchema, PROTOCOL_VERSION } = await import('@vonvon/protocol');
  const { createSocketServer } = await import('../src/server/ws');
  const { stopVerifiedOwner } = await import('../src/server/owner-verification');
  const { publishPidLock } = await import('../src/server/pid-lock');
  const { createLaunchdService } = await import('../src/service/launchd');
  const { renderDefinition } = await import('../src/service/definitions');
  const directory = await mkdtemp(join(tmpdir(), 'vonvon-reused-prelock-'));
  vi.stubEnv('VONVON_HOME', directory);
  const root = await resolveServiceRoot('/owned/root');
  const target = { platform: 'darwin' as const, plistPath: join(directory, 'Library/LaunchAgents/com.vonvon.bot.daemon.plist') };
  const definition = { root, port: 1234, capturedPath: '/bin', distribution: { kind: 'npm' as const, executable: '/node', entry: '/cli' } };
  const rendered = renderDefinition({ target, ...definition });
  if (rendered.platform !== 'darwin') throw new Error('Expected plist');
  const events: string[] = [];
  const calls: string[] = [];
  const credential = 'ef'.repeat(32);
  const server = createServer();
  let statuses = 0;
  let stops = 0;
  const endpointWork = ['endpoint-work'];
  const sockets = createSocketServer({
    server, credential,
    info: { type: 'serverInfo', machineId: machineIdSchema.parse(randomUUID()), version: 'test', protocolVersion: PROTOCOL_VERSION },
    detached: () => undefined,
    request: async (peer, request) => {
      if (request.method === 'admin' && request.payload.type === 'daemonStatus') {
        statuses++; events.push('authenticated endpoint status');
        peer.send({ type: 'response', id: request.id, method: 'admin', payload: { kind: 'daemonStatus', status: {
          installed: false, running: true, selfHosted: true, version: 'test', supported: true, pid: process.pid,
        } } });
      } else if (request.method === 'machine' && request.payload.type === 'stopHost') { stops++; }
      else throw new Error('Unexpected endpoint request');
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing endpoint port');
  const stale = { ...owner, listen: `127.0.0.1:${address.port}` };
  expect(stale.pid).not.toBe(process.pid);
  const bytes = JSON.stringify(stale);
  const table = new Map<number, { generation: number; phase: 'running' | 'exited-unreaped'; manager: boolean; listen: string | null; work: string[]; signals: number }>();
  table.set(stale.pid, { generation: 0, phase: 'running', manager: true, listen: stale.listen, work: [], signals: 0 });
  let loaded = false;
  let published = false;
  let withdrawn = false;
  let reads = 0;
  let clock = 0;
  fixture.registration.mockImplementation(async () => {
    try { expect(await readFile(target.plistPath)).toEqual(Buffer.from(rendered.plist)); return { kind: 'ours', definition }; }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'absent' }; throw error; }
  });
  const stop = vi.fn(async (_home: string, lock: Parameters<typeof stopVerifiedOwner>[1]) => {
    events.push('O4');
    await stopVerifiedOwner(directory, lock);
  });
  const service = createLaunchdService({ root }, {
    home: directory, uid: 501, resolveRoot: async () => root,
    distribution: async () => ({ kind: 'global-npm', cliPath: '/cli' }), executable: '/node', capturedPath: '/bin',
    readOwner: async () => {
      if (!published) return null;
      expect(await readFile(join(directory, 'daemon.pid'), 'utf8')).toBe(bytes);
      if (withdrawn) { reads++; events.push(reads === 1 ? 'O1 stale lock' : reads === 2 ? 'O3 stale lock' : 'final stale lock'); }
      return stale;
    },
    verifyOwner: async () => { throw new Error('Readiness failed'); }, stopOwner: stop,
    open: (path, flags, mode) => open(String(path).startsWith('/owned/root/') ? join(directory, basename(String(path))) : path, flags, mode),
    unlink: async path => { await unlink(path); withdrawn = true; events.push('withdraw'); },
    now: () => clock, pause: async ms => { clock += ms; }, freePort: async () => 1234,
    run: async args => {
      calls.push(args[0] ?? '');
      if (args[0] === 'print' && args[1] === 'gui/501') return { ok: true, stdout: 'domain', stderr: '' };
      if (args[0] === 'bootstrap') {
        loaded = true; published = true;
        await writeFile(join(directory, 'daemon.pid'), bytes);
        return { ok: true, stdout: '', stderr: '' };
      }
      if (args[0] === 'print') {
        if (withdrawn && reads === 1) {
          expect(table.get(stale.pid)).toMatchObject({ generation: 0, work: [], signals: 0 });
          table.delete(stale.pid); events.push('modeled W exited and reaped');
          table.set(stale.pid, { generation: 1, phase: 'running', manager: true, listen: null, work: [], signals: 0 });
          events.push('modeled new manager child P');
          expect((await fixture.registration()).kind).toBe('absent');
          await runHostRuntime({ managed: false, control });
          untouched(); expect(fixture.owner).not.toHaveBeenCalled();
          expect(process.exitCode).toBe(0);
          expect(fixture.info).toHaveBeenCalledWith('daemon-startup', 'registration_absent', { kind: 'absent' });
          const child = table.get(stale.pid);
          if (!child) throw new Error('Missing manager child');
          child.phase = 'exited-unreaped';
          events.push('actual pre-lock returned 0 without listen');
          expect(await readFile(join(directory, 'daemon.pid'), 'utf8')).toBe(bytes);
          events.push('O2 unreaped manager P');
        }
        const pid = [...table].find(([, child]) => child.manager)?.[0];
        return loaded ? { ok: true, stdout: `gui/501/com.vonvon.bot.daemon = {\n\tstate = running\n\tpid = ${pid}\n}`, stderr: '' }
          : { ok: false, stdout: '', stderr: 'Could not find service' };
      }
      throw new Error(`Unexpected manager operation ${args[0]}`);
    },
  });
  try {
    await writeFile(join(directory, 'local-credential'), credential);
    const result = await service.install();
    expect(events).toEqual(['withdraw', 'O1 stale lock', 'modeled W exited and reaped', 'modeled new manager child P',
      'actual pre-lock returned 0 without listen', 'O2 unreaped manager P', 'O3 stale lock', 'O4', 'authenticated endpoint status', 'final stale lock']);
    expect(result.kind).toBe('install_incomplete');
    expect(result.detail).toContain('stop_unconfirmed');
    expect(result.detail).toContain(`PID ${stale.pid}`);
    expect(result.retained).toEqual({ pid: stale.pid, startedAt: stale.startedAt });
    expect(stop).toHaveBeenCalledOnce(); expect(statuses).toBe(1); expect(stops).toBe(0);
    expect(table.get(stale.pid)).toEqual({ generation: 1, phase: 'exited-unreaped', manager: true, listen: null, work: [], signals: 0 });
    expect(endpointWork).toEqual(['endpoint-work']);
    expect(await readFile(join(directory, 'daemon.pid'), 'utf8')).toBe(bytes);
    expect((await fixture.registration()).kind).toBe('absent');
    await expect(readFile(target.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toEqual(['print', 'print', 'bootstrap', 'print', 'print']);
    expect(loaded).toBe(true); untouched();
    expect(publishPidLock).not.toHaveBeenCalled();
  } finally {
    await sockets.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
