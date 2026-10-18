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
import { ServiceActionError } from '../src/service-error.js';

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

import { installBridge, openAllowedExternal, sanitizeDaemonMessage } from '../src/bridge.js';
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
  const run = vi.fn(async (): ReturnType<VonvonClient['run']> => ({ kind: 'applied', revision: 2 }));
  const client = {
    snapshot, machine, run,
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
    restartHost: vi.fn(async (_previous: AttachedDaemon['identity'], send: () => ReturnType<VonvonClient['run']>) => send()),
    service: vi.fn(async (_action: 'install' | 'start' | 'stop' | 'uninstall', _previous?: AttachedDaemon['identity'] | null) => ({ type: 'done' as const, message: 'service updated' })),
    setLoginItem: vi.fn(async (_enabled: boolean, _previous?: AttachedDaemon['identity'] | null) => {}),
    isExpectedDisconnect: vi.fn(() => false),
    recoverConnection: vi.fn((_lost: AttachedDaemon['identity']) => false),
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
  return { bridge, event, frame, webContents, window, paths, invoke, snapshot, machine, run, dispose, actions, owner,
    emitSnapshot: (value: unknown) => onSnapshot(value),
    emitError: (error: Error) => onError(error) };
}

beforeEach(() => { handlers.clear(); openExternal.mockClear(); failRegistration.channel = ''; });

