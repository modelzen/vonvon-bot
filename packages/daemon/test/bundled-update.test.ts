import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopUpdateReport, Event } from '@vonvon/protocol';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { paths: { appDir: mkdtempSync(join(tmpdir(), 'vonvon-bundled-update-')) } };
});

import { paths } from '../src/config/paths';
import { BUNDLED_TEXT, CHECK_WAIT_MS, createBundledUpdate, FIRST_REPORT_MS, pendingRestart, RESTARTED_MS, STALLED_MS, type DesktopShellPeer } from '../src/service/bundled-update';
import { settleUpdateAtStartup, restartPending } from '../src/service/standalone-update';
import { acquireUpdateLock, clearUpdateStatus, readUpdateStatus, writeUpdateStatus } from '../src/service/update';

// devices-ui-4 第 5 节 bundled-update: a fake shell, fake timers, a real update-status.json in a temp data directory.
// main 必败: a bundled server's update asked npm, and installed an npm package over nothing.
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(1_000_000); clearUpdateStatus(); });
afterEach(() => { vi.useRealTimers(); });

type Shell = DesktopShellPeer & { events: Array<Extract<Event, { event: 'desktopUpdateRequest' }>['payload']>; open: boolean };
const shellPeer = (id = 'shell'): Shell => {
  const events: Shell['events'] = [];
  return { id, open: true, events, event: event => { if (event.event === 'desktopUpdateRequest') events.push(event.payload); } };
};
const silent = { info: vi.fn(), warn: vi.fn() };
function harness(shells: Shell[] = [shellPeer()], platform: NodeJS.Platform = 'darwin') {
  const update = createBundledUpdate({ shells: () => shells, version: '0.9.0', deviceName: () => 'Mac mini', platform, log: silent });
  const report = (shell: Shell, state: DesktopUpdateReport['state'], extra: Partial<DesktopUpdateReport> = {}, requestId = shell.events.at(-1)?.requestId ?? 'dur_0000000000000000') =>
    update.report(shell, { type: 'desktopUpdateReport', requestId, state, message: extra.message ?? state, ...extra });
  return { update, shells, report };
}
const lockFree = (): boolean => { const release = acquireUpdateLock(); release?.(); return release !== null; };
const thrown = (run: () => unknown): { code?: string; message?: string } => { try { run(); } catch (error) { return error as { code: string; message: string }; } return {}; };

it('with no shell, checks say so and the update is refused in the design words', async () => {
  const { update } = harness([]);
  expect(await update.check('「笔记本」', true)).toEqual({ current: '0.9.0', latest: null, hasUpdate: false, desktopShell: false });
  expect(thrown(() => update.apply('「笔记本」', false))).toMatchObject({ code: 'desktop_not_running', message: BUNDLED_TEXT.notRunning('Mac mini') });
  expect(thrown(() => update.apply('本机的命令行', true))).toMatchObject({ code: 'desktop_not_running', message: BUNDLED_TEXT.notRunningHere });
  expect(readUpdateStatus()).toBeNull();
});

it('a Windows server is updated on that computer only (owner 2026-11-02): no event, no record', async () => {
  const shell = shellPeer();
  const { update } = harness([shell], 'win32');
  expect(await update.check('「笔记本」', true)).toEqual({ current: '0.9.0', latest: null, hasUpdate: false, message: BUNDLED_TEXT.windows('Mac mini') });
  expect(thrown(() => update.apply('「笔记本」', false))).toMatchObject({ code: 'unsupported', message: expect.stringContaining('请在那台电脑上打开 Vonvon Bot 更新') });
  expect(shell.events).toEqual([]);
  expect(readUpdateStatus()).toBeNull();
});

it('asks the shell to check, keeps the answer for fresh: false, and says when it does not answer', async () => {
  const shell = shellPeer();
  const { update, report } = harness([shell]);
  const first = update.check('「笔记本」', false);
  expect(shell.events).toEqual([{ requestId: expect.stringMatching(/^dur_[0-9a-f]{16}$/), action: 'check', by: '「笔记本」' }]);
  // a second check while the first waits shares it
  const second = update.check('「笔记本」', true);
  report(shell, 'available', { latest: '0.9.1' });
  expect(await first).toEqual({ current: '0.9.0', latest: '0.9.1', hasUpdate: true, desktopShell: true });
  expect(await second).toEqual(await first);
  expect(await update.check('「笔记本」', false)).toEqual(await first);
  expect(shell.events).toHaveLength(1);
  const slow = update.check('「笔记本」', true);
  expect(shell.events).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(CHECK_WAIT_MS);
  expect(await slow).toEqual({ current: '0.9.0', latest: null, hasUpdate: false, desktopShell: true, message: BUNDLED_TEXT.noAnswer });
  // a check that did not answer is not kept; the late answer is refused
  expect(await update.check('「笔记本」', false)).toEqual(await first);
  expect(thrown(() => report(shell, 'current', {}, shell.events[1]!.requestId))).toMatchObject({ code: 'invalid_request' });
});

