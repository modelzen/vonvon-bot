import {agentIdSchema, groupIdSchema} from '@vonvon/protocol';
import { describe, expect, it } from 'vitest';
import { desktopChannels } from '../src/ipc-contract.js';
import { createDesktopFacades, type FacadeTransport } from '../src/facade.js';

const snapshot = (revision: number) => ({
  revision, observedAt: 1, stale: false, host: { kind: 'starting' },
  agents: [], groups: [], memberships: [], tools: [], jobs: [],
  application: { platform: 'macos', version: '1', loginItem: false, dataPath: '/tmp' },
});

function harness() {
  let receive: (event: unknown) => void = () => {};
  const calls: string[] = [];
  const replies = new Map<string, () => Promise<unknown>>();
  const transport: FacadeTransport = {
    invoke(channel) {
      calls.push(channel);
      return replies.get(channel)?.() ?? Promise.resolve({ ok: true, value: undefined });
    },
    receive(listener) { receive = listener; return () => { receive = () => {}; }; },
  };
  return { transport, calls, replies, event: (value: unknown) => receive(value) };
}

describe('synchronous desktop facade', () => {
  it('validates pending preview locators and never dispatches publication on open', async () => {
    const h = harness();
    const navigation = {draftId: '8d85af21-e80d-4665-a6b8-ccf162dc1923', revision: 2, navigationId: '11111111-1111-4111-8111-111111111111'};
    h.replies.set(desktopChannels.recipePreviewPending, async () => ({ok: true, value: [navigation]}));
    const shell = createDesktopFacades(h.transport).shell;
    const received: unknown[] = [];
    const off = shell.recipePreview.onOpen(value => received.push(value));
    expect(await shell.recipePreview.pending()).toEqual([navigation]);
    h.event({type: 'recipePreview', value: {...navigation, publish: true}});
    h.event({type: 'recipePreview', value: navigation});
    expect(received).toEqual([navigation]);
    off();
    h.event({type: 'recipePreview', value: navigation});
    expect(received).toHaveLength(1);
    await shell.recipePreview.acknowledge(navigation.navigationId);
    expect(h.calls.filter(channel => channel !== desktopChannels.subscribe)).toEqual([
      desktopChannels.recipePreviewPending, desktopChannels.recipePreviewAcknowledge,
    ]);
    h.replies.set(desktopChannels.recipePreviewPending, async () => ({ok: true, value: [{...navigation, token: 'secret'}]}));
    await expect(shell.recipePreview.pending()).rejects.toThrow();
  });
  it('exposes only validated account status and replays it to a remounted shell listener', async () => {
    const h = harness();
    const { account } = createDesktopFacades(h.transport).shell;
    expect(Object.keys(account).sort()).toEqual(['cancelLogin', 'login', 'logout', 'manage', 'onStatus', 'refresh', 'status']);
    const statuses: unknown[] = [];
    h.event({ type: 'account', value: { kind: 'signedOut' } });
    const stop = account.onStatus(status => statuses.push(status));
    h.event({ type: 'account', value: { kind: 'signingIn', access_token: 'sensitive' } });
    h.event({ type: 'account', value: { kind: 'signingIn' } });
    stop();
    h.event({ type: 'account', value: { kind: 'signedOut' } });
    expect(statuses).toEqual([{ kind: 'signedOut' }, { kind: 'signingIn' }]);
    h.replies.set(desktopChannels.accountStatus, async () => ({ ok: true, value: { kind: 'signedOut', refresh_token: 'secret' } }));
    await expect(account.status()).rejects.toThrow();
    h.replies.set(desktopChannels.accountRefresh, async () => ({ok: true, value: {kind: 'signedOut'}}));
    await expect(account.refresh?.()).resolves.toEqual({kind: 'signedOut'});
    await expect(account.manage?.()).resolves.toBeUndefined();
    expect(h.calls).toContain(desktopChannels.accountManage);
  });

  it('forwards service and login actions through dedicated shell IPC', async () => {
    const h = harness();
    const requests: Array<{ channel: string; args: unknown[] }> = [];
    const invoke = h.transport.invoke;
    h.transport.invoke = (channel, ...args) => {
      if (channel === desktopChannels.service || channel === desktopChannels.setLoginItem) requests.push({ channel, args });
      return invoke(channel, ...args);
    };
    const { shell } = createDesktopFacades(h.transport);
    h.replies.set(desktopChannels.service, async () => ({ ok: true, value: { type: 'done', message: 'installed' } }));
    await expect(shell.service('install')).resolves.toEqual({ type: 'done', message: 'installed' });
    await expect(shell.setLoginItem(true)).resolves.toBeUndefined();
    expect(requests).toEqual([
      { channel: desktopChannels.service, args: [{ type: 'service', action: 'install' }] },
      { channel: desktopChannels.setLoginItem, args: [true] },
    ]);
    h.replies.set(desktopChannels.service, async () => ({ ok: true, value: { type: 'invalid' } }));
    await expect(shell.service('stop')).rejects.toThrow();
    h.replies.set(desktopChannels.setLoginItem, async () => ({ ok: true, value: 'invalid' }));
    await expect(shell.setLoginItem(false)).rejects.toThrow('Invalid desktop response');
  });
  it('sends a schedule call with its bot and validates the reply', async () => {
    const h = harness();
    const args: unknown[][] = [];
    const invoke = h.transport.invoke;
    h.transport.invoke = (channel, ...values) => {
      if (channel === desktopChannels.schedule) args.push(values);
      return invoke(channel, ...values);
    };
    const { client } = createDesktopFacades(h.transport);
    const request = { action: 'runNow', chatId: 'oc_schedule', taskId: 'st_1' } as const;
    h.replies.set(desktopChannels.schedule, async () => ({ ok: true, value: { kind: 'started', taskId: 'st_1', runId: 'run_1' } }));
    await expect(client.schedule('cli_schedule', request)).resolves.toEqual({ kind: 'started', taskId: 'st_1', runId: 'run_1' });
    expect(args).toEqual([['cli_schedule', request, 'current']]);
    h.replies.set(desktopChannels.schedule, async () => ({ ok: true, value: { kind: 'unexpected' } }));
    await expect(client.schedule('cli_schedule', request)).rejects.toThrow();
  });
  it('exposes the zero-argument CLI repair call and validates its reply', async () => {
    const h = harness();
    const args: unknown[][] = [];
    const invoke = h.transport.invoke;
    h.transport.invoke = (channel, ...values) => {
      if (channel === desktopChannels.repairCli) args.push(values);
      return invoke(channel, ...values);
    };
    const { shell } = createDesktopFacades(h.transport);
    h.replies.set(desktopChannels.repairCli, async () => ({ ok: true, value: { type: 'done', message: 'installed' } }));
    await expect(shell.repairCli()).resolves.toEqual({ type: 'done', message: 'installed' });
    expect(args).toEqual([[]]);
    h.replies.set(desktopChannels.repairCli, async () => ({ ok: true, value: { type: 'unexpected' } }));
    await expect(shell.repairCli()).rejects.toThrow();
  });
  it('validates native updater results at the preload boundary', async () => {
    const h = harness();
    const { shell } = createDesktopFacades(h.transport);
    const update = { state: 'available', current: '1.0.0', latest: '1.1.0', message: 'ready' };
    h.replies.set(desktopChannels.checkDesktopUpdate, async () => ({ ok: true, value: update }));
    await expect(shell.checkDesktopUpdate()).resolves.toEqual(update);
    h.replies.set(desktopChannels.installDesktopUpdate, async () => ({ ok: true, value: { ...update, state: 'invalid' } }));
    await expect(shell.installDesktopUpdate()).rejects.toThrow();
    expect(h.calls.slice(-2)).toEqual([desktopChannels.checkDesktopUpdate, desktopChannels.installDesktopUpdate]);
  });
  it('retries a stalled update through its own channel and validates the reply', async () => {
    const h = harness();
    const { shell } = createDesktopFacades(h.transport);
    const update = { state: 'install-pending', current: '1.0.0', latest: '1.1.0', message: 'x' };
    h.replies.set(desktopChannels.retryDesktopUpdate, async () => ({ ok: true, value: update }));
    await expect(shell.retryDesktopUpdate()).resolves.toEqual(update);
    h.replies.set(desktopChannels.retryDesktopUpdate, async () => ({ ok: true, value: { ...update, state: 'invalid' } }));
    await expect(shell.retryDesktopUpdate()).rejects.toThrow();
  });
  it('delivers automatic update results, replays the latest to a late listener, and drops malformed ones', async () => {
    const h = harness();
    const { shell, client } = createDesktopFacades(h.transport);
    const early: unknown[] = [];
    const off = shell.onDesktopUpdate(update => early.push(update));
    const found = { state: 'available', current: '1.0.0', latest: '1.1.0', message: 'x' };
    h.event({ type: 'update', value: found });
    expect(early).toEqual([found]);
    const late: unknown[] = [];
    shell.onDesktopUpdate(update => late.push(update));
    expect(late).toEqual([found]);
    off();
    const errors: string[] = [];
    client.onError(error => errors.push(error.message));
    h.event({ type: 'update', value: { ...found, state: 'bogus' } });
    expect(errors).toEqual(['Invalid desktop event']);
    expect(early).toEqual([found]);
    expect(late).toEqual([found]);
  });
  // devices-ui-4: the line the window shows while another device updates this computer.
  it('delivers the remote update line, replays the latest to a late listener, and drops a malformed one', async () => {
    const h = harness();
    const { shell, client } = createDesktopFacades(h.transport);
    const early: unknown[] = [];
    shell.onRemoteUpdate?.(text => early.push(text));
    expect(early).toEqual([]);
    h.event({ type: 'remoteUpdate', text: '「笔记本」正在更新' });
    expect(early).toEqual(['「笔记本」正在更新']);
    const late: unknown[] = [];
    shell.onRemoteUpdate?.(text => late.push(text));
    expect(late).toEqual(['「笔记本」正在更新']);
    h.event({ type: 'remoteUpdate' });
    expect(early).toEqual(['「笔记本」正在更新', undefined]);
    const errors: string[] = [];
    client.onError(error => errors.push(error.message));
    h.event({ type: 'remoteUpdate', text: 'x'.repeat(513) });
    h.event({ type: 'remoteUpdate', text: 3 });
    expect(errors).toEqual(['Invalid desktop event', 'Invalid desktop event']);
    expect(late).toEqual(['「笔记本」正在更新', undefined]);
  });
  it('forwards the optional selected Bot unchanged and validates the machine reply', async () => {
    const h = harness();
    const requests: unknown[][] = [];
    const invoke = h.transport.invoke;
    h.transport.invoke = (channel, ...args) => {
      if (channel === desktopChannels.startHost) requests.push(args);
      return invoke(channel, ...args);
    };
    const { shell } = createDesktopFacades(h.transport);
    h.replies.set(desktopChannels.startHost, async () => ({ ok: true, value: { type: 'done', message: 'started' } }));
    await expect(shell.startHost()).resolves.toEqual({ type: 'done', message: 'started' });
    await expect(shell.startHost('cli_exact_Bot_ID')).resolves.toEqual({ type: 'done', message: 'started' });
    expect(requests).toEqual([[{ type: 'startHost' }], [{ type: 'startHost', bot: 'cli_exact_Bot_ID' }]]);
    h.replies.set(desktopChannels.startHost, async () => ({ ok: true, value: { type: 'unexpected' } }));
    await expect(shell.startHost()).rejects.toThrow();
  });

  it('delivers a lower revision after authenticated reattachment', async () => {
    const h = harness();
    h.replies.set(desktopChannels.snapshot, async () => ({ ok: true, value: snapshot(10) }));
    const { client } = createDesktopFacades(h.transport);
    const seen: number[] = [];
    client.watchSnapshots(value => seen.push(value.revision));
    await Promise.resolve();
    await Promise.resolve();
    h.event({ type: 'reattached', view: 'local' });
    h.event({ type: 'snapshot', view: 'local', value: snapshot(1) });
    expect(seen).toEqual([10, 1]);
  });
  it('exposes the executable chooser and validates its path-or-cancel response', async () => {
    const h = harness();
    const { shell } = createDesktopFacades(h.transport);
    h.replies.set(desktopChannels.chooseExecutablePath, async () => ({ ok: true, value: '/usr/local/bin/codex' }));
    await expect(shell.chooseExecutablePath()).resolves.toBe('/usr/local/bin/codex');
    h.replies.set(desktopChannels.chooseExecutablePath, async () => ({ ok: true, value: null }));
    await expect(shell.chooseExecutablePath()).resolves.toBeNull();
    h.replies.set(desktopChannels.chooseExecutablePath, async () => ({ ok: true, value: 123 }));
    await expect(shell.chooseExecutablePath()).rejects.toThrow('Invalid desktop response');
    expect(h.calls.filter(value => value === desktopChannels.chooseExecutablePath)).toHaveLength(3);
  });

  it('validates every directory returned by the native chooser and preserves cancellation', async () => {
    const h = harness();
    const {shell}=createDesktopFacades(h.transport);
    h.replies.set(desktopChannels.chooseDirectoryPaths, async()=>({ok:true,value:['/tmp/a','/tmp/b']}));
    await expect(shell.chooseDirectoryPaths(true)).resolves.toEqual(['/tmp/a','/tmp/b']);
    h.replies.set(desktopChannels.chooseDirectoryPaths, async()=>({ok:true,value:null}));
    await expect(shell.chooseDirectoryPaths(false)).resolves.toBeNull();
    for (const value of [123, ['/tmp/a',false],[''],['bad\0path'],Array(65).fill('/tmp/a')]) {
      h.replies.set(desktopChannels.chooseDirectoryPaths, async()=>({ok:true,value}));
      await expect(shell.chooseDirectoryPaths(true)).rejects.toThrow('Invalid desktop response');
    }
  });

  it('registers its receiver before subscribing and delivers the newest snapshot once', async () => {
    const h = harness();
    let resolveSeed!: (value: unknown) => void;
    h.replies.set(desktopChannels.snapshot, () => new Promise(resolve => { resolveSeed = resolve; }));
    const { client } = createDesktopFacades(h.transport);
    expect(typeof client.snapshot).toBe('function');
    expect(h.calls[0]).toBe(desktopChannels.subscribe);
    const seen: number[] = [];
    const unsubscribe = client.watchSnapshots(value => seen.push(value.revision));
    h.event({ type: 'snapshot', view: 'local', value: snapshot(3) });
    resolveSeed({ ok: true, value: snapshot(2) });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([3]);
    unsubscribe();
    h.event({ type: 'snapshot', view: 'local', value: snapshot(4) });
    expect(seen).toEqual([3]);
  });

  it('keeps the daemon message and a plain error code on rejected requests and error events', async () => {
    const h = harness();
    const { client } = createDesktopFacades(h.transport);
    h.replies.set(desktopChannels.run, async () => ({ ok: false, error: { kind: 'rpc', code: 'upstream', message: '缺少飞书权限 im:chat:readonly（读取群信息）。' } }));
    await expect(client.run({ type: 'refresh' })).rejects.toMatchObject({ message: '缺少飞书权限 im:chat:readonly（读取群信息）。', code: 'upstream' });
    h.replies.set(desktopChannels.run, async () => ({ ok: false, error: { kind: 'rpc', code: 'not a code!', message: 'refused' } }));
    const rejected = await client.run({ type: 'refresh' }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).not.toHaveProperty('code');
    const seen: Error[] = [];
    client.onError(error => seen.push(error));
    h.event({ type: 'error', value: { kind: 'rpc', code: 'conflict', message: 'Bot 没启用或没在运行' } });
    expect(seen[0]).toMatchObject({ message: 'Bot 没启用或没在运行', code: 'conflict' });
  });

  it('retains errors and quit requests until listeners attach', () => {
    const h = harness();
    const { client, shell } = createDesktopFacades(h.transport);
    h.event({ type: 'error', value: { kind: 'connection', message: '和后台的连接断开了。' } });
    h.event({ type: 'quitRequested' });
    const errors: string[] = [];
    client.onError(error => errors.push(error.message));
    let quits = 0;
    const off = shell.onQuitRequested(() => { quits++; });
    expect(errors).toEqual(['和后台的连接断开了。']);
    expect(quits).toBe(1);
    off();
    h.event({ type: 'quitRequested' });
    shell.onQuitRequested(() => { quits++; });
    expect(quits).toBe(2);
  });

  it('rejects pending work on close and reuses the physical close promise', async () => {
    const h = harness();
    h.replies.set(desktopChannels.snapshot, () => new Promise(() => {}));
    let resolveClose!: (value: unknown) => void;
    h.replies.set(desktopChannels.close, () => new Promise(resolve => { resolveClose = resolve; }));
    const { client } = createDesktopFacades(h.transport);
    const pending = client.snapshot();
    const rejected = expect(pending).rejects.toThrow('Daemon connection closed');
    const first = client.close();
    expect(client.close()).toBe(first);
    await rejected;
    await expect(client.snapshot()).rejects.toThrow('Daemon connection closed');
    resolveClose({ ok: true, value: undefined });
    await first;
    expect(h.calls.filter(value => value === desktopChannels.close)).toHaveLength(1);
    expect(h.calls.filter(value => value === desktopChannels.snapshot)).toHaveLength(1);
  });

  it.each([false, true])('keeps native quit cancellation, re-request, and Shell actions usable after close, failure=%s', async failure => {
    const h = harness();
    if (failure) {
      for (const channel of [desktopChannels.close, desktopChannels.quit]) {
        h.replies.set(channel, async () => ({
          ok: false, error: { kind: 'connection', message: 'Physical close failed' },
        }));
      }
    }
    const { client, shell } = createDesktopFacades(h.transport);
    let requested = 0;
    const off = shell.onQuitRequested(() => { requested++; });
    const closed = client.close();
    if (failure) await expect(closed).rejects.toThrow('Physical close failed');
    else await closed;
    expect(client.close()).toBe(closed);
    h.event({ type: 'quitRequested' });
    expect(requested).toBe(1);
    expect(h.calls).not.toContain(desktopChannels.quit);
    h.event({ type: 'quitRequested' });
    expect(requested).toBe(2);
    off();
    h.event({ type: 'quitRequested' });
    expect(requested).toBe(2);
    shell.onQuitRequested(() => { requested++; });
    expect(requested).toBe(3);
    await shell.hideWindow();
    await shell.openExternal('https://open.feishu.cn');
    if (failure) await expect(shell.quit()).rejects.toThrow('Physical close failed');
    else await shell.quit();
    expect(h.calls.slice(-3)).toEqual([desktopChannels.hide, desktopChannels.external, desktopChannels.quit]);
    expect(h.calls.filter(value => value === desktopChannels.close)).toHaveLength(1);
  });

  it('does not cancel an in-flight native action when the client closes', async () => {
    const h = harness();
    let finishHide!: (value: unknown) => void;
    h.replies.set(desktopChannels.hide, () => new Promise(resolve => { finishHide = resolve; }));
    const { client, shell } = createDesktopFacades(h.transport);
    const hiding = shell.hideWindow();
    const hidden = expect(hiding).resolves.toBeUndefined();
    await client.close();
    finishHide({ ok: true, value: undefined });
    await hidden;
  });

  it('does not replay retained errors or deliver events to client listeners after close', async () => {
    const h = harness();
    const { client } = createDesktopFacades(h.transport);
    h.event({ type: 'error', value: { kind: 'connection', message: 'Connection lost' } });
    const seen: string[] = [];
    client.onLog(() => seen.push('existing log'));
    client.onBackendInstall(() => seen.push('existing install'));
    await client.close();
    client.onError(error => seen.push(error.message));
    client.watchSnapshots(() => seen.push('snapshot'));
    client.onLog(() => seen.push('log'));
    client.onBackendInstall(() => seen.push('install'));
    h.event({ type: 'snapshot', view: 'local', value: snapshot(4) });
    h.event({ type: 'error', value: { kind: 'connection', message: 'Late failure' } });
    h.event({ type: 'log', view: 'local', value: { lines: 'late log' } });
    h.event({ type: 'backendInstall', view: 'local', value: {
      operationId: 'b6389cdd-fc7e-4e55-9e4f-7ebaf3ad2240', id: 'codex', update: false,
      item: { type: 'log', chunk: 'late install' },
    } });
    await Promise.resolve();
    expect(seen).toEqual([]);
    expect(h.calls).toEqual([desktopChannels.subscribe, desktopChannels.close]);
  });

  it('does not deliver a queued snapshot seed after close', async () => {
    const h = harness();
    h.replies.set(desktopChannels.snapshot, async () => ({ ok: true, value: snapshot(1) }));
    const { client } = createDesktopFacades(h.transport);
    const seen: number[] = [];
    client.watchSnapshots(value => seen.push(value.revision));
    await Promise.resolve();
    await client.close();
    expect(seen).toEqual([]);
  });

  it('stops retained error replay when a listener closes the client', async () => {
    const h = harness();
    const { client } = createDesktopFacades(h.transport);
    for (const message of ['first', 'second']) {
      h.event({ type: 'error', value: { kind: 'connection', message } });
    }
    const seen: string[] = [];
    client.onError(error => {
      seen.push(error.message);
      void client.close();
    });
    await client.close();
    expect(seen).toEqual(['first']);
  });
});