describe('desktop IPC boundary', () => {
  it('hands a daemon restart to the shell with the attached owner and forwards other commands', async () => {
    const h = harness();
    expect(await h.invoke(desktopChannels.run, { type: 'restartHost' })).toEqual({ ok: true, value: { kind: 'applied', revision: 2 } });
    expect(h.actions.restartHost).toHaveBeenCalledExactlyOnceWith({ pid: 1, startedAt: 'now', listen: '127.0.0.1:4000' }, expect.any(Function));
    expect(h.run).toHaveBeenCalledExactlyOnceWith({ type: 'restartHost' });
    expect(await h.invoke(desktopChannels.run, { type: 'refresh' })).toEqual({ ok: true, value: { kind: 'applied', revision: 2 } });
    expect(h.actions.restartHost).toHaveBeenCalledOnce();
    expect(h.run).toHaveBeenLastCalledWith({ type: 'refresh' });
  });

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
    expect(h.actions.service).toHaveBeenCalledWith('install', h.owner.identity);
    expect(h.actions.setLoginItem).toHaveBeenCalledWith(true, h.owner.identity);
    expect(await h.invoke(desktopChannels.machine, { type: 'service', action: 'install' })).toMatchObject({ ok: false });
    // Only the two refreshes after the switches reached the daemon.
    expect(h.machine.mock.calls).toEqual([[{ type: 'status' }], [{ type: 'status' }]]);
    await h.bridge.dispose();
  });

  it('masks arbitrary errors and passes daemon messages through sanitized', async () => {
    const h = harness();
    h.actions.setLoginItem.mockRejectedValueOnce(new Error('uninstall_incomplete: SECRET_TOKEN'));
    expect(await h.invoke(desktopChannels.setLoginItem, false)).toEqual({ ok: false, error: { kind: 'validation', message: 'Desktop request failed' } });
    h.actions.setLoginItem.mockRejectedValueOnce(new ServiceActionError('report', '没关掉：launchctl said token=t-g1044abcdefghijklmnopqrstuvwxyz0123'));
    expect(await h.invoke(desktopChannels.setLoginItem, false)).toEqual({ ok: false, error: { kind: 'validation', message: '没关掉：launchctl said token=…' } });
    h.actions.setLoginItem.mockRejectedValueOnce(new ServiceActionError('busy'));
    expect(await h.invoke(desktopChannels.setLoginItem, true)).toEqual({ ok: false, error: { kind: 'validation', message: '另一个后台服务操作正在进行，等它结束再试。' } });
    h.machine.mockRejectedValueOnce(new RpcError('upstream', '缺少飞书权限 im:chat:readonly（读取群信息）。\n在 Bot 设置点「一键开权限」。'));
    expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toEqual({ ok: false, error: {
      kind: 'rpc', code: 'upstream', message: '缺少飞书权限 im:chat:readonly（读取群信息）。 在 Bot 设置点「一键开权限」。' } });
    h.machine.mockRejectedValueOnce(new RpcError('bad code\n', 'Bot 没启用或没在运行'));
    expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toEqual({ ok: false, error: { kind: 'rpc', message: 'Bot 没启用或没在运行' } });
    await h.invoke(desktopChannels.subscribe);
    h.emitError(new RpcError('conflict', 'token=t-g1044abcdefghijklmnopqrstuvwxyz0123'));
    expect(h.webContents.send).toHaveBeenLastCalledWith(desktopChannels.event, { type: 'error', value: { kind: 'rpc', code: 'conflict', message: 'token=…' } });
    await h.bridge.dispose();
  });

  it.each([
    ['control and format characters', 'a\u0000b\u001b[31mc\u202ed\u200be\r\n\tf', 'a b [31mcde f'],
    ['URL credentials, queries and fragments', '打不开 https://user:pa55@open.feishu.cn/app/cli_a/auth?q=im:chat&token=x#frag 和 http://127.0.0.1:4000/x?credential=y',
      '打不开 https://open.feishu.cn/app/cli_a/auth 和 http://127.0.0.1:4000/x'],
    ['bearer tokens', 'Authorization: Bearer abc.def-123 failed', 'Authorization: …'],
    ['quoted auth headers and bare schemes', "headers: {authorization: 'Basic dXNlcjpwYXNz'} then Bearer eyJhbGciOiJIUzI1NiJ9.e30 rejected",
      "headers: {authorization: '…'} then Bearer … rejected"],
    ['API keys', 'Invalid API key sk-ant-api03-abcdefghijklmnop, api_key=abc, apiKey: "xyz"', 'Invalid API key …, api_key=…, apiKey: "…"'],
    ['credential-shaped values after an unquoted label', 'password: hunter22 and token: 0123456789abcdef', 'password: … and token: …'],
    ['ordinary words after bearer, basic or a secret label', 'Basic settings are invalid. Invalid token: expired; tokens: 1234 used',
      'Basic settings are invalid. Invalid token: expired; tokens: 1234 used'],
    ['file paths, which the web UI shows too', 'ENOENT: no such file /home/ops/.vonvon/bots/cli_a/setup.json', 'ENOENT: no such file /home/ops/.vonvon/bots/cli_a/setup.json'],
    ['secret-style values', 'unsupported secret form: {"app_secret":"s3cr3t","password":\'pw\', token = abc}', 'unsupported secret form: {"app_secret":"…","password":\'…\', token = …}'],
    ['quoted values with spaces, commas, the other quote or escapes', String.raw`{"app_secret":"abc def ghi"} {"secret":"a,b-c-d"} client_secret = "s e c" {"password":"it's a secret"} {"password":"ab\"cd ef"} secret:'a"b c' end`,
      String.raw`{"app_secret":"…"} {"secret":"…"} client_secret = "…" {"password":"…"} {"password":"…"} secret:'…' end`],
    ...['Bearer abcdefghijkl', 'Basic dXNlcjpwYXNz', 'Token abcdefgh12345678', 'Digest username="bob", response="deadbeef"']
      .map(value => [`an Authorization value under ${value.split(' ')[0]}`, `Authorization: ${value}`, 'Authorization: …']),
    ['authorization= under any scheme', 'headers: {authorization=Token abcdefgh}', 'headers: {authorization=…'],
    ['a quoted Authorization key with an unquoted value', '{"authorization": Token abc12345}', '{"authorization": …'],
    ['a long quoted value with spaces', `secret: "${'a'.repeat(260)} leaked words" end`, 'secret: "…" end'],
    ['base64 and base64url after Basic', 'Basic dXNlcjpwYXNz; Basic YTpi; Basic dXNlcjpw-Xz', 'Basic …; Basic …; Basic …'],
    ['a short token after Bearer', 'then Bearer abcdefghijkl rejected', 'then Bearer … rejected'],
    ['capitalised words after Basic', 'Basic Settings are invalid. Basic HTTP auth is off. Basic Information missing',
      'Basic Settings are invalid. Basic HTTP auth is off. Basic Information missing'],
    ['bare Feishu access tokens', 'invalid access t-g1044ghJRUIJJ5ELPPA7VQ5XWQUQAP4XMYWC4P7S here', 'invalid access … here'],
    ['empty text', ' \u0000 ', 'Daemon request failed'],
  ])('sanitizes %s in daemon messages', (_name, raw, expected) => {
    expect(sanitizeDaemonMessage(raw)).toBe(expected);
  });

  it('scans only the start of a huge daemon message, so the patterns cannot stall the main process', () => {
    for (const raw of ['a-'.repeat(50_000), 'a.'.repeat(50_000), 'a://'.repeat(25_000), 'token '.repeat(20_000), 'secret:"'.repeat(15_000), 'basic '.repeat(20_000), '😀'.repeat(100_000)]) {
      const started = performance.now();
      const text = sanitizeDaemonMessage(raw);
      expect(performance.now() - started).toBeLessThan(250);
      expect(Array.from(text).length).toBeLessThanOrEqual(300);
    }
    // The cut lands inside a Feishu token after a long query string; its first characters must not show.
    const raw = `打不开 https://h/p?${'q'.repeat(1975)} t-g1044abcdefghijklmnopqrstuvwxyz0123`;
    expect(sanitizeDaemonMessage(raw)).toBe('打不开 https://h/p…');
  });

  it('caps daemon messages at 300 characters without splitting a character', () => {
    expect(sanitizeDaemonMessage('群'.repeat(300))).toBe('群'.repeat(300));
    const capped = sanitizeDaemonMessage('😀'.repeat(400));
    expect(Array.from(capped)).toHaveLength(300);
    expect(capped.endsWith('😀…')).toBe(true);
  });

  it('passes the daemon\'s snapshot through, login item included', async () => {
    const h = harness();
    expect(await h.invoke(desktopChannels.snapshot)).toEqual({ ok: true, value: await h.snapshot() });
    await h.invoke(desktopChannels.subscribe);
    const application = { platform: 'macos', version: '1', loginItem: true, dataPath: fixtureRoot, service: { state: 'running', skipped: false } };
    h.emitSnapshot({ revision: 2, application });
    h.emitSnapshot({ revision: 1, application: { ...application, loginItem: false } });
    h.emitSnapshot({ revision: 3, application: { ...application, loginItem: false } });
    expect(h.webContents.send.mock.calls.map(call => call[1])).toEqual([
      { type: 'snapshot', value: { revision: 2, application } },
      { type: 'snapshot', value: { revision: 3, application: { ...application, loginItem: false } } },
    ]);
    await h.bridge.dispose();
  });

  it('hands a drop during a helper started elsewhere to the shell instead of reporting it', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    h.actions.recoverConnection.mockReturnValue(true);
    h.emitError(new ConnectionError('drained by the web UI\'s helper'));
    expect(h.actions.recoverConnection).toHaveBeenCalledExactlyOnceWith(h.owner.identity);
    expect(h.actions.connectionLost).not.toHaveBeenCalled();
    expect(h.webContents.send).not.toHaveBeenCalled();
    h.actions.recoverConnection.mockReturnValue(false);
    h.emitError(new ConnectionError('daemon crashed'));
    expect(h.actions.connectionLost).toHaveBeenCalledOnce();
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
    expect(h.webContents.send).toHaveBeenCalledExactlyOnceWith(desktopChannels.event, { type: 'snapshot', value: { revision: 1 } });
    expect(await h.invoke(desktopChannels.snapshot)).toEqual({ ok: true, value: { revision: 1 } });
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

function candidate(snapshot: () => Promise<unknown>) {
  let close: () => void = () => {};
  const closed = new Promise<never>((_resolve, reject) => { close = () => reject(new Error('connection closed')); });
  closed.catch(() => {});
  const dispose = vi.fn(async () => { close(); });
  const owner = { client: {
    snapshot: vi.fn(() => Promise.race([snapshot(), closed])),
    watchSnapshots: () => () => {}, onLog: () => () => {}, onBackendInstall: () => () => {}, onError: () => () => {},
  }, identity: { pid: 2, startedAt: 'next', listen: '127.0.0.1:4001' }, dispose } as unknown as AttachedDaemon;
  return { owner, dispose };
}

it('closes a replacement candidate whose first snapshot is pending when the bridge is disposed', async () => {
  const h = harness();
  await h.invoke(desktopChannels.subscribe);
  const next = candidate(() => new Promise(() => {}));
  const replacing = expect(h.bridge.replaceOwner(next.owner)).rejects.toThrow();
  await vi.waitFor(() => expect(next.owner.client.snapshot).toHaveBeenCalled());
  await h.bridge.dispose();
  await replacing;
  expect(next.dispose).toHaveBeenCalled();
  expect(h.webContents.send).not.toHaveBeenCalledWith(desktopChannels.event, { type: 'reattached' });
});

it('closes an owner handed over after disposal', async () => {
  const h = harness();
  await h.bridge.dispose();
  const next = candidate(async () => ({ revision: 3 }));
  await expect(h.bridge.replaceOwner(next.owner)).rejects.toThrow('Desktop connection is unavailable');
  expect(next.dispose).toHaveBeenCalledOnce();
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
    { type: 'reattached' }, { type: 'snapshot', value: { revision: 5 } },
  ]);
  await h.bridge.dispose();
});