// Codex 审查 264-1、265-1: the app there has the update downloaded and was not restarted yet (下载更新 pressed there, or a
// remote update that did not install). It is an update to install, as the shell installs a download that is there; the
// app's own 点击重启升级 is for the person there. 修之前必败: `hasUpdate: false`, with that line.
it('takes a download already there as an update to install, without the words for the person there', async () => {
  const shell = shellPeer();
  const { update, report } = harness([shell]);
  const checking = update.check('「笔记本」', true);
  report(shell, 'downloaded', { latest: '0.9.1', message: '更新已下载，点击重启升级' });
  expect(await checking).toEqual({ current: '0.9.0', latest: '0.9.1', hasUpdate: true, desktopShell: true });
  expect(await update.check('「笔记本」', false)).toEqual(await checking);
});

it('passes on what the updater says when it cannot update', async () => {
  const shell = shellPeer();
  const { update, report } = harness([shell]);
  const checking = update.check('「笔记本」', true);
  report(shell, 'unavailable', { message: '这个安装包没有可用的签名更新源，请到官网下载新版本：https://vonvon.bot/get/' });
  expect(await checking).toEqual({ current: '0.9.0', latest: null, hasUpdate: false, desktopShell: true, message: expect.stringContaining('没有可用的签名更新源') });
});

it('runs the update through to restarting, with the lock held until then', async () => {
  const shell = shellPeer();
  const { update, report } = harness([shellPeer('old'), shell]);
  expect(update.apply('「笔记本」', false)).toBe('开始更新…');
  // the newest shell connection is asked
  expect(shell.events).toEqual([{ requestId: expect.stringMatching(/^dur_/), action: 'apply', by: '「笔记本」' }]);
  expect(readUpdateStatus()).toMatchObject({ phase: 'installing', detail: 'desktop-checking', via: 'desktop', from: '0.9.0' });
  expect(lockFree()).toBe(false);
  report(shell, 'available', { latest: '0.9.1' });
  report(shell, 'downloading', { latest: '0.9.1', progress: { transferred: 50, total: 100 } });
  expect(readUpdateStatus()).toMatchObject({ phase: 'installing', detail: 'desktop-downloading', progress: { transferred: 50, total: 100 }, to: '0.9.1', via: 'desktop' });
  report(shell, 'downloaded', { latest: '0.9.1' });
  expect(readUpdateStatus()).toMatchObject({ phase: 'installing', detail: 'desktop-downloaded', to: '0.9.1' });
  expect(readUpdateStatus()?.progress).toBeUndefined();
  report(shell, 'restarting', { latest: '0.9.1' });
  expect(readUpdateStatus()).toMatchObject({ phase: 'restarting', detail: 'draining', to: '0.9.1', via: 'desktop', from: '0.9.0' });
  expect(lockFree()).toBe(true);
  update.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not ask the shell to check while it updates, and still takes the update reports (main 必败)', async () => {
  const shell = shellPeer();
  const { update, report } = harness([shell]);
  update.apply('「笔记本」', false);
  report(shell, 'downloading', { latest: '0.9.1' }, shell.events[0]!.requestId);
  expect(await update.check('「笔记本」', true)).toEqual({ current: '0.9.0', latest: '0.9.1', hasUpdate: false, desktopShell: true });
  expect(shell.events.map(event => event.action)).toEqual(['apply']);
  report(shell, 'downloaded', { latest: '0.9.1' }, shell.events[0]!.requestId);
  report(shell, 'restarting', { latest: '0.9.1' }, shell.events[0]!.requestId);
  expect(readUpdateStatus()).toMatchObject({ phase: 'restarting' });
  update.close();
});

