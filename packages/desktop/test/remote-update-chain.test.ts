import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VonvonClient } from '@vonvon/client';
import type { DesktopUpdateReport, MachineReply, MachineRequest } from '@vonvon/protocol';

vi.mock('../../daemon/src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { paths: { appDir: mkdtempSync(join(tmpdir(), 'vonvon-remote-update-chain-')) } };
});

// The client's build, as the app loads it: its ConnectionError is the one remote-self-update knows.
import { createClient } from '../../client/dist/client.js';
import { paths } from '../../daemon/src/config/paths';
import { createBundledUpdate, type DesktopShellPeer } from '../../daemon/src/service/bundled-update';
import { settleUpdateAtStartup } from '../../daemon/src/service/standalone-update';
import { clearUpdateStatus, readUpdateStatus } from '../../daemon/src/service/update';
import { runUpdateCommand, UPDATE_INTERRUPTS, type UpdateCommandDeps } from '../../daemon/src/cli/commands/update';
import { withDaemon } from '../../daemon/src/cli/daemon-client';
import { REMOTE_UPDATE_TEXT, startRemoteSelfUpdate, type RemoteSelfUpdate } from '../src/remote-self-update.js';
import { DesktopUpdater } from '../src/updates.js';

// devices-ui-4, Codex 审查 264-1、265: the remote update across its pieces, each the real one. The app's updater
// (DesktopUpdater with a fake Electron driver and manifest), its remote update on a real client over a fake loopback
// socket, the server's bundled update and update record in a temp data directory, and `vonvon update`. Only the
// RPC dispatch is this file's: machine.ts hands checkCoreUpdate, applyCoreUpdate and desktopUpdateReport to the same calls.
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));
beforeEach(() => { clearUpdateStatus(); });
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const silent = { info: () => {}, warn: () => {} };
class Driver extends EventEmitter {
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn();
  quitAndInstall = vi.fn();
}

function rig() {
  let open = true;
  let deliver!: (data: string) => void;
  const closed: Array<() => void> = [];
  // That computer's server, and its end of the app's loopback connection.
  const shell: DesktopShellPeer = { id: 'shell', get open() { return open; }, event: event => { queueMicrotask(() => { if (open) deliver(JSON.stringify(event)); }); } };
  const server = createBundledUpdate({ shells: () => [shell], version: '0.9.0', deviceName: () => 'Mac mini', platform: 'darwin', log: silent });
  const answer = (request: { id: string; method: string; payload: unknown }): object => {
    if (request.method === 'admin') return { type: 'response', id: request.id, method: 'admin', payload: { kind: 'negotiated', principal: 'owner:local', scope: null } };
    try {
      server.report(shell, request.payload as DesktopUpdateReport);
      return { type: 'response', id: request.id, method: 'machine', payload: { type: 'done', message: '已收到。' } };
    } catch (error) { return { type: 'error', id: request.id, code: (error as { code: string }).code, message: (error as Error).message }; }
  };
  const client = createClient({
    isOpen: () => open,
    onMessage: listener => { deliver = listener; },
    onClose: listener => { closed.push(listener); },
    onError: () => {},
    send(data, callback) {
      callback();
      const reply = answer(JSON.parse(data));
      queueMicrotask(() => { if (open) deliver(JSON.stringify(reply)); });
    },
    close: async () => { open = false; },
  });
  const driver = new Driver();
  let remote!: RemoteSelfUpdate;
  const updater = new DesktopUpdater({
    current: '0.9.0', signed: true, manifestURL: 'https://updates.example.test/manifest.json', driver,
    fetch: async () => new Response(JSON.stringify({ version: '0.9.1', feedURL: 'https://updates.example.test/feed.json' })),
    // main.ts's beforeUpdateInstall starts so
    beforeInstall: () => remote.aboutToRestart(),
  });
  const notices: Array<string | undefined> = [];
  remote = startRemoteSelfUpdate({
    updater, owner: () => ({ client }), onOwner: () => () => {}, quitting: () => false,
    notice: text => { notices.push(text); }, publish: () => {}, log: () => {}, reportWaitMs: 200,
  });
  cleanups.push(() => { remote.dispose(); server.close(); return client.close(); });

  // `vonvon update` on that computer, its requests answered as machine.ts does for a server the app carries.
  const out: string[] = [];
  const machine = async (request: MachineRequest): Promise<MachineReply> => {
    out.push(`→ ${request.type}`);
    if (request.type === 'checkCoreUpdate') return { type: 'coreUpdate', distribution: { kind: 'bundled', cliPath: '/x' }, dev: false, ...await server.check('这台电脑上的命令行', request.fresh !== false) };
    if (request.type === 'applyCoreUpdate') return { type: 'done', message: server.apply('这台电脑上的命令行', true) };
    if (request.type === 'coreUpdateStatus') return { type: 'coreUpdateStatus', status: readUpdateStatus() };
    throw new Error(`unexpected ${request.type}`);
  };
  const cli: UpdateCommandDeps = {
    distribution: async () => ({ kind: 'bundled', cliPath: '/x' }),
    daemonRunning: async () => true,
    ownerAlive: async () => true,
    daemon: fn => withDaemon(fn, async () => ({ close: async () => {}, machine }) as unknown as VonvonClient, { local: 5000, feishu: 5000 }),
    readStatus: readUpdateStatus,
    now: Date.now,
    pause: () => new Promise(resolve => setTimeout(resolve, 5)),
    local: () => { throw new Error('not a standalone server'); },
    env: {},
    npm: { check: async () => { throw new Error('not npm'); }, install: async () => { throw new Error('not npm'); } },
  };
  const io = { json: false, write: (text: string) => { out.push(text); } };
  /** The server there stops (a crash, a restart by hand): the app's connection closes, the next is not there yet. */
  const drop = () => { open = false; for (const listener of closed) listener(); };
  return { server, client, driver, updater, remote, notices, cli, io, out, drop };
}

