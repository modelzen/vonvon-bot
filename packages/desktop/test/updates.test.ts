import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopUpdateError, DesktopUpdater, scheduleUpdateChecks } from '../src/updates.js';
import { desktopUpdateConfiguration } from '../src/update-configuration.js';

class Driver extends EventEmitter {
  setFeedURL = vi.fn((_options: { url: string }) => {});
  checkForUpdates = vi.fn(() => {});
  quitAndInstall = vi.fn(() => {});
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const driver = new Driver();
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
    version: '1.1.0', feedURL: 'https://updates.example.test/feed',
  })));
  const beforeInstall = vi.fn(async () => {});
  const root = mkdtempSync(join(tmpdir(), 'vonvon-updater-'));
  roots.push(root);
  const statePath = join(root, 'desktop-update-expected-version');
  const updater = new DesktopUpdater({
    current: '1.0.0', signed: true, manifestURL: 'https://updates.example.test/manifest.json',
    driver, fetch, beforeInstall, statePath,
  });
  return { updater, driver, fetch, beforeInstall, statePath };
}

describe('desktop update port', () => {
  it('keeps unsigned previews unavailable without network or native download', async () => {
    const driver = new Driver();
    const fetch = vi.fn();
    const updater = new DesktopUpdater({ current: '1.0.0', signed: false, driver, fetch });
    await expect(updater.check()).resolves.toMatchObject({ state: 'unavailable', message: expect.stringContaining('https://vonvon.cc/get/') });
    await expect(updater.install()).rejects.toThrow('请先检查桌面更新');
    expect(fetch).not.toHaveBeenCalled();
    expect(driver.checkForUpdates).not.toHaveBeenCalled();
    await expect(desktopUpdateConfiguration({ appPath: '/unused', isPackaged: false })).resolves.toEqual({ signed: false });
  });

  it('downloads only after check and first install click, then installs after second click', async () => {
    const h = fixture();
    await expect(h.updater.check()).resolves.toMatchObject({ state: 'available', latest: '1.1.0' });
    expect(h.fetch).toHaveBeenCalledWith('https://updates.example.test/manifest.json', expect.objectContaining({ redirect: 'error' }));
    expect(h.driver.checkForUpdates).not.toHaveBeenCalled();
    const download = h.updater.install();
    expect(h.driver.setFeedURL).toHaveBeenCalledWith({ url: 'https://updates.example.test/feed' });
    expect(h.driver.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(h.driver.quitAndInstall).not.toHaveBeenCalled();
    h.driver.emit('update-downloaded');
    await expect(download).resolves.toMatchObject({ state: 'downloaded' });
    expect(h.beforeInstall).not.toHaveBeenCalled();
    await expect(h.updater.install()).resolves.toMatchObject({ state: 'downloaded' });
    expect(h.beforeInstall).toHaveBeenCalledTimes(1);
    expect(readFileSync(h.statePath, 'utf8')).toBe('1.1.0');
    expect(h.driver.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it.each(['arm64', 'x64'] as const)('selects the %s update feed while preserving old manifests', async architecture => {
    const driver = new Driver();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ version: '1.1.0', feedURL: 'https://updates.example.test/universal', feedURLs: { arm64: 'https://updates.example.test/arm64', x64: 'https://updates.example.test/x64' } })));
    const updater = new DesktopUpdater({ current: '1.0.0', signed: true, architecture, manifestURL: 'https://updates.example.test/manifest.json', driver, fetch });
    await updater.check();
    const pending = updater.install();
    expect(driver.setFeedURL).toHaveBeenCalledWith({ url: `https://updates.example.test/${architecture}` });
    driver.emit('update-downloaded'); await pending;
  });

  it('rejects a cross-origin architecture feed', async () => {
    const driver = new Driver();
    const fetch = vi.fn(async () => new Response(JSON.stringify({version: '1.1.0', feedURL: 'https://updates.example.test/universal', feedURLs: { arm64: 'https://attacker.example.test/feed', x64: 'https://updates.example.test/x64' }})));
    const updater = new DesktopUpdater({ current: '1.0.0', signed: true, architecture: 'arm64', manifestURL: 'https://updates.example.test/manifest.json', driver, fetch });
    await expect(updater.check()).rejects.toThrow('更新源地址不可信');
    expect(driver.checkForUpdates).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin feed and never starts the native driver', async () => {
    const h = fixture();
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      version: '1.1.0', feedURL: 'https://attacker.example.test/feed',
    })));
    await expect(h.updater.check()).rejects.toThrow('更新源地址不可信');
    await expect(h.updater.install()).rejects.toThrow('请先检查桌面更新');
    expect(h.driver.checkForUpdates).not.toHaveBeenCalled();
  });

  /** A first run that downloaded 1.1.0 and asked for the install, but the running app is still 1.0.0. */
  async function failedInstall() {
    const h = fixture();
    await h.updater.check();
    const download = h.updater.install();
    h.driver.emit('update-downloaded');
    await download;
    await h.updater.install();
    const secondDriver = new Driver();
    const second = new DesktopUpdater({
      current: '1.0.0', signed: true, manifestURL: 'https://updates.example.test/manifest.json',
      driver: secondDriver, fetch: h.fetch, statePath: h.statePath,
    });
    h.fetch.mockClear();
    return { ...h, second, secondDriver };
  }

  it('asks the user to retry, instead of refusing for good, while the expected version has not appeared', async () => {
    const h = await failedInstall();
    await expect(h.second.check()).resolves.toMatchObject({ state: 'install-pending', latest: '1.1.0', message: expect.stringContaining('上次安装尚未生效') });
    expect(existsSync(h.statePath)).toBe(true);
    await expect(h.second.retry()).resolves.toMatchObject({ state: 'available', latest: '1.1.0' });
    expect(existsSync(h.statePath)).toBe(false);
  });

  it('keeps reading the manifest while an install is unsettled: still pending offline, available once a newer release is out', async () => {
    const h = await failedInstall();
    // The same manifest every time would only repeat the pending state, but it is read each time.
    await expect(h.second.check()).resolves.toMatchObject({ state: 'install-pending' });
    await expect(h.second.check()).resolves.toMatchObject({ state: 'install-pending' });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(h.second.check()).resolves.toMatchObject({ state: 'install-pending', latest: '1.1.0' });
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ version: '1.2.0', feedURL: 'https://updates.example.test/feed' })));
    const newer = await h.second.check();
    expect(newer).toMatchObject({ state: 'available', latest: '1.2.0', message: expect.stringContaining('上次安装 1.1.0 没有生效') });
    // That newer release can be downloaded right away.
    const download = h.second.install();
    expect(h.secondDriver.setFeedURL).toHaveBeenCalledWith({ url: 'https://updates.example.test/feed' });
    h.secondDriver.emit('update-downloaded');
    await expect(download).resolves.toMatchObject({ state: 'downloaded', latest: '1.2.0' });
  });

  it('does not fetch the manifest for an unsettled install when there is no signed update source', async () => {
    const h = await failedInstall();
    const unsigned = new DesktopUpdater({ current: '1.0.0', signed: false, driver: new Driver(), fetch: h.fetch, statePath: h.statePath });
    await expect(unsigned.check()).resolves.toMatchObject({ state: 'install-pending' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('says in Chinese, as a user-facing error, why a retry could not clear the install record', async () => {
    const h = fixture();
    // A directory with a file in it cannot be removed as a record, whoever runs the test.
    mkdirSync(h.statePath);
    writeFileSync(join(h.statePath, 'x'), '');
    const failure = await h.updater.retry().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DesktopUpdateError);
    expect((failure as Error).message).toContain('https://vonvon.cc/get/');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('answers one check at a time: a second call during a check shares its network request', async () => {
    const h = fixture();
    const [first, second] = await Promise.all([h.updater.check(), h.updater.check()]);
    expect(second).toBe(first);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await h.updater.check();
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('lets the user start the download while another check is still waiting for the network', async () => {
    const h = fixture();
    await h.updater.check();
    let answer: (response: Response) => void = () => {};
    h.fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { answer = resolve; }));
    const again = h.updater.check();
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2));
    const download = h.updater.install();
    expect(h.driver.setFeedURL).toHaveBeenCalledWith({ url: 'https://updates.example.test/feed' });
    h.driver.emit('update-downloaded');
    await expect(download).resolves.toMatchObject({ state: 'downloaded', latest: '1.1.0' });
    answer(new Response(JSON.stringify({ version: '1.1.0', feedURL: 'https://updates.example.test/feed' })));
    // The check that was still running reports what is true now: the update is already downloaded.
    await expect(again).resolves.toMatchObject({ state: 'downloaded' });
  });

  it('records the version the user chose to download, even when a later check sees a newer release', async () => {
    const h = fixture();
    await h.updater.check();
    const download = h.updater.install();
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ version: '1.2.0', feedURL: 'https://updates.example.test/feed' })));
    await expect(h.updater.check()).resolves.toMatchObject({ state: 'available', latest: '1.2.0' });
    h.driver.emit('update-downloaded');
    await expect(download).resolves.toMatchObject({ state: 'downloaded', latest: '1.1.0' });
    await h.updater.install();
    expect(readFileSync(h.statePath, 'utf8')).toBe('1.1.0');
  });

  it.each([
    ['no network', () => Promise.reject(new TypeError('fetch failed')), '连不上更新服务器'],
    ['a timeout', () => Promise.reject(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })), '没有及时回应'],
    ['a server error', () => Promise.resolve(new Response('', { status: 503 })), '更新服务器返回 503'],
    ['a manifest that is not JSON', () => Promise.resolve(new Response('<html>')), '更新清单格式不对'],
    ['a manifest without a version', () => Promise.resolve(new Response('{}')), '更新清单格式不对'],
  ])('reports %s as a Chinese message the window may show, without the raw cause', async (_name, respond, words) => {
    const h = fixture();
    h.fetch.mockImplementationOnce(respond);
    const failure = await h.updater.check().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DesktopUpdateError);
    expect((failure as Error).message).toContain(words);
    expect((failure as Error).message).not.toMatch(/fetch failed|timed out|SyntaxError|ZodError/);
  });

  it.each([['the same version', '1.0.0'], ['a lower version', '0.9.0'], ['an unreadable record', 'not a version'], ['an empty record', '']])(
    'drops the expected-version record at startup when the running version already reaches it (%s)', async (_name, recorded) => {
      const h = fixture();
      writeFileSync(h.statePath, recorded);
      await h.updater.settleInstallState();
      expect(existsSync(h.statePath)).toBe(false);
      await expect(h.updater.check()).resolves.toMatchObject({ state: 'available' });
    },
  );

  it('keeps the record at startup while the running version is still older, and clears it after an update to a newer one', async () => {
    const h = fixture();
    writeFileSync(h.statePath, '1.0.5');
    await h.updater.settleInstallState();
    expect(readFileSync(h.statePath, 'utf8')).toBe('1.0.5');
    const later = new DesktopUpdater({
      current: '1.2.0', signed: true, manifestURL: 'https://updates.example.test/manifest.json',
      driver: new Driver(), fetch: h.fetch, statePath: h.statePath,
    });
    await expect(later.check()).resolves.toMatchObject({ state: 'current' });
    expect(existsSync(h.statePath)).toBe(false);
  });

  it('ignores unknown manifest fields but still requires a version and a same-origin feed', async () => {
    const h = fixture();
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      version: '1.1.0', feedURL: 'https://updates.example.test/feed',
      notes: '修复若干问题', minimumSystemVersion: '12.0', channel: 'stable', rollout: { percent: 50 },
    })));
    await expect(h.updater.check()).resolves.toMatchObject({ state: 'available', latest: '1.1.0' });
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ feedURL: 'https://updates.example.test/feed', notes: 'x' })));
    await expect(h.updater.check()).rejects.toThrow();
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ version: '1.1.0-beta.1', feedURL: 'https://updates.example.test/feed' })));
    await expect(h.updater.check()).rejects.toThrow();
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ version: '1.1.0', feedURL: 'http://updates.example.test/feed', notes: 'x' })));
    await expect(h.updater.check()).rejects.toThrow('更新源地址不可信');
  });

  it('is enabled only with a signed update source', () => {
    const driver = new Driver();
    expect(new DesktopUpdater({ current: '1.0.0', signed: false, manifestURL: 'https://updates.example.test/manifest.json', driver }).enabled).toBe(false);
    expect(new DesktopUpdater({ current: '1.0.0', signed: true, driver }).enabled).toBe(false);
    expect(fixture().updater.enabled).toBe(true);
  });

  it('does not install or persist success when preparation fails, and permits retry', async () => {
    const h = fixture();
    await h.updater.check();
    const download = h.updater.install();
    h.driver.emit('update-downloaded');
    await download;
    h.beforeInstall.mockRejectedValueOnce(new Error('daemon did not stop'));
    await expect(h.updater.install()).rejects.toThrow('daemon did not stop');
    expect(h.driver.quitAndInstall).not.toHaveBeenCalled();
    expect(() => readFileSync(h.statePath, 'utf8')).toThrow();
    await h.updater.install();
    expect(h.driver.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('rejects native errors instead of reporting a verified download', async () => {
    const h = fixture();
    await h.updater.check();
    const download = h.updater.install();
    h.driver.emit('error', new Error('bad signature'));
    await expect(download).rejects.toThrow('桌面更新下载或签名校验失败');
    h.driver.emit('update-downloaded');
    await expect(h.updater.check()).resolves.toMatchObject({ state: 'available' });
    expect(h.beforeInstall).not.toHaveBeenCalled();
    expect(h.driver.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe('automatic update checks', () => {
  const minute = 60 * 1000, hour = 60 * minute;
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  function clock(start = '2026-11-02T09:00:00+08:00') {
    const timers: { at: number; run: () => void; id: number }[] = [];
    let now = Date.parse(start), next = 0;
    let resume: (() => void) | undefined;
    return {
      now: () => now,
      onResume: (listener: () => void) => { resume = listener; return () => { resume = undefined; }; },
      resume: () => resume?.(),
      sleep: (ms: number) => { now += ms; },
      setTimer: (run: () => void, ms: number) => { const id = ++next; timers.push({ at: now + ms, run, id }); return id; },
      clearTimer: (id: unknown) => { const i = timers.findIndex(timer => timer.id === id); if (i >= 0) timers.splice(i, 1); },
      pending: () => timers.map(timer => timer.at - now),
      async advance(ms: number) {
        const end = now + ms;
        for (;;) {
          const due = timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
          if (!due) break;
          timers.splice(timers.indexOf(due), 1);
          now = Math.max(now, due.at);
          due.run();
          await flush();
        }
        now = end;
      },
    };
  }
  const found = { state: 'available' as const, current: '1.0.0', latest: '1.1.0', message: 'x' };

  it('checks after two minutes and finds a later release after 90 minutes without restarting', async () => {
    const time = clock();
    const check = vi.fn().mockResolvedValueOnce({ ...found, state: 'current' }).mockResolvedValue(found);
    const results: unknown[] = [];
    scheduleUpdateChecks({ check, busy: false }, update => results.push(update), time);
    expect(time.pending()).toEqual([2 * minute]);
    await time.advance(2 * minute - 1);
    expect(check).not.toHaveBeenCalled();
    await time.advance(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ ...found, state: 'current' }]);
    expect(time.pending()).toEqual([90 * minute]);
    await time.advance(90 * minute - 1);
    expect(check).toHaveBeenCalledTimes(1);
    await time.advance(1);
    expect(results).toEqual([{ ...found, state: 'current' }, found]);
    expect(time.pending()).toEqual([90 * minute]);
  });

  it('uses a native timer without keeping the process alive', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T09:00:00+08:00'));
    try {
      const check = vi.fn(async () => found);
      const stop = scheduleUpdateChecks({ check, busy: false }, () => {});
      await vi.advanceTimersByTimeAsync(2 * minute);
      expect(check).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
      stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ['2026-11-02T00:00:00+08:00', true],
    ['2026-11-02T01:59:59.999+08:00', true],
    ['2026-11-02T02:00:00+08:00', false],
    ['2026-11-02T04:59:59.999+08:00', false],
    ['2026-11-02T05:00:00+08:00', true],
    ['2026-11-02T23:59:59.999+08:00', true],
  ])('uses the Beijing time window at %s (allowed: %s)', async (start, allowed) => {
    const time = clock(start);
    const check = vi.fn(async () => found);
    scheduleUpdateChecks({ check, busy: false }, () => {}, { ...time, firstDelayMs: 0 });
    await time.advance(0);
    expect(check).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(time.pending()).toEqual([90 * minute]);
  });

  it.each(['02:08:00', '02:38:00'])('keeps its own phase after skipping the first check at night (%s)', async start => {
    const time = clock(`2026-11-02T${start}+08:00`);
    const check = vi.fn(async () => found);
    scheduleUpdateChecks({ check, busy: false }, () => {}, time);
    await time.advance(3 * hour + 2 * minute - 1);
    expect(check).not.toHaveBeenCalled();
    await time.advance(1);
    expect(check).toHaveBeenCalledOnce();
    expect(time.pending()).toEqual([90 * minute]);
  });

  it('keeps the fixed cycle after an initial failure and a failing result listener', async () => {
    const time = clock();
    const check = vi.fn<() => Promise<typeof found>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(found);
    const onResult = vi.fn(() => { throw new Error('window gone'); });
    scheduleUpdateChecks({ check, busy: false }, onResult, time);
    await time.advance(2 * minute);
    expect(onResult).not.toHaveBeenCalled();
    expect(time.pending()).toEqual([90 * minute]);
    await time.advance(90 * minute);
    expect(onResult).toHaveBeenCalledOnce();
    expect(time.pending()).toEqual([90 * minute]);
    await time.advance(90 * minute);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('skips a download in progress and resumes at its own next slot', async () => {
    const time = clock();
    const updater = { check: vi.fn(async () => found), busy: true };
    scheduleUpdateChecks(updater, () => {}, time);
    await time.advance(2 * minute);
    expect(updater.check).not.toHaveBeenCalled();
    updater.busy = false;
    await time.advance(90 * minute);
    expect(updater.check).toHaveBeenCalledOnce();
    expect(time.pending()).toEqual([90 * minute]);
  });

  it('waits 90 minutes from completion, coalescing resume events during a slow check', async () => {
    const time = clock();
    let finish!: (value: typeof found) => void;
    const check = vi.fn(() => new Promise<typeof found>(resolve => { finish = resolve; }));
    scheduleUpdateChecks({ check, busy: false }, () => {}, time);
    await time.advance(2 * minute);
    await time.advance(3 * minute);
    time.resume();
    time.resume();
    expect(check).toHaveBeenCalledOnce();
    expect(time.pending()).toEqual([]);
    finish(found);
    await flush();
    expect(time.pending()).toEqual([90 * minute]);
  });

  it('catches up only once after a long sleep, cancelling the overdue timer', async () => {
    const time = clock();
    const check = vi.fn(async () => found);
    scheduleUpdateChecks({ check, busy: false }, () => {}, time);
    time.resume();
    expect(check).not.toHaveBeenCalled();
    expect(time.pending()).toEqual([2 * minute]);
    time.sleep(3 * hour);
    time.resume();
    time.resume();
    await time.advance(0);
    expect(check).toHaveBeenCalledOnce();
    expect(time.pending()).toEqual([90 * minute]);
    await time.advance(90 * minute);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('also catches up once when an overdue timer arrives before the resume event', async () => {
    const time = clock();
    const check = vi.fn(async () => found);
    scheduleUpdateChecks({ check, busy: false }, () => {}, time);
    time.sleep(3 * hour);
    await time.advance(0);
    time.resume();
    await flush();
    expect(check).toHaveBeenCalledOnce();
    expect(time.pending()).toEqual([90 * minute]);
  });

  it('re-arms an early timer after the wall clock moves backwards', async () => {
    const time = clock();
    let correction = 0;
    const check = vi.fn(async () => found);
    scheduleUpdateChecks({ check, busy: false }, () => {}, { ...time, now: () => time.now() + correction });
    correction = -5 * minute;
    await time.advance(2 * minute);
    expect(check).not.toHaveBeenCalled();
    expect(time.pending()).toEqual([5 * minute]);
    await time.advance(5 * minute);
    expect(check).toHaveBeenCalledOnce();
    expect(time.pending()).toEqual([90 * minute]);
  });

  it('resuming at night skips missed slots without resetting the phase to 05:00', async () => {
    const time = clock('2026-11-01T23:00:00+08:00');
    const check = vi.fn(async () => found);
    scheduleUpdateChecks({ check, busy: false }, () => {}, time);
    time.sleep(5 * hour);
    time.resume();
    await time.advance(0);
    expect(check).not.toHaveBeenCalled();
    expect(time.pending()).toEqual([62 * minute]);
    await time.advance(62 * minute);
    expect(check).toHaveBeenCalledOnce();
  });

  it('stops on quit, including resume events and an in-flight result', async () => {
    const time = clock();
    const check = vi.fn(async () => found);
    const onResult = vi.fn();
    const stop = scheduleUpdateChecks({ check, busy: false }, onResult, time);
    stop();
    stop();
    expect(time.pending()).toEqual([]);
    time.sleep(48 * hour);
    time.resume();
    await time.advance(0);
    expect(check).not.toHaveBeenCalled();

    let finish!: (value: typeof found) => void;
    const slow = vi.fn(() => new Promise<typeof found>(resolve => { finish = resolve; }));
    const stopSlow = scheduleUpdateChecks({ check: slow, busy: false }, onResult, time);
    await time.advance(2 * minute);
    stopSlow();
    finish(found);
    await flush();
    time.resume();
    expect(onResult).not.toHaveBeenCalled();
    expect(time.pending()).toEqual([]);
  });
});
