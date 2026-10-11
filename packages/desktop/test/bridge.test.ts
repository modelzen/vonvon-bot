import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { VonvonClient } from '@vonvon/client/browser';
import { desktopChannels, type AttachedDaemon, type DesktopResources } from '../src/ipc-contract.js';

const { handlers, openExternal, failRegistration } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  openExternal: vi.fn(async (_url: string) => {}),
  failRegistration: { channel: '' },
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
  const snapshot = vi.fn(async () => ({ revision: 1 }));
  const machine = vi.fn(async () => ({ type: 'done', message: 'ok' }));
  const dispose = vi.fn(async () => {});
  const client = {
    snapshot, machine,
    watchSnapshots: () => () => {},
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
    emitError: (error: Error) => onError(error) };
}

beforeEach(() => { handlers.clear(); openExternal.mockClear(); failRegistration.channel = ''; });

describe('desktop IPC boundary', () => {
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
    expect(h.webContents.send).toHaveBeenCalledExactlyOnceWith(desktopChannels.event, { type: 'snapshot', value: nextSnapshot });
    expect(await h.invoke(desktopChannels.snapshot)).toEqual({ ok: true, value: nextSnapshot });
    await h.bridge.dispose();
    expect(next.dispose).toHaveBeenCalledOnce();
  });

  it('leaves no stale owner when the new connection cannot provide a snapshot', async () => {
    const h = harness();
    const next = {
      client: { snapshot: vi.fn(async () => { throw new Error('snapshot failed'); }) },
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