it('asks the current owner to read the service again after a switch, even a failed one, and leaves the snapshot to its push', async () => {
  const h = harness();
  await h.invoke(desktopChannels.subscribe);
  const next = { client: { snapshot: async () => ({ revision: 1 }), machine: vi.fn(async () => ({ type: 'done', message: 'ok' })),
    watchSnapshots: () => () => {}, onLog: () => () => {}, onBackendInstall: () => () => {}, onError: () => () => {} },
    identity: { pid: 2, startedAt: 'next', listen: '127.0.0.1:4000' }, dispose: async () => {} } as unknown as AttachedDaemon;
  h.actions.setLoginItem.mockImplementationOnce(async () => { await h.bridge.replaceOwner(next); });
  expect(await h.invoke(desktopChannels.setLoginItem, true)).toEqual({ ok: true, value: undefined });
  expect(next.client.machine).toHaveBeenCalledExactlyOnceWith({ type: 'status' });
  expect(h.machine).not.toHaveBeenCalled();
  h.actions.setLoginItem.mockRejectedValueOnce(new ServiceActionError('timeout'));
  expect(await h.invoke(desktopChannels.setLoginItem, false)).toMatchObject({ ok: false, error: { message: expect.stringContaining('3 分钟') } });
  expect(h.actions.setLoginItem).toHaveBeenLastCalledWith(false, next.identity);
  expect(next.client.machine).toHaveBeenCalledTimes(2);
  h.actions.service.mockRejectedValueOnce(new ServiceActionError('busy'));
  expect(await h.invoke(desktopChannels.service, { type: 'service', action: 'uninstall' })).toMatchObject({ ok: false });
  expect(next.client.machine).toHaveBeenCalledTimes(3);
  expect(h.webContents.send.mock.calls.map(call => call[1].type)).toEqual(['reattached', 'snapshot']);
  await h.bridge.dispose();
});