it('delivers each daemon revision once: the login item changes only with the daemon\'s snapshot', async () => {
  const h = harness();
  let seed!: (value: unknown) => void;
  h.replies.set(desktopChannels.snapshot, () => new Promise(resolve => { seed = resolve; }));
  const { client } = createDesktopFacades(h.transport);
  const seen: Array<[number, boolean]> = [];
  client.watchSnapshots(value => seen.push([value.revision, value.application.loginItem]));
  const value = snapshot(3);
  h.event({ type: 'snapshot', view: 'local', value });
  h.event({ type: 'snapshot', view: 'local', value: { ...value, application: { ...value.application, loginItem: true } } });
  seed({ ok: true, value });
  await Promise.resolve(); await Promise.resolve();
  h.event({ type: 'snapshot', view: 'local', value: snapshot(2) });
  const next = snapshot(4);
  h.event({ type: 'snapshot', view: 'local', value: { ...next, application: { ...next.application, loginItem: true } } });
  expect(seen).toEqual([[3, false], [4, true]]);
});

// devices-ui-1a 第 5 节 facade: a page per device. main 必败: there was one client for one daemon.
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const devicesState = {
  v: 1, revision: 2, client: { version: '1', protocolVersion: 2 }, registry: 'ok', secureStorage: true,
  devices: [{ id: 'local', name: '这台电脑', current: true, status: 'online', routes: [] }],
  active: { id: 'local', phase: 'ready', attempt: 0 },
};

