import { describe, expect, it, vi } from 'vitest';
import { desktopDownloadForHost, desktopDownloadNoticeForHost, DESKTOP_DOWNLOAD_PAGE } from '../src/service/desktop-release';
import { buildDmMenuCard, buildForegroundRestartCard, buildForegroundUpdateCard } from '../src/card/dm-cards';

describe('desktop download guidance', () => {
  it('points at the official download page and never goes to the network', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    try {
      expect(DESKTOP_DOWNLOAD_PAGE).toBe('https://vonvon.bot/get/');
      expect(desktopDownloadForHost('darwin')).toBe('https://vonvon.bot/get/');
      expect(desktopDownloadNoticeForHost('darwin')).toContain('https://vonvon.bot/get/');
      expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('only macOS gets a download prompt: there is no Windows or Linux desktop build', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(desktopDownloadForHost(platform)).toBeNull();
      expect(desktopDownloadNoticeForHost(platform)).toBeNull();
    }
  });

  it('keeps the DM menu free of installer banners and puts the download page on the update card', () => {
    const menu = JSON.stringify(buildDmMenuCard());
    expect(menu).not.toMatch(/桌面版|Windows|bot\.vonvon\.cc|github\.com/);
    const update = JSON.stringify(buildForegroundUpdateCard({ current: '0.7.0', desktopDownload: DESKTOP_DOWNLOAD_PAGE }));
    expect(update).toContain('https://vonvon.bot/get/');
    expect(update).toContain('打开下载页');
    expect(update).not.toMatch(/Windows|github\.com/);
    expect(JSON.stringify(buildForegroundUpdateCard({ current: '0.7.0' }))).not.toContain('下载页');
    const bundled = JSON.stringify(buildForegroundUpdateCard({ current: '0.7.0', distribution: 'bundled', desktopDownload: DESKTOP_DOWNLOAD_PAGE }));
    expect(bundled).toContain('请在桌面应用中更新');
    expect(bundled).not.toContain('下载页');
    expect(bundled).not.toContain('立即更新');
  });
});

describe('foreground guidance wording', () => {
  it('never appends legacy package installation or sudo advice, and does not talk about "V2"', () => {
    for (const text of [JSON.stringify(buildForegroundUpdateCard({ current: '0.7.0', desktopDownload: DESKTOP_DOWNLOAD_PAGE })), JSON.stringify(buildForegroundRestartCard())]) {
      expect(text).not.toContain('npm i -g');
      expect(text).not.toContain('sudo');
      expect(text).not.toContain('V2');
    }
    expect(JSON.stringify(buildForegroundUpdateCard({ current: '0.7.0' }))).toContain('前台运行的 daemon 不支持在此更新');
    expect(JSON.stringify(buildForegroundRestartCard())).toContain('vonvon daemon run');
  });
});

it('keeps the seven DM management actions and version badge under the Vonvon Bot title, without the retired console row', () => {
  const menu = JSON.stringify(buildDmMenuCard({ version: '0.7.0' }));
  for (const label of ['新建项目', '项目列表', '设置', '用量', '诊断', '重启', '更新']) expect(menu).toContain(label);
  expect(menu).toContain('🤖 Vonvon Bot 管理台');
  expect(menu).not.toContain('Codex Bridge');
  expect(menu).toContain('v0.7.0');
  expect(menu).toContain('"enable_forward":false');
  expect(menu).not.toContain('网页控制台');
});
