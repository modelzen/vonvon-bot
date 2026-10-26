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
  function clock() {
    const timers: { at: number; run: () => void; id: number }[] = [];
    let now = 0, next = 0;
    return {
      setTimer: (run: () => void, ms: number) => { const id = ++next; timers.push({ at: now + ms, run, id }); return id; },
      clearTimer: (id: unknown) => { const i = timers.findIndex(timer => timer.id === id); if (i >= 0) timers.splice(i, 1); },
      pending: () => timers.map(timer => timer.at - now),
      async advance(ms: number) {
        const end = now + ms;
        for (;;) {
          const due = timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
          if (!due) break;
          timers.splice(timers.indexOf(due), 1);
          now = due.at;
          due.run();
          await new Promise(resolve => setImmediate(resolve));
        }
        now = end;
      },
    };
  }
  const found = { state: 'available' as const, current: '1.0.0', latest: '1.1.0', message: 'x' };

  it('checks about a minute after start, then every 24 hours plus up to an hour of random delay', async () => {
    const time = clock();
    const check = vi.fn(async () => found);
    const results: unknown[] = [];
    scheduleUpdateChecks({ check, busy: false }, update => results.push(update), { ...time, random: () => 0.5 });
    expect(time.pending()).toEqual([minute]);
    await time.advance(minute - 1);
    expect(check).not.toHaveBeenCalled();
    await time.advance(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(results).toEqual([found]);
    expect(time.pending()).toEqual([24 * hour + 30 * minute]);
    await time.advance(24 * hour + 30 * minute);
    expect(check).toHaveBeenCalledTimes(2);
    expect(time.pending()).toEqual([24 * hour + 30 * minute]);
  });

  it('keeps the random delay within one hour and uses the default timer without holding the process open', async () => {
    const time = clock();
    scheduleUpdateChecks({ check: async () => found, busy: false }, () => {}, { ...time, random: () => 0.999999 });
    await time.advance(minute);
    const [delay] = time.pending();
    expect(delay).toBeGreaterThan(24 * hour);
    expect(delay).toBeLessThan(25 * hour);
    vi.useFakeTimers();
    try {
      const check = vi.fn(async () => found);
      const stop = scheduleUpdateChecks({ check, busy: false }, () => {});
      await vi.advanceTimersByTimeAsync(minute);
      expect(check).toHaveBeenCalledTimes(1);
      stop();
    } finally { vi.useRealTimers(); }
  });

  it('retries a failed check after an hour and keeps going', async () => {
    const time = clock();
    const check = vi.fn<() => Promise<typeof found>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(found);
    const results: unknown[] = [];
    scheduleUpdateChecks({ check, busy: false }, update => results.push(update), { ...time, random: () => 0 });
    await time.advance(minute);
    expect(results).toEqual([]);
    expect(time.pending()).toEqual([hour]);
    await time.advance(hour);
    expect(results).toEqual([found]);
  });

  it('skips a round while a download is running, and a failing listener does not stop the schedule', async () => {
    const time = clock();
    const updater = { check: vi.fn(async () => found), busy: true };
    const onResult = vi.fn(() => { throw new Error('window gone'); });
    scheduleUpdateChecks(updater, onResult, { ...time, random: () => 0 });
    await time.advance(minute);
    expect(updater.check).not.toHaveBeenCalled();
    updater.busy = false;
    await time.advance(24 * hour);
    expect(updater.check).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(time.pending()).toEqual([24 * hour]);
  });

  it('stops on quit: no pending timer, and a check already running reports nothing', async () => {
    const time = clock();
    const check = vi.fn(async () => found);
    const onResult = vi.fn();
    const stop = scheduleUpdateChecks({ check, busy: false }, onResult, time);
    stop();
    expect(time.pending()).toEqual([]);
    await time.advance(48 * hour);
    expect(check).not.toHaveBeenCalled();

    let finish: (value: typeof found) => void = () => {};
    const slow = vi.fn(() => new Promise<typeof found>(resolve => { finish = resolve; }));
    const stopSlow = scheduleUpdateChecks({ check: slow, busy: false }, onResult, time);
    await time.advance(minute);
    stopSlow();
    finish(found);
    await new Promise(resolve => setImmediate(resolve));
    expect(onResult).not.toHaveBeenCalled();
    expect(time.pending()).toEqual([]);
  });
});