describe('devices-ui-1a facade', () => {
  it('gives a page of one device only that device\'s events, and names the device on every request', async () => {
    const h = harness();
    const args: unknown[][] = [];
    const invoke = h.transport.invoke;
    h.transport.invoke = (channel, ...values) => {
      if (channel === desktopChannels.settings || channel === desktopChannels.snapshot || channel === desktopChannels.close) args.push([channel, ...values]);
      return invoke(channel, ...values);
    };
    h.replies.set(desktopChannels.snapshot, () => new Promise(() => {}));
    const { shell } = createDesktopFacades(h.transport);
    const a = shell.devices.clientFor(A);
    expect(shell.devices.clientFor(A)).toBe(a);
    expect(() => shell.devices.clientFor('not-a-device')).toThrow();
    const seen: Array<number | 'new connection'> = [];
    const unsubscribe = a.watchSnapshots(value => seen.push(value.revision), () => seen.push('new connection'));
    h.event({ type: 'snapshot', view: A, value: snapshot(5) });
    h.event({ type: 'snapshot', view: B, value: snapshot(9) });
    h.event({ type: 'snapshot', view: 'local', value: snapshot(9) });
    // Another device's reattachment does not start A's revisions over; A's own does.
    h.event({ type: 'reattached', view: B });
    h.event({ type: 'snapshot', view: A, value: snapshot(4) });
    h.event({ type: 'reattached', view: A });
    h.event({ type: 'snapshot', view: A, value: snapshot(1) });
    expect(seen).toEqual([5, 'new connection', 1]);
    unsubscribe();
    h.event({ type: 'reattached', view: A });
    expect(seen).toEqual([5, 'new connection', 1]);
    const read = { type: 'read', scope: { kind: 'host' } } as const;
    await a.settings(read).catch(() => {});
    await a.close();
    expect(args).toEqual([[desktopChannels.snapshot, A], [desktopChannels.settings, read, A], [desktopChannels.close, A]]);
    expect(shell.devices.clientFor(A)).not.toBe(a);
  });

  it('replays the latest device list to a late listener, refuses a malformed one, and passes this computer\'s device events', () => {
    const h = harness();
    const { client, shell } = createDesktopFacades(h.transport);
    h.event({ type: 'devices', value: devicesState });
    const seen: unknown[] = [];
    shell.devices.onState(value => seen.push(value));
    expect(seen).toEqual([devicesState]);
    const errors: string[] = [];
    client.onError(error => errors.push(error.message));
    h.event({ type: 'devices', value: { ...devicesState, devices: [] } });
    expect(errors).toEqual(['Invalid desktop event']);
    expect(seen).toHaveLength(1);
    const local: unknown[] = [];
    shell.onLocalDeviceEvent(value => local.push(value));
    const paired = { change: 'client-paired', clientId: 'cl_0123456789abcdef', name: '笔记本', clientKind: 'desktop' };
    h.event({ type: 'localDevice', value: paired });
    expect(local).toEqual([paired]);
    h.event({ type: 'snapshot', value: snapshot(1) });
    expect(errors).toEqual(['Invalid desktop event', 'Invalid desktop event']);
  });

  it('sends the device page\'s requests over the shell\'s own channels and checks the replies', async () => {
    const h = harness();
    const { shell } = createDesktopFacades(h.transport);
    h.replies.set(desktopChannels.devicesState, async () => ({ ok: true, value: devicesState }));
    await expect(shell.devices.state()).resolves.toEqual(devicesState);
    h.replies.set(desktopChannels.devicesRemove, async () => ({ ok: true, value: { revokedRemotely: 'yes' } }));
    await expect(shell.devices.remove(A)).rejects.toThrow();
    h.replies.set(desktopChannels.devicesSwitch, async () => ({ ok: false, error: { kind: 'validation', code: 'unknown_device', message: '设备列表里没有这台设备。' } }));
    await expect(shell.devices.switchTo(B)).rejects.toMatchObject({ message: '设备列表里没有这台设备。', code: 'unknown_device' });
    expect(h.calls.slice(-3)).toEqual([desktopChannels.devicesState, desktopChannels.devicesRemove, desktopChannels.devicesSwitch]);
  });
});


it('validates minimal exact group identity replies through the captured device client facade', async () => {
  const request = {type: 'readGroupIdentity' as const, agentId: agentIdSchema.parse('cli_exact'), groupId: groupIdSchema.parse('oc_exact')};
  const calls: unknown[][] = [];
  let value: unknown = {kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: '平台群'};
  const facade = createDesktopFacades({receive: () => () => {}, invoke: async (channel, ...args) => {
    if (channel === desktopChannels.subscribe) return {ok: true, value: undefined};
    calls.push([channel, ...args]); return {ok: true, value};
  }});
  const client = facade.shell.devices.clientFor('11111111-1111-4111-8111-111111111111');
  expect(await client.run(request)).toEqual(value);
  expect(calls).toEqual([[desktopChannels.run, request, '11111111-1111-4111-8111-111111111111']]);
  for (const invalid of [{kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: ' '},
    {kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: '平台群', description: 'not allowed'}]) {
    value = invalid; await expect(client.run(request)).rejects.toThrow();
  }
});
