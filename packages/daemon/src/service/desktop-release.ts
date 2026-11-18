/**
 * 桌面版的下载入口。以前这里去 GitHub 查旧 vonvon-bridge 仓库的 release（已失效，也会把 Windows 安装包摆出来），
 * 现在不再联网，直接给官网下载页：安装包和更新说明都在那里。只发 macOS 桌面版，别的系统不提示下载。
 */
export const DESKTOP_DOWNLOAD_PAGE = 'https://vonvon.bot/get/';

export function desktopDownloadForHost(platform: NodeJS.Platform = process.platform): string | null {
  return platform === 'darwin' ? DESKTOP_DOWNLOAD_PAGE : null;
}

export function desktopDownloadNoticeForHost(platform: NodeJS.Platform = process.platform): string | null {
  const url = desktopDownloadForHost(platform);
  return url ? `Vonvon Bot 桌面版（macOS）可到官网下载：${url}` : null;
}