it('delivers fresh snapshots through the facade across three replacements, including daemon pause', async () => {
  const h = harness();
  const initial = {
    revision: 10, observedAt: 1, stale: false, host: { kind: 'starting' },
    agents: [], groups: [], memberships: [], tools: [], jobs: [],
    application: { platform: 'macos', version: '1', loginItem: false, dataPath: fixtureRoot },
  };
  h.snapshot.mockResolvedValue(initial);
  let receive: (event: unknown) => void = () => {};
  h.webContents.send.mockImplementation((_channel, event) => receive(event));
  const { client } = createDesktopFacades({
    invoke: (channel, ...args) => h.invoke(channel, ...args),
    receive: listener => { receive = listener; return () => {}; },
  });
  const seen: Array<Awaited<ReturnType<VonvonClient['snapshot']>>> = [];
  const off = client.watchSnapshots(value => seen.push(value));
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  for (let crash = 1; crash <= 3; crash++) {
    const snapshot = { ...initial, revision: 1, observedAt: crash + 1,
      application: { ...initial.application, crashes: {
        records: [], ...(crash === 3 ? { paused: { since: 3, crashes: 3 } } : {}),
      } },
    };
    const next = candidate(async () => snapshot);
    await h.bridge.replaceOwner(next.owner);
    expect(seen.at(-1)).toEqual(snapshot);
  }
  expect(seen).toHaveLength(4);
  expect(seen.at(-1)?.application.crashes?.paused).toEqual({ since: 3, crashes: 3 });
  off();
  await h.bridge.dispose();
});


it.each(['rejected', 'resolved'] as const)('rejects an observed candidate connection loss even with a %s first snapshot', async state => {
  const h = harness();
  const next = candidate(async () => {
    if (state === 'rejected') throw new Error('Daemon connection closed');
    return { revision: 1 };
  });
  const loss = new ConnectionError('candidate crashed before binding');
  next.owner.client.onError = listener => { listener(loss); return () => {}; };
  await expect(h.bridge.replaceOwner(next.owner)).rejects.toBe(loss);
  expect(next.dispose).toHaveBeenCalledOnce();
  await h.bridge.dispose();
});
