import { describe, expect, it, vi } from 'vitest';
import { ConnectionError, RpcError } from '@vonvon/client/browser';
import type { DesktopUpdate, DesktopUpdateRequestPayload } from '@vonvon/protocol';
import { REMOTE_UPDATE_TEXT, startRemoteSelfUpdate, type RemoteSelfUpdateDeps, type SelfUpdater } from '../src/remote-self-update.js';
import { DesktopUpdateError } from '../src/updates.js';

// devices-ui-4 第 5 节 remote-self-update: another device updates this computer's Vonvon Bot through the daemon the app
// carries. A fake updater stands for DesktopUpdater (check, then install twice: download, then quitAndInstall) and a
// fake connection for the shell's loopback client. main 必败: there was no remote update; the daemon installed npm.
const update = (state: DesktopUpdate['state'], latest = '0.9.1'): DesktopUpdate => ({ state, current: '0.9.0', latest, message: `${state} ${latest}` });
const ID = 'dur_0123456789abcdef';

function connection(negotiated = true) {
  const listeners = new Set<(payload: DesktopUpdateRequestPayload) => void>();
  const errors = new Set<(error: Error) => void>();
  return {
    listeners, errors,
    admin: vi.fn(async () => (negotiated ? { kind: 'negotiated' as const, principal: 'owner:local' as const, scope: null } : { kind: 'refused' as const, code: 'invalid_request', message: 'x' })),
    machine: vi.fn(async () => ({ type: 'done' as const, message: '已收到。' })),
    onDesktopUpdateRequest: vi.fn((listener: (payload: DesktopUpdateRequestPayload) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    onError: vi.fn((listener: (error: Error) => void) => { errors.add(listener); return () => { errors.delete(listener); }; }),
    ask(action: 'check' | 'apply', by = '「笔记本」', requestId = ID) { for (const listener of [...listeners]) listener({ requestId, action, by }); },
    /** The daemon went away (a crash, a restart by hand): the client says so, as createClient does when its socket closes. */
    drop() { for (const listener of [...errors]) listener(new ConnectionError(new Error('Daemon connection closed'))); },
  };
}
type Connection = ReturnType<typeof connection>;
const reports = (client: Connection) => client.machine.mock.calls.map(call => (call as unknown[])[0] as Record<string, unknown>);
const states = (client: Connection) => reports(client).map(report => report.state);

function harness(updater: Partial<SelfUpdater> & { check: SelfUpdater['check'] }, client: Connection = connection()) {
  let owner: { client: Connection } | null = { client };
  const ownerListeners = new Set<(owner: { client: Connection }) => void>();
  const state = { quitting: false, notices: [] as Array<string | undefined>, published: [] as DesktopUpdate[], logs: [] as Array<[string, unknown]> };
  const fake: SelfUpdater = { install: vi.fn(async () => update('downloaded')), busy: false, ...updater };
  const deps: RemoteSelfUpdateDeps = {
    updater: fake,
    owner: () => owner as never,
    onOwner: listener => { ownerListeners.add(listener as never); return () => { ownerListeners.delete(listener as never); }; },
    quitting: () => state.quitting,
    notice: text => { state.notices.push(text); },
    publish: value => { state.published.push(value); },
    log: (event, fields) => { state.logs.push([event, fields]); },
    reportWaitMs: 50,
  };
  const remote = startRemoteSelfUpdate(deps);
  return {
    remote, state, updater: fake, client,
    replaceOwner(next: Connection | null) { owner = next ? { client: next } : null; if (next) for (const listener of ownerListeners) listener({ client: next }); },
  };
}

describe('declaring the capability', () => {
  it('declares it on this computer\'s daemon connection, once, and again on a new one', async () => {
    const h = harness({ check: async () => update('current') });
    expect(h.client.admin).toHaveBeenCalledExactlyOnceWith({ type: 'negotiate', capabilities: ['desktop.self-update'] });
    // listening before the negotiate, so a request right after it is heard
    expect(h.client.onDesktopUpdateRequest.mock.invocationCallOrder[0]).toBeLessThan(h.client.admin.mock.invocationCallOrder[0]!);
    h.replaceOwner(h.client);
    expect(h.client.admin).toHaveBeenCalledOnce();
    const next = connection();
    h.replaceOwner(next);
    expect(next.admin).toHaveBeenCalledOnce();
    expect(h.client.listeners.size).toBe(0);
    expect(h.client.errors.size).toBe(0);
    expect(next.listeners.size).toBe(1);
    h.remote.dispose();
    expect(next.listeners.size).toBe(0);
    expect(next.errors.size).toBe(0);
  });

  it('stops listening on a connection that refused it', async () => {
    const refusing = connection(false);
    const h = harness({ check: vi.fn(async () => update('current')) }, refusing);
    await vi.waitFor(() => expect(h.state.logs).toContainEqual(['remote-update-negotiate-refused', { code: 'invalid_request' }]));
    expect(refusing.listeners.size).toBe(0);
  });
});

describe('a check from another device', () => {
  it('checks with the app\'s updater, shows the result in the app, and answers with it', async () => {
    const check = vi.fn(async () => update('available'));
    const h = harness({ check });
    h.client.ask('check');
    await vi.waitFor(() => expect(h.client.machine).toHaveBeenCalledOnce());
    expect(reports(h.client)[0]).toEqual({ type: 'desktopUpdateReport', requestId: ID, state: 'available', latest: '0.9.1', message: 'available 0.9.1' });
    expect(h.state.published).toEqual([update('available')]);
    expect(h.state.notices).toEqual([]);
    expect(h.updater.install).not.toHaveBeenCalled();
  });

  it('answers with what it knows while the updater is busy, without checking again', async () => {
    const check = vi.fn(async () => update('available'));
    const h = harness({ check, busy: true });
    h.client.ask('check');
    await vi.waitFor(() => expect(h.client.machine).toHaveBeenCalledOnce());
    expect(reports(h.client)[0]).toMatchObject({ state: 'error', message: REMOTE_UPDATE_TEXT.downloading });
    h.remote.observe(update('downloaded'));
    h.client.ask('check');
    await vi.waitFor(() => expect(h.client.machine).toHaveBeenCalledTimes(2));
    expect(reports(h.client)[1]).toMatchObject({ state: 'downloaded', latest: '0.9.1' });
    expect(check).not.toHaveBeenCalled();
  });

  it('passes the updater\'s own words, and nothing else, back', async () => {
    const check = vi.fn<SelfUpdater['check']>().mockRejectedValueOnce(new DesktopUpdateError('检查更新失败：连不上更新服务器，请检查网络后重试。'))
      .mockRejectedValueOnce(new Error('EACCES /Users/someone/Library'));
    const h = harness({ check });
    h.client.ask('check');
    await vi.waitFor(() => expect(h.client.machine).toHaveBeenCalledOnce());
    h.client.ask('check');
    await vi.waitFor(() => expect(h.client.machine).toHaveBeenCalledTimes(2));
    expect(reports(h.client).map(report => report.message)).toEqual(['检查更新失败：连不上更新服务器，请检查网络后重试。', REMOTE_UPDATE_TEXT.failed]);
  });
});

describe('an update from another device', () => {
  it('checks, downloads, says so on this computer, and then quits and installs', async () => {
    const install = vi.fn<SelfUpdater['install']>().mockResolvedValueOnce(update('downloaded')).mockImplementationOnce(() => new Promise(() => {}));
    const h = harness({ check: async () => update('available'), install });
    h.client.ask('apply');
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(2));
    expect(states(h.client)).toEqual(['downloading', 'downloaded']);
    expect(reports(h.client).every(report => report.requestId === ID && report.latest === '0.9.1')).toBe(true);
    expect(h.state.notices).toEqual([REMOTE_UPDATE_TEXT.notice('「笔记本」')]);
    expect(REMOTE_UPDATE_TEXT.notice('「笔记本」')).toContain('正在进行的对话会被中断');
    expect(h.state.published.map(value => value.state)).toEqual(['available', 'downloaded']);
    expect(h.remote.busy).toBe(true);
    // beforeUpdateInstall's first step, while the connection is still there
    await h.remote.aboutToRestart();
    expect(reports(h.client).at(-1)).toEqual({ type: 'desktopUpdateReport', requestId: ID, state: 'restarting', latest: '0.9.1', message: REMOTE_UPDATE_TEXT.restarting });
    // a second update asked meanwhile is refused, and does not touch the first
    h.client.ask('apply', '这台电脑上的命令行', 'dur_fedcba9876543210');
    await vi.waitFor(() => expect(reports(h.client).at(-1)).toMatchObject({ requestId: 'dur_fedcba9876543210', state: 'error' }));
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('installs a download that is already there without downloading again, once the daemon took `downloaded`', async () => {
    const install = vi.fn<SelfUpdater['install']>(async () => update('downloaded'));
    const h = harness({ check: async () => update('downloaded'), install });
    h.client.ask('apply');
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect(states(h.client)).toEqual(['downloaded']);
    expect(h.client.machine.mock.invocationCallOrder[0]).toBeLessThan(install.mock.invocationCallOrder[0]!);
    expect(h.state.logs.map(([event]) => event)).toContain('remote-update-installing');
  });

  it.each(['current', 'unavailable', 'install-pending'] as const)('stops at a %s check, says it, and takes the notice away', async state => {
    const h = harness({ check: async () => update(state) });
    h.client.ask('apply');
    await vi.waitFor(() => expect(h.state.notices).toHaveLength(2));
    expect(states(h.client)).toEqual([state]);
    expect(h.state.notices).toEqual([REMOTE_UPDATE_TEXT.notice('「笔记本」'), undefined]);
    expect(h.updater.install).not.toHaveBeenCalled();
    expect(h.remote.busy).toBe(false);
  });

  it('reports a failed download and stays here', async () => {
    const install = vi.fn<SelfUpdater['install']>().mockRejectedValueOnce(new DesktopUpdateError('下载更新失败，请稍后重试。'));
    const h = harness({ check: async () => update('available'), install });
    h.client.ask('apply');
    await vi.waitFor(() => expect(h.remote.busy).toBe(false));
    expect(states(h.client)).toEqual(['downloading', 'error']);
    expect(reports(h.client).at(-1)).toMatchObject({ message: '下载更新失败，请稍后重试。' });
    expect(install).toHaveBeenCalledOnce();
  });

  it('does not start while the app quits', async () => {
    const check = vi.fn(async () => update('available'));
    const h = harness({ check });
    h.state.quitting = true;
    h.client.ask('apply');
    await vi.waitFor(() => expect(h.client.machine).toHaveBeenCalledOnce());
    expect(reports(h.client)[0]).toMatchObject({ state: 'error', message: REMOTE_UPDATE_TEXT.quitting });
    expect(check).not.toHaveBeenCalled();
    expect(h.state.notices).toEqual([]);
  });

  it('keeps the download and does not restart when the app started quitting while it downloaded', async () => {
    let downloaded!: (value: DesktopUpdate) => void;
    const install = vi.fn<SelfUpdater['install']>().mockImplementationOnce(() => new Promise(resolve => { downloaded = resolve; }));
    const h = harness({ check: async () => update('available'), install });
    h.client.ask('apply');
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    h.state.quitting = true;
    downloaded(update('downloaded'));
    await vi.waitFor(() => expect(h.remote.busy).toBe(false));
    expect(install).toHaveBeenCalledOnce();
    expect(states(h.client)).toEqual(['downloading', 'downloaded', 'error']);
  });

  // Codex 审查 265-2: the daemon there crashed or was restarted while it downloaded, and the download ended before the
  // app had the next connection; or the next one came first. 修之前必败 (closed): the second install, quitAndInstall.
  it.each([
    ['closed, with no other one yet', (h: ReturnType<typeof harness>) => { h.client.drop(); }],
    ['replaced by another', (h: ReturnType<typeof harness>) => { h.replaceOwner(connection()); }],
  ])('keeps the download and does not restart when the connection that asked is %s', async (_name, meanwhile) => {
    let downloaded!: (value: DesktopUpdate) => void;
    const install = vi.fn<SelfUpdater['install']>().mockImplementationOnce(() => new Promise(resolve => { downloaded = resolve; }));
    const h = harness({ check: async () => update('available'), install });
    h.client.ask('apply');
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    meanwhile(h);
    downloaded(update('downloaded'));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(install).toHaveBeenCalledOnce();
    // nothing more on a connection that is gone; the menu bar and the window stop saying it restarts, at once
    expect(states(h.client)).toEqual(['downloading']);
    expect(h.state.notices).toEqual([REMOTE_UPDATE_TEXT.notice('「笔记本」'), undefined]);
    expect(h.state.logs).toContainEqual(['remote-update-connection-lost', undefined]);
    // this computer's own 重启升级 is free again, and the app's card shows the download for it
    expect(h.remote.busy).toBe(false);
    expect(h.state.published.at(-1)).toEqual(update('downloaded'));
  });

  // Codex 审查 265-2: `downloaded` is the last report before the restart. Not taken (the connection closed, or the update
  // there ended meanwhile): no restart. 修之前必败: the failure was swallowed and the app went on to quitAndInstall.
  it('keeps the download and does not restart when the daemon does not take `downloaded`', async () => {
    let downloaded!: (value: DesktopUpdate) => void;
    const install = vi.fn<SelfUpdater['install']>().mockImplementationOnce(() => new Promise(resolve => { downloaded = resolve; }));
    const h = harness({ check: async () => update('available'), install });
    h.client.ask('apply');
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    h.client.machine.mockRejectedValue(new RpcError('invalid_request', '这次更新已经结束或不是发给你的。'));
    downloaded(update('downloaded'));
    await vi.waitFor(() => expect(h.remote.busy).toBe(false));
    expect(install).toHaveBeenCalledOnce();
    expect(states(h.client)).toEqual(['downloading', 'downloaded']);
    expect(h.state.notices).toEqual([REMOTE_UPDATE_TEXT.notice('「笔记本」'), undefined]);
    expect(h.state.logs).toContainEqual(['remote-update-report-failed', { state: 'downloaded', code: 'invalid_request' }]);
  });

  it('waits a short while at most for the daemon to take the restart report', async () => {
    const install = vi.fn<SelfUpdater['install']>().mockResolvedValueOnce(update('downloaded')).mockImplementationOnce(() => new Promise(() => {}));
    const h = harness({ check: async () => update('available'), install });
    h.client.ask('apply');
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(2));
    h.client.machine.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    await h.remote.aboutToRestart();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(states(h.client).at(-1)).toBe('restarting');
  });

  // Codex 审查 265-2: refused or closed, `restarting` stops the install before quitAndInstall (beforeUpdateInstall's first
  // step throws); only a daemon slow to answer is not waited for. 修之前必败: it went on.
  it('stops the restart when the daemon does not take `restarting`', async () => {
    const install = vi.fn<SelfUpdater['install']>().mockResolvedValueOnce(update('downloaded')).mockImplementationOnce(() => new Promise(() => {}));
    const h = harness({ check: async () => update('available'), install });
    h.client.ask('apply');
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(2));
    h.client.machine.mockRejectedValue(new Error('Daemon connection closed'));
    await expect(h.remote.aboutToRestart()).rejects.toThrow(REMOTE_UPDATE_TEXT.notRestarting);
    expect(states(h.client).at(-1)).toBe('restarting');
  });

  it('does nothing at a restart this computer asked for', async () => {
    const h = harness({ check: async () => update('available') });
    await h.remote.aboutToRestart();
    expect(h.client.machine).not.toHaveBeenCalled();
  });

  it('ignores requests after it is disposed', async () => {
    const check = vi.fn(async () => update('available'));
    const h = harness({ check });
    const heard = [...h.client.listeners];
    h.remote.dispose();
    for (const listener of heard) listener({ requestId: ID, action: 'apply', by: 'x' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(check).not.toHaveBeenCalled();
    expect(h.client.machine).not.toHaveBeenCalled();
  });
});