it('ends at once when the app is up to date or cannot update', () => {
  const shell = shellPeer();
  const { update, report } = harness([shell]);
  update.apply('「笔记本」', false);
  report(shell, 'current', { latest: '0.9.0' });
  expect(readUpdateStatus()).toMatchObject({ phase: 'done', ok: true, message: '已是最新', via: 'desktop' });
  expect(lockFree()).toBe(true);
  update.apply('「笔记本」', false);
  report(shell, 'unavailable', { message: '这个安装包没有可用的签名更新源' });
  expect(readUpdateStatus()).toMatchObject({ phase: 'error', ok: false, message: '这个安装包没有可用的签名更新源' });
  expect(lockFree()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('refuses a second update while one runs and while its restart is pending', async () => {
  const shell = shellPeer();
  const { update, report } = harness([shell]);
  update.apply('「笔记本」', false);
  expect(thrown(() => update.apply('「笔记本」', false))).toMatchObject({ code: 'conflict', message: BUNDLED_TEXT.busy });
  report(shell, 'restarting', { latest: '0.9.1' });
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(thrown(() => update.apply('「笔记本」', false))).toMatchObject({ code: 'conflict', message: BUNDLED_TEXT.restartPending });
  // the 10-minute watchdog ended it: another may start
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  expect(readUpdateStatus()).toMatchObject({ phase: 'error' });
  expect(update.apply('「笔记本」', false)).toBe('开始更新…');
  update.close();
});

it('pendingRestart takes a desktop restart, which I3 does not (main 必败)', () => {
  const now = 10 * 60 * 60_000;
  const desktop = { phase: 'restarting' as const, via: 'desktop' as const, from: '0.9.0', to: '0.9.1', detail: 'draining' as const, at: now - 5 * 60_000 };
  expect(pendingRestart(desktop, now)).toBe(true);
  expect(restartPending(desktop, now)).toBe(false);
  expect(pendingRestart({ ...desktop, at: now - 11 * 60_000 }, now)).toBe(false);
  expect(pendingRestart({ phase: 'restarting', previous: '0.9.0', detail: 'draining', at: now - 5 * 60_000 }, now)).toBe(true);
  expect(pendingRestart({ phase: 'done', at: now }, now)).toBe(false);
});

it('takes reports only from the shell it asked, for the update under way', () => {
  const shell = shellPeer();
  const other = shellPeer('other');
  const { update, report } = harness([other, shell]);
  update.apply('「笔记本」', false);
  const id = shell.events[0]!.requestId;
  expect(thrown(() => report(other, 'downloading', {}, id))).toMatchObject({ code: 'invalid_request', message: BUNDLED_TEXT.notYours });
  expect(thrown(() => report(shell, 'downloading', {}, 'dur_ffffffffffffffff'))).toMatchObject({ code: 'invalid_request' });
  report(shell, 'current', {}, id);
  expect(thrown(() => report(shell, 'downloading', {}, id))).toMatchObject({ code: 'invalid_request' });
});

it.each([
  ['no first report', async () => { await vi.advanceTimersByTimeAsync(FIRST_REPORT_MS); }, BUNDLED_TEXT.noFirstReport],
  ['a stalled download', async (h: ReturnType<typeof harness>) => { h.report(h.shells[0]!, 'downloading'); await vi.advanceTimersByTimeAsync(STALLED_MS); }, BUNDLED_TEXT.stalled],
  ['the shell closing before the restart', async (h: ReturnType<typeof harness>) => { h.update.shellDetached(h.shells[0]!); }, BUNDLED_TEXT.closed],
  ['the old server still up after the restart', async (h: ReturnType<typeof harness>) => { h.report(h.shells[0]!, 'restarting', { latest: '0.9.1' }); await vi.advanceTimersByTimeAsync(RESTARTED_MS); }, BUNDLED_TEXT.notReplaced],
  ['the old app back after the restart', async (h: ReturnType<typeof harness>) => { h.report(h.shells[0]!, 'restarting', { latest: '0.9.1' }); h.update.shellAttached(shellPeer('again')); }, BUNDLED_TEXT.reopened('0.9.0')],
] as const)('ends the record on %s, the lock let go (main 必败)', async (_name, step, message) => {
  const h = harness([shellPeer()]);
  h.update.apply('「笔记本」', false);
  await step(h);
  expect(readUpdateStatus()).toMatchObject({ phase: 'error', message, via: 'desktop' });
  expect(lockFree()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('takes an error after restarting: the install stopped before the app quit', () => {
  const shell = shellPeer();
  const { update, report } = harness([shell]);
  update.apply('「笔记本」', false);
  report(shell, 'restarting', { latest: '0.9.1' });
  report(shell, 'error', { message: '桌面更新下载或签名校验失败' });
  expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: '桌面更新下载或签名校验失败' });
  expect(lockFree()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('leaves a record that is no longer its own', async () => {
  const { update } = harness([shellPeer()]);
  update.apply('「笔记本」', false);
  writeUpdateStatus({ phase: 'installing', from: '0.9.0', at: 1, detail: 'downloading' });
  await vi.advanceTimersByTimeAsync(FIRST_REPORT_MS);
  expect(readUpdateStatus()).toEqual({ phase: 'installing', from: '0.9.0', at: 1, detail: 'downloading' });
  expect(lockFree()).toBe(true);
});

it('close() leaves no timer and lets the lock go', () => {
  const { update } = harness([shellPeer()]);
  update.apply('「笔记本」', false);
  void update.check('「笔记本」', true);
  update.close();
  expect(vi.getTimerCount()).toBe(0);
  expect(lockFree()).toBe(true);
});

it('the next server ends a desktop restart by its own version, with no install root', async () => {
  vi.useRealTimers();
  const record = { phase: 'restarting' as const, detail: 'draining' as const, via: 'desktop' as const, from: '0.9.0', to: '0.9.1', at: 7 };
  writeUpdateStatus(record);
  await settleUpdateAtStartup({ version: '0.9.1' });
  expect(readUpdateStatus()).toMatchObject({ phase: 'done', ok: true, to: '0.9.1', via: 'desktop' });
  writeUpdateStatus(record);
  await settleUpdateAtStartup({ version: '0.9.0' });
  expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: '重启后仍是 0.9.0' });
});