// 264-1: 下载更新 pressed on that computer, 重启升级 not yet. 修之前必败: the check said no update (and the app's own 点击重启升级),
// so the card had no button, `vonvon update --check` said 已是最新, and `vonvon update` installed without saying first that it
// interrupts the conversations.
it('a download already on that computer: the check finds the update, and `vonvon update` says first that it interrupts', async () => {
  const r = rig();
  expect((await r.updater.check()).state).toBe('available');
  const downloading = r.updater.install();
  r.driver.emit('update-downloaded');
  expect((await downloading).state).toBe('downloaded');

  // Another device's card: hasUpdate gives it "更新「X」上的 Vonvon Bot" (server-update-card.test.tsx).
  expect(await r.server.check('「笔记本」', true)).toEqual({ current: '0.9.0', latest: '0.9.1', hasUpdate: true, desktopShell: true });

  await runUpdateCommand({ check: true }, r.io, r.cli);
  expect(r.out.at(-1)).toBe('当前 0.9.0，最新 0.9.1（有新版本，运行 vonvon update 更新）\n');

  r.out.length = 0;
  // The new app's server ends the record once it runs (settleUpdateAtStartup).
  r.driver.quitAndInstall.mockImplementation(() => { void settleUpdateAtStartup({ version: '0.9.1' }); });
  await runUpdateCommand({}, r.io, r.cli);
  expect(r.out.indexOf(`${UPDATE_INTERRUPTS}\n`)).toBeGreaterThan(-1);
  expect(r.out.indexOf(`${UPDATE_INTERRUPTS}\n`)).toBeLessThan(r.out.indexOf('→ applyCoreUpdate'));
  // the download that was there, installed without downloading again
  expect(r.driver.quitAndInstall).toHaveBeenCalledOnce();
  expect(r.driver.checkForUpdates).toHaveBeenCalledOnce();
  expect(r.out.at(-1)).toBe('已更新到 0.9.1\n');
});

// 265-2: the server there stops while the app downloads for another device, and the download ends before the app has
// the next connection. 修之前必败: the app reported to the closed connection, the failure was swallowed, and it went on to
// quitAndInstall, while the record already said the update failed.
it('the server there stops while it downloads: no restart, the download stays, and the update ends as failed', async () => {
  const r = rig();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(r.server.apply('「笔记本」', false)).toBe('开始更新…');
  await vi.waitFor(() => expect(readUpdateStatus()).toMatchObject({ phase: 'installing', detail: 'desktop-downloading' }));
  expect(r.driver.checkForUpdates).toHaveBeenCalledOnce();
  expect(r.notices).toEqual([REMOTE_UPDATE_TEXT.notice('「笔记本」')]);

  r.drop();
  // that process is gone with its lock, and the next one ends the record it left
  r.server.close();
  await settleUpdateAtStartup({ version: '0.9.0' });
  expect(readUpdateStatus()).toMatchObject({ phase: 'error', ok: false, message: '上次更新中断' });

  r.driver.emit('update-downloaded');
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(r.driver.quitAndInstall).not.toHaveBeenCalled();
  expect(r.notices).toEqual([REMOTE_UPDATE_TEXT.notice('「笔记本」'), undefined]);
  expect(r.remote.busy).toBe(false);
  // kept, for 重启升级 on that computer or the next remote update
  expect((await r.updater.check()).state).toBe('downloaded');
  expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: '上次更新中断' });
});
