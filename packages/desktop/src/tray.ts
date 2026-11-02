import { Menu, nativeImage, Tray } from 'electron';
import { dirname, join } from 'node:path';

export interface DesktopTray {
  destroy(): void;
  /** 有更新提示时（"有新版本 x.y.z"、"上次更新没装上"）在菜单最上面加一项，点它打开窗口；传 undefined 去掉。菜单栏图标本身不变。 */
  setUpdate(notice: string | undefined): void;
  /** U4: a line that is not a button at the top of the menu ("「笔记本」正在更新这台电脑上的 Vonvon Bot…"); undefined takes it away. */
  setNotice(text: string | undefined): void;
}

function trayImage(pngPath: string, platform: NodeJS.Platform) {
  // Let Windows pick the ICO representation matching the taskbar's DPI. The
  // opaque logo stays legible on both light and dark taskbars.
  if (platform === 'win32') return join(dirname(pngPath), 'windows-icon.ico');
  const source = nativeImage.createFromPath(pngPath);
  if (source.isEmpty()) throw new Error('找不到菜单栏图标文件。');
  const icon = platform === 'darwin' ? source.resize({width: 18, height: 18, quality: 'best'}) : source;
  if (platform === 'darwin') {
    icon.addRepresentation({scaleFactor: 2, dataURL: source.resize({width: 36, height: 36, quality: 'best'}).toDataURL()});
    icon.setTemplateImage(true);
  }
  return icon;
}

export function createDesktopTray(pngPath: string, show: () => void, quit: () => void, platform: NodeJS.Platform = process.platform): DesktopTray {
  const icon = trayImage(pngPath, platform);
  const tray = new Tray(icon);
  tray.setToolTip('Vonvon Bot');
  let announced: string | undefined;
  let notice: string | undefined;
  const buildMenu = (): void => {
    tray.setContextMenu(Menu.buildFromTemplate([
      ...(notice ? [{ label: notice, enabled: false }, { type: 'separator' as const }] : []),
      ...(announced ? [{ label: announced, click: show }, { type: 'separator' as const }] : []),
      { label: '打开 Vonvon Bot', click: show },
      { type: 'separator' },
      { label: '退出 Vonvon Bot', click: quit },
    ]));
  };
  buildMenu();
  // macOS opens the status menu on click; only its Open item should reveal the window.
  if (platform !== 'darwin') tray.on('click', show);
  return {
    destroy: () => tray.destroy(),
    setUpdate(update) {
      if (update === announced) return;
      announced = update;
      buildMenu();
      tray.setToolTip(update ? `Vonvon Bot · ${update}` : 'Vonvon Bot');
    },
    setNotice(text) {
      if (text === notice) return;
      notice = text;
      buildMenu();
    },
  };
}
