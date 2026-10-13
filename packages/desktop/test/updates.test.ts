import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopUpdater } from '../src/updates.js';
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
    await expect(updater.check()).resolves.toMatchObject({ state: 'unavailable' });
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

  it('refuses another update while the expected installed version has not appeared', async () => {
    const h = fixture();
    await h.updater.check();
    const download = h.updater.install();
    h.driver.emit('update-downloaded');
    await download;
    await h.updater.install();
    const second = new DesktopUpdater({
      current: '1.0.0', signed: true, manifestURL: 'https://updates.example.test/manifest.json',
      driver: new Driver(), fetch: h.fetch, statePath: h.statePath,
    });
    await expect(second.check()).resolves.toMatchObject({ state: 'unavailable' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects native errors instead of reporting a verified download', async () => {
    const h = fixture();
    await h.updater.check();
    const download = h.updater.install();
    h.driver.emit('error', new Error('bad signature'));
    await expect(download).rejects.toThrow('桌面更新下载或签名校验失败');
    expect(h.driver.quitAndInstall).not.toHaveBeenCalled();
  });
});
