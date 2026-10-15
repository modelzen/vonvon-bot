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
    h.event({ type: 'reattached' });
    h.event({ type: 'snapshot', value: snapshot(1) });
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

  it('registers its receiver before subscribing and delivers the newest snapshot once', async () => {
    const h = harness();
    let resolveSeed!: (value: unknown) => void;
    h.replies.set(desktopChannels.snapshot, () => new Promise(resolve => { resolveSeed = resolve; }));
    const { client } = createDesktopFacades(h.transport);
    expect(typeof client.snapshot).toBe('function');
    expect(h.calls[0]).toBe(desktopChannels.subscribe);
    const seen: number[] = [];
    const unsubscribe = client.watchSnapshots(value => seen.push(value.revision));
    h.event({ type: 'snapshot', value: snapshot(3) });
    resolveSeed({ ok: true, value: snapshot(2) });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([3]);
    unsubscribe();
    h.event({ type: 'snapshot', value: snapshot(4) });
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
    h.event({ type: 'error', value: { kind: 'rpc', code: 'conflict', message: '机器人未启用或尚未运行' } });
    expect(seen[0]).toMatchObject({ message: '机器人未启用或尚未运行', code: 'conflict' });
  });

  it('retains errors and quit requests until listeners attach', () => {
    const h = harness();
    const { client, shell } = createDesktopFacades(h.transport);
    h.event({ type: 'error', value: { kind: 'connection', message: 'Daemon connection lost' } });
    h.event({ type: 'quitRequested' });
    const errors: string[] = [];
    client.onError(error => errors.push(error.message));
    let quits = 0;
    const off = shell.onQuitRequested(() => { quits++; });
    expect(errors).toEqual(['Daemon connection lost']);
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
    h.event({ type: 'snapshot', value: snapshot(4) });
    h.event({ type: 'error', value: { kind: 'connection', message: 'Late failure' } });
    h.event({ type: 'log', value: { lines: 'late log' } });
    h.event({ type: 'backendInstall', value: {
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
  h.event({ type: 'snapshot', value });
  h.event({ type: 'snapshot', value: { ...value, application: { ...value.application, loginItem: true } } });
  seed({ ok: true, value });
  await Promise.resolve(); await Promise.resolve();
  h.event({ type: 'snapshot', value: snapshot(2) });
  const next = snapshot(4);
  h.event({ type: 'snapshot', value: { ...next, application: { ...next.application, loginItem: true } } });
  expect(seen).toEqual([[3, false], [4, true]]);
});
