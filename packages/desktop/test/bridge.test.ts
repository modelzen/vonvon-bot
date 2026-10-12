import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { VonvonClient } from '@vonvon/client/browser';
import { ConnectionError, RpcError } from '@vonvon/client/browser';
import { desktopChannels, type AttachedDaemon, type DesktopResources } from '../src/ipc-contract.js';

const { handlers, openExternal, failRegistration } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  openExternal: vi.fn(async (_url: string) => {}),
  failRegistration: { channel: '' },
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => {
      if (name === failRegistration.channel) throw new Error('registration failed');
      handlers.set(name, handler);
    },
    removeHandler: (name: string) => { handlers.delete(name); },
  },
  shell: { openExternal },
}));

import { installBridge, openAllowedExternal } from '../src/bridge.js';
import { setLoginItem } from '../src/login-item.js';
import { createDesktopFacades } from '../src/facade.js';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'vonvon-bridge-test-'));
const uiIndex = join(fixtureRoot, 'index.html');
writeFileSync(uiIndex, '<!doctype html><title>Bridge test</title>');
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function harness() {
  const expectedUrl = pathToFileURL(realpathSync(uiIndex)).href;
  const frame = { url: expectedUrl };
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const window = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
  const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  let onError: (error: Error) => void = () => {};
  let onSnapshot: (value: unknown) => void = () => {};
  const snapshot = vi.fn(async () => ({ revision: 1, application: { platform: 'macos', version: '1', loginItem: false, dataPath: fixtureRoot } }));
  const machine = vi.fn(async (): ReturnType<VonvonClient['machine']> => ({ type: 'done', message: 'ok' }));
  const dispose = vi.fn(async () => {});
  const client = {
    snapshot, machine,
    watchSnapshots: (listener: (value: unknown) => void) => { onSnapshot = listener; return () => { onSnapshot = () => {}; }; },
    onLog: () => () => {},
    onBackendInstall: () => () => {},
    onError(listener: (error: Error) => void) { onError = listener; return () => {}; },
  } as unknown as VonvonClient;
  const owner: AttachedDaemon = {
    client, identity: { pid: 1, startedAt: 'now', listen: '127.0.0.1:4000' }, dispose,
  };
  const paths: DesktopResources = { uiIndex, preload: '/unused', trayPng: '/unused' };
  const actions = {
    startHost: vi.fn(async (_bot?: string) => ({ type: 'done' as const, message: 'started' })),
    service: vi.fn(async (_action: 'install' | 'start' | 'stop' | 'uninstall') => ({ type: 'done' as const, message: 'service updated' })),
    setLoginItem: vi.fn(async (_enabled: boolean) => {}),
    readLoginItem: vi.fn(async () => true),
    isExpectedDisconnect: vi.fn(() => false),
    repairCli: vi.fn(async () => ({ type: 'done' as const, message: 'installed' })),
    observeCli: vi.fn(async () => ({ kind: 'error' as const, message: 'not registered' })),
    chooseExecutablePath: vi.fn(async (): Promise<string | null> => '/usr/local/bin/codex'),
    checkDesktopUpdate: vi.fn(async () => ({ state: 'available' as const, current: '1.0.0', latest: '1.1.0', message: 'ready' })),
    installDesktopUpdate: vi.fn(async () => ({ state: 'downloaded' as const, current: '1.0.0', latest: '1.1.0', message: 'ready' })),
    hide: vi.fn(), confirmQuit: vi.fn(async () => {}), connectionLost: vi.fn(),
  };
  const bridge = installBridge(owner, window, paths, actions);
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing handler ${channel}`);
    return handler(event, ...args);
  };
  return { bridge, event, frame, webContents, window, paths, invoke, snapshot, machine, dispose, actions,
    emitSnapshot: (value: unknown) => onSnapshot(value),
    emitError: (error: Error) => onError(error) };
}

beforeEach(() => { handlers.clear(); openExternal.mockClear(); failRegistration.channel = ''; });

describe('desktop IPC boundary', () => {
  it('keeps service operations shell-owned and validates authorized arguments', async () => {
    const h = harness();
    const wrong = { ...h.event, senderFrame: { url: h.frame.url } } as IpcMainInvokeEvent;
    expect(await handlers.get(desktopChannels.service)?.(wrong, { type: 'service', action: 'install' })).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.service, { type: 'service', action: 'invalid' })).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.service, { type: 'service', action: 'install' }, 'extra')).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.setLoginItem, 'true')).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.setLoginItem, true, false)).toMatchObject({ ok: false });
    expect(h.actions.service).not.toHaveBeenCalled();
    expect(h.actions.setLoginItem).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.service, { type: 'service', action: 'install' })).toEqual({ ok: true, value: { type: 'done', message: 'service updated' } });
    expect(await h.invoke(desktopChannels.setLoginItem, true)).toEqual({ ok: true, value: undefined });
    expect(h.actions.service).toHaveBeenCalledWith('install');
    expect(h.actions.setLoginItem).toHaveBeenCalledWith(true);
    expect(await h.invoke(desktopChannels.machine, { type: 'service', action: 'install' })).toMatchObject({ ok: false });
    expect(h.machine).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });

  it('preserves a safe uninstall transaction result through the real helper, IPC and facade', async () => {
    const h = harness();
    h.actions.setLoginItem.mockImplementation(async enabled => {
      await setLoginItem(enabled, {
        platform: 'darwin', packaged: true, resources: '/private/app', executable: '/private/app/Vonvon',
        root: '/private/secret-root', env: {},
      }, {
        classifyDistribution: () => ({ kind: 'bundled', cliPath: '/private/app/cli' }),
        runCommand: async () => ({ code: 1, stdout: '', stderr: 'uninstall_incomplete: stop_unconfirmed: SECRET_TOKEN\nRetained PID 987654 (startedAt private).\nLeftover: /private/secret-root\nNext step: vonvon service uninstall\n' }),
        readRegistration: async () => ({ kind: 'ours' }),
        reattachAfterUninstall: async () => {},
      });
    });
    const expected = 'uninstall_incomplete: Service removal is incomplete. The daemon may still be running. Retry service uninstall.';
    const result = await h.invoke(desktopChannels.setLoginItem, false);
    expect(result).toEqual({ ok: false, error: { kind: 'validation', message: expected } });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_TOKEN|987654|secret-root|stop_unconfirmed/);
    const { shell } = createDesktopFacades({ invoke: h.invoke, receive: () => () => {} });
    await expect(shell.setLoginItem(false)).rejects.toThrow(expected);
    await h.bridge.dispose();
  });

  it.each([
    ['exact full buffer', `uninstall_incomplete: ${'界'.repeat(21838)}`, false],
    ['truncated at a UTF-8 boundary', `uninstall_incomplete: ${'界'.repeat(30000)}SECRET_SUFFIX`, false],
    ['truncated inside UTF-8', `uninstall_incomplete: x${'界'.repeat(30000)}SECRET_SUFFIX`, true],
  ] as const)('rejects a multibyte capture ceiling through runner, IPC and facade: %s', async (_name, output, splitCharacter) => {
    const bytes = Buffer.from(output);
    const captured = bytes.subarray(0, 65536).toString('utf8');
    expect(bytes.length).toBeGreaterThanOrEqual(65536);
    expect(captured.length).toBeLessThan(65536);
    expect(captured.endsWith('\uFFFD')).toBe(splitCharacter);
    const h = harness();
    const child = new ChildProcess();
    const stderr = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = stderr;
    vi.mocked(spawn).mockReturnValueOnce(child);
    const readRegistration = vi.fn(async () => ({ kind: 'ours' as const }));
    const reattachAfterUninstall = vi.fn(async () => {});
    h.actions.setLoginItem.mockImplementation(async enabled => {
      await setLoginItem(enabled, {
        platform: 'darwin', packaged: true, resources: '/private/app', executable: '/private/app/Vonvon',
        root: '/private/secret-root', env: {},
      }, {
        classifyDistribution: () => ({ kind: 'bundled', cliPath: '/private/app/cli' }),
        readRegistration, reattachAfterUninstall,
      });
    });
    let reply: unknown;
    const { shell } = createDesktopFacades({
      invoke: async (channel, ...args) => {
        const result = await h.invoke(channel, ...args);
        if (channel === desktopChannels.setLoginItem) reply = result;
        return result;
      },
      receive: () => () => {},
    });
    try {
      const rejected = expect(shell.setLoginItem(false)).rejects.toThrow('Desktop request failed');
      stderr.write(bytes);
      child.emit('close', 1, null);
      await rejected;
      expect(reply).toEqual({ ok: false, error: { kind: 'validation', message: 'Desktop request failed' } });
      expect(JSON.stringify(reply)).not.toMatch(/SECRET_SUFFIX|界|secret-root|uninstall_incomplete/);
      expect(readRegistration).not.toHaveBeenCalled();
      expect(reattachAfterUninstall).not.toHaveBeenCalled();
    } finally { await h.bridge.dispose(); }
  });

  it.each([
    [true, 'install_refused', 'Service installation was refused. Check the service registration before retrying.'],
    [true, 'install_rolled_back', 'Service installation failed and was rolled back. Check service status before retrying.'],
    [true, 'install_incomplete', 'Service installation is incomplete. Check service status and retry service install or uninstall.'],
    [false, 'uninstall_refused', 'Service removal was refused. Check the service registration before retrying.'],
    [false, 'uninstall_rolled_back', 'Service removal failed and was rolled back. Check service status before retrying.'],
    [false, 'uninstall_incomplete', 'Service removal is incomplete. The daemon may still be running. Retry service uninstall.'],
  ] as const)('preserves only the allowlisted %s %s result', async (enabled, outcome, explanation) => {
    const h = harness();
    const readRegistration = vi.fn(async () => ({ kind: 'ours' as const }));
    const reattachAfterUninstall = vi.fn(async () => {});
    h.actions.setLoginItem.mockImplementation(async value => {
      await setLoginItem(value, {
        platform: 'darwin', packaged: true, resources: '/private/app', executable: '/private/app/Vonvon', root: '/private/secret-root', env: {},
      }, {
        classifyDistribution: () => ({ kind: 'bundled', cliPath: '/private/app/cli' }),
        runCommand: async () => ({ code: 1, stdout: '', stderr: `${outcome}: SECRET_TOKEN\nLeftover: /private/secret-root\n` }),
        readRegistration, reattachAfterUninstall,
      });
    });
    const result = await h.invoke(desktopChannels.setLoginItem, enabled);
    expect(result).toEqual({ ok: false, error: { kind: 'validation', message: `${outcome}: ${explanation}` } });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_TOKEN|secret-root|cause|stack/);
    expect(readRegistration).not.toHaveBeenCalled();
    expect(reattachAfterUninstall).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });

  it.each([
    ['prefix', 1, '', 'SECRET_TOKEN uninstall_incomplete: detail'],
    ['token suffix', 1, '', 'uninstall_incomplete_SECRET_TOKEN: detail'],
    ['multiline prefix', 1, '', 'SECRET_TOKEN\nuninstall_incomplete: detail'],
    ['truncated at capture limit', 1, '', 'uninstall_incomplete: '.padEnd(65536, 'x')],
    ['overlong', 1, '', `uninstall_incomplete: ${'x'.repeat(65536)}SECRET_TOKEN`],
    ['unknown', 1, '', 'unknown_result: SECRET_TOKEN'],
    ['wrong action', 1, '', 'install_incomplete: SECRET_TOKEN'],
    ['wrong exit', 7, '', 'uninstall_incomplete: SECRET_TOKEN'],
    ['stdout only', 1, 'uninstall_incomplete: SECRET_TOKEN', ''],
    ['mixed streams', 1, 'SECRET_TOKEN', 'uninstall_incomplete: detail'],
    ['missing delimiter', 1, '', 'uninstall_incomplete\n'],
  ] as const)('sanitizes untrusted command output %s', async (_name, code, stdout, stderr) => {
    const h = harness();
    h.actions.setLoginItem.mockImplementation(async enabled => {
      await setLoginItem(enabled, {
        platform: 'darwin', packaged: true, resources: '/private/app', executable: '/private/app/Vonvon', root: '/private/secret-root', env: {},
      }, {
        classifyDistribution: () => ({ kind: 'bundled', cliPath: '/private/app/cli' }),
        runCommand: async () => ({ code, stdout, stderr }),
        readRegistration: async () => ({ kind: 'ours' }), reattachAfterUninstall: async () => {},
      });
    });
    const result = await h.invoke(desktopChannels.setLoginItem, false);
    expect(result).toEqual({ ok: false, error: { kind: 'validation', message: 'Desktop request failed' } });
    expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
    await h.bridge.dispose();
  });

  it('keeps arbitrary errors and RPC diagnostics sanitized', async () => {
    const h = harness();
    h.actions.setLoginItem.mockRejectedValueOnce(new Error('uninstall_incomplete: SECRET_TOKEN'));
    expect(await h.invoke(desktopChannels.setLoginItem, false)).toEqual({ ok: false, error: { kind: 'validation', message: 'Desktop request failed' } });
    h.machine.mockRejectedValueOnce(new RpcError('safe_code', 'SECRET_TOKEN'));
    expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toEqual({ ok: false, error: { kind: 'rpc', code: 'safe_code', message: 'Daemon request failed' } });
    await h.bridge.dispose();
  });

  it.each([
    ['unsupported', 'Open at login is unavailable on this platform. Start the application manually.'],
    ['unpackaged', 'Open at login requires the packaged desktop application.'],
    ['distribution', 'The bundled Vonvon daemon is unavailable. Reinstall the desktop application.'],
    ['readback', 'The service registration could not be verified. Check service status before retrying.'],
    ['mismatch', 'The service registration does not match the requested setting. Check service status before retrying.'],
    ['reattach', 'The service was removed, but the desktop could not reconnect. Reopen the desktop application.'],
  ] as const)('exposes a bounded local service failure for %s', async (stage, message) => {
    const h = harness();
    h.actions.setLoginItem.mockImplementation(async enabled => {
      await setLoginItem(enabled, {
        platform: stage === 'unsupported' ? 'linux' : 'darwin', packaged: stage !== 'unpackaged',
        resources: '/SECRET_TOKEN', executable: '/SECRET_TOKEN/Vonvon', root: '/SECRET_TOKEN/root', env: {},
      }, {
        classifyDistribution: () => ({ kind: stage === 'distribution' ? 'unknown' : 'bundled', cliPath: '/SECRET_TOKEN/cli' }),
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
        readRegistration: async () => {
          if (stage === 'readback') throw new Error('SECRET_TOKEN');
          return { kind: stage === 'mismatch' ? 'ours' : 'absent' };
        },
        reattachAfterUninstall: async () => { if (stage === 'reattach') throw new Error('SECRET_TOKEN'); },
      });
    });
    const result = await h.invoke(desktopChannels.setLoginItem, false);
    expect(result).toEqual({ ok: false, error: { kind: 'validation', message } });
    expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
    await h.bridge.dispose();
  });

  it('reports the desktop registration in its snapshot', async () => {
    const h = harness();
    expect(await h.invoke(desktopChannels.snapshot)).toMatchObject({ ok: true, value: { application: { loginItem: true } } });
    expect(h.actions.readLoginItem).toHaveBeenCalledOnce();
    await h.bridge.dispose();
  });

  it('coalesces registration reads and emits only the newest snapshot', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    let release!: (enabled: boolean) => void;
    h.actions.readLoginItem.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
    h.emitSnapshot({ revision: 2, application: { platform: 'macos', version: '1', loginItem: false, dataPath: fixtureRoot } });
    h.emitSnapshot({ revision: 3, application: { platform: 'macos', version: '1', loginItem: false, dataPath: fixtureRoot } });
    expect(h.actions.readLoginItem).toHaveBeenCalledOnce();
    release(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.webContents.send).toHaveBeenCalledTimes(1);
    expect(h.webContents.send).toHaveBeenCalledWith(desktopChannels.event, { type: 'snapshot', value: expect.objectContaining({ revision: 3, application: expect.objectContaining({ loginItem: true }) }) });
    await h.bridge.dispose();
  });

  it('does not report an expected service drain as a lost connection', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    h.actions.isExpectedDisconnect.mockReturnValue(true);
    h.emitError(new ConnectionError('controlled stop'));
    expect(h.actions.connectionLost).not.toHaveBeenCalled();
    expect(h.webContents.send).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });
  it('authorizes zero-argument CLI repair and overlays readonly CLI status', async () => {
    const h = harness();
    const wrongFrame = { ...h.event, senderFrame: { url: h.frame.url } } as IpcMainInvokeEvent;
    const wrongSender = { ...h.event, sender: {} } as IpcMainInvokeEvent;
    expect(await handlers.get(desktopChannels.repairCli)?.(wrongFrame)).toMatchObject({ ok: false });
    expect(await handlers.get(desktopChannels.repairCli)?.(wrongSender)).toMatchObject({ ok: false });
    h.frame.url = 'https://example.invalid';
    expect(await h.invoke(desktopChannels.repairCli)).toMatchObject({ ok: false });
    h.frame.url = pathToFileURL(realpathSync(uiIndex)).href;
    expect(await h.invoke(desktopChannels.repairCli, { type: 'repairCli' })).toMatchObject({ ok: false });
    expect(h.actions.repairCli).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.repairCli)).toEqual({ ok: true, value: { type: 'done', message: 'installed' } });
    h.actions.repairCli.mockResolvedValueOnce({ type: 'invalid', message: 'bad' } as never);
    expect(await h.invoke(desktopChannels.repairCli)).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.machine, { type: 'repairCli' })).toMatchObject({ ok: false });
    expect(h.machine).not.toHaveBeenCalled();
    h.machine.mockResolvedValueOnce({ type: 'status', service: { platformName: 'macos', installed: false, running: false, servicePath: '', stdoutPath: '', stderrPath: '' }, host: null,
      cli: { kind: 'ready', bin: '/wrong', message: 'internal' } });
    expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toMatchObject({ ok: true, value: { cli: { kind: 'error', message: 'not registered' } } });
    expect(h.actions.observeCli).toHaveBeenCalledOnce();
    await h.bridge.dispose();
  });
  it('authorizes and validates the shell start request before forwarding the selected Bot', async () => {
    const h = harness();
    const wrong = { ...h.event, senderFrame: { url: h.frame.url } } as IpcMainInvokeEvent;
    expect(await handlers.get(desktopChannels.startHost)?.(wrong, { type: 'startHost' })).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.startHost, { type: 'startHost', bot: 42 })).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.startHost, { type: 'startHost', bot: '' })).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.startHost, { type: 'startHost' }, 'extra')).toMatchObject({ ok: false });
    expect(h.actions.startHost).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.startHost, { type: 'startHost' })).toEqual({ ok: true, value: { type: 'done', message: 'started' } });
    expect(await h.invoke(desktopChannels.startHost, { type: 'startHost', bot: 'cli_exact_Bot_ID' })).toMatchObject({ ok: true });
    expect(h.actions.startHost.mock.calls).toEqual([[undefined], ['cli_exact_Bot_ID']]);
    expect(h.machine).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });

  it('moves requests and events to the new owner and disposes the old connection', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    const nextSnapshot = { revision: 1 };
    let emitOld: ((value: unknown) => void) | undefined;
    let emitNext: ((value: unknown) => void) | undefined;
    const offOld = vi.fn();
    const old = {
      client: {
        snapshot: vi.fn(async () => ({ revision: 9 })),
        watchSnapshots: (listener: (value: unknown) => void) => { emitOld = listener; return offOld; },
        onLog: () => () => {}, onBackendInstall: () => () => {}, onError: () => () => {},
      },
      identity: { pid: 2, startedAt: 'old', listen: '127.0.0.1:4001' },
      dispose: vi.fn(async () => {}),
    } as unknown as AttachedDaemon;
    await h.bridge.replaceOwner(old);
    const next = {
      client: {
        snapshot: vi.fn(async () => nextSnapshot),
        watchSnapshots: (listener: (value: unknown) => void) => { emitNext = listener; return () => {}; },
        onLog: () => () => {}, onBackendInstall: () => () => {}, onError: () => () => {},
      },
      identity: { pid: 3, startedAt: 'new', listen: '127.0.0.1:4002' },
      dispose: vi.fn(async () => {}),
    } as unknown as AttachedDaemon;
    await h.bridge.replaceOwner(next);
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(offOld).toHaveBeenCalledOnce();
    h.webContents.send.mockClear();
    emitOld?.({ revision: 10 });
    emitNext?.(nextSnapshot);
    await Promise.resolve();
    expect(h.webContents.send).toHaveBeenCalledExactlyOnceWith(desktopChannels.event, { type: 'snapshot', value: { revision: 1, application: { loginItem: true } } });
    expect(await h.invoke(desktopChannels.snapshot)).toEqual({ ok: true, value: { revision: 1, application: { loginItem: true } } });
    await h.bridge.dispose();
    expect(next.dispose).toHaveBeenCalledOnce();
  });

  it('leaves no stale owner when the new connection cannot provide a snapshot', async () => {
    const h = harness();
    const next = {
      client: { snapshot: vi.fn(async () => { throw new Error('snapshot failed'); }), watchSnapshots: () => () => {}, onLog: () => () => {}, onBackendInstall: () => () => {}, onError: () => () => {} },
      identity: { pid: 4, startedAt: 'new', listen: '127.0.0.1:4003' },
      dispose: vi.fn(async () => {}),
    } as unknown as AttachedDaemon;
    await expect(h.bridge.replaceOwner(next)).rejects.toThrow('snapshot failed');
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(next.dispose).toHaveBeenCalledOnce();
    expect(await h.invoke(desktopChannels.snapshot)).toMatchObject({ ok: false });
    await h.bridge.dispose();
    expect(h.dispose).toHaveBeenCalledOnce();
  });
  it('rejects replacement before reattached when registration cannot be read', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    h.actions.readLoginItem.mockRejectedValueOnce(new Error('registration unavailable'));
    const next = {
      client: { snapshot: vi.fn(async () => ({ revision: 1 })), watchSnapshots: () => () => {}, onLog: () => () => {}, onBackendInstall: () => () => {}, onError: () => () => {} },
      identity: { pid: 4, startedAt: 'new', listen: '127.0.0.1:4003' },
      dispose: vi.fn(async () => {}),
    } as unknown as AttachedDaemon;
    await expect(h.bridge.replaceOwner(next)).rejects.toThrow('registration unavailable');
    expect(next.dispose).toHaveBeenCalledOnce();
    expect(h.webContents.send).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });
  it('exposes updater only to the authorized top-level document', async () => {
    const h = harness();
    const wrong = { ...h.event, senderFrame: { url: h.frame.url } } as IpcMainInvokeEvent;
    expect(await handlers.get(desktopChannels.checkDesktopUpdate)?.(wrong)).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.installDesktopUpdate, 'extra')).toMatchObject({ ok: false });
    expect(h.actions.checkDesktopUpdate).not.toHaveBeenCalled();
    expect(h.actions.installDesktopUpdate).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.checkDesktopUpdate)).toMatchObject({ ok: true, value: { state: 'available' } });
    expect(await h.invoke(desktopChannels.installDesktopUpdate)).toMatchObject({ ok: true, value: { state: 'downloaded' } });
    expect(h.machine).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });
  it('returns a selected path or cancellation only to the authorized document', async () => {
    const h = harness();
    const wrong = { ...h.event, senderFrame: { url: h.frame.url } } as IpcMainInvokeEvent;
    expect(await handlers.get(desktopChannels.chooseExecutablePath)?.(wrong)).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.chooseExecutablePath, 'extra')).toMatchObject({ ok: false });
    expect(h.actions.chooseExecutablePath).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.chooseExecutablePath)).toEqual({ ok: true, value: '/usr/local/bin/codex' });
    h.actions.chooseExecutablePath.mockResolvedValueOnce(null);
    expect(await h.invoke(desktopChannels.chooseExecutablePath)).toEqual({ ok: true, value: null });
    expect(h.actions.chooseExecutablePath).toHaveBeenCalledTimes(2);
    h.frame.url += '#fragment';
    expect(await h.invoke(desktopChannels.chooseExecutablePath)).toMatchObject({ ok: false });
    expect(h.actions.chooseExecutablePath).toHaveBeenCalledTimes(2);
    await h.bridge.dispose();
  });

  it('checks sender, main frame and exact document before parsing or invoking', async () => {
    const h = harness();
    const wrong = { ...h.event, senderFrame: { url: h.frame.url } } as IpcMainInvokeEvent;
    expect(await handlers.get(desktopChannels.run)?.(wrong, { type: 'refresh' })).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.snapshot, 'extra')).toMatchObject({ ok: false });
    h.frame.url += '#fragment';
    expect(await h.invoke(desktopChannels.snapshot)).toMatchObject({ ok: false });
    expect(h.snapshot).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });

  it('refuses shell-owned machine actions and dispatches daemon-owned methods', async () => {
    const h = harness();
    expect(await h.invoke(desktopChannels.machine, { type: 'service', action: 'stop' })).toMatchObject({ ok: false });
    expect(h.machine).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.machine, { type: 'logs' })).toMatchObject({ ok: true });
    expect(h.machine).toHaveBeenCalledWith({ type: 'logs' });
    expect(await h.invoke(desktopChannels.machine, { type: 'stopHost' })).toMatchObject({ ok: true });
    expect(h.machine).toHaveBeenCalledWith({ type: 'stopHost' });
    await h.bridge.dispose();
  });

  it('buffers errors and quit intent until subscription, then tears down once', async () => {
    const h = harness();
    h.emitError(new Error('raw credential 0123456789'));
    h.bridge.requestQuit();
    expect(h.webContents.send).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.subscribe)).toMatchObject({ ok: true });
    expect(h.webContents.send).toHaveBeenCalledWith(desktopChannels.event,
      { type: 'error', value: { kind: 'validation', message: 'Desktop request failed' } });
    expect(h.webContents.send).toHaveBeenCalledWith(desktopChannels.event, { type: 'quitRequested' });
    h.bridge.requestQuit();
    expect(h.webContents.send).toHaveBeenCalledTimes(3);
    await Promise.all([h.bridge.dispose(), h.bridge.dispose()]);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(handlers.has(desktopChannels.machine)).toBe(false);
  });

  it('accepts only URLs covered by the frozen six-kind allowlist', async () => {
    await openAllowedExternal('https://github.com/modelzen/vonvon-bot/releases');
    expect(openExternal).toHaveBeenCalledWith('https://github.com/modelzen/vonvon-bot/releases');
    await expect(openAllowedExternal('https://github.com.evil.test/modelzen/vonvon-bot/releases'))
      .rejects.toThrow('Unsupported external link');
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('removes earlier handlers if bridge installation fails', () => {
    failRegistration.channel = desktopChannels.directory;
    expect(() => harness()).toThrow('registration failed');
    expect(handlers.size).toBe(0);
  });
});

it('serves installed/stopped status after stop closes RPC, then uses the reattached owner', async () => {
  const h = harness();
  const status = { type: 'status' as const, host: { ownership: 'owned' as const, pid: 1 },
    service: { platformName: 'macos', installed: true, running: true, pid: '1', servicePath: '', stdoutPath: '', stderrPath: '' },
    cli: { kind: 'ready' as const, bin: '/bin/vonvon', message: 'ready' } };
  h.machine.mockResolvedValue(status);
  h.actions.service.mockImplementation(async () => {
    h.machine.mockRejectedValue(new ConnectionError('stopped'));
    return { type: 'done', message: 'stopped' };
  });
  expect(await h.invoke(desktopChannels.service, { type: 'service', action: 'stop' })).toMatchObject({ ok: true });
  expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toMatchObject({ ok: true, value: { host: null, service: { installed: true, running: false } } });
  expect(h.machine).toHaveBeenCalledTimes(1);
  const next = { client: { snapshot: async () => ({ revision: 1 }), machine: async () => ({ ...status, host: { ownership: 'owned', pid: 2 } }),
    watchSnapshots: () => () => {}, onLog: () => () => {}, onBackendInstall: () => () => {}, onError: () => () => {} },
    identity: { pid: 2, startedAt: 'next', listen: '127.0.0.1:4000' }, dispose: async () => {} } as unknown as AttachedDaemon;
  await h.bridge.replaceOwner(next);
  expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toMatchObject({ ok: true, value: { host: { pid: 2 }, service: { running: true } } });
  await h.bridge.dispose();
});

it('cleans partial bindings without announcing a failed reattachment', async () => {
  const h = harness();
  await h.invoke(desktopChannels.subscribe);
  const off = vi.fn();
  const next = { client: { watchSnapshots: () => off, onLog: () => { throw new Error('bind failed'); } },
    dispose: vi.fn(async () => {}) } as unknown as AttachedDaemon;
  await expect(h.bridge.replaceOwner(next)).rejects.toThrow('bind failed');
  expect(off).toHaveBeenCalledOnce();
  expect(h.webContents.send).not.toHaveBeenCalled();
  expect(next.dispose).toHaveBeenCalledOnce();
  await h.bridge.dispose();
});

it.each(['synchronous', 'pending'] as const)('preserves a newer %s watch snapshot during reattachment', async timing => {
  const h = harness();
  await h.invoke(desktopChannels.subscribe);
  let emit: (value: unknown) => void = () => {};
  const next = { client: {
    snapshot: async () => { if (timing === 'pending') { await Promise.resolve(); emit({ revision: 5 }); } return { revision: 1 }; },
    watchSnapshots: (listener: typeof emit) => { emit = listener; if (timing === 'synchronous') emit({ revision: 5 }); return () => {}; },
    onLog: () => () => {}, onBackendInstall: () => () => {}, onError: () => () => {},
  }, dispose: async () => {} } as unknown as AttachedDaemon;
  await h.bridge.replaceOwner(next);
  expect(h.webContents.send.mock.calls.map(call => call[1])).toEqual([
    { type: 'reattached' }, { type: 'snapshot', value: { revision: 5, application: { loginItem: true } } },
  ]);
  await h.bridge.dispose();
});

it('publishes actual registration after install and uninstall without daemon pushes', async () => {
  const h = harness();
  await h.invoke(desktopChannels.subscribe);
  let installed = false;
  h.actions.readLoginItem.mockImplementation(async () => installed);
  h.actions.service.mockImplementation(async action => { installed = action === 'install'; return { type: 'done', message: 'updated' }; });
  await h.invoke(desktopChannels.service, { type: 'service', action: 'install' });
  await h.invoke(desktopChannels.service, { type: 'service', action: 'uninstall' });
  expect(h.webContents.send.mock.calls.map(call => call[1].value.application.loginItem)).toEqual([true, false]);
  await h.bridge.dispose();
});
