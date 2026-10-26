import { Menu, nativeImage, Tray } from 'electron';

export interface DesktopTray {
  destroy(): void;
  /** 有更新提示时（"有新版本 x.y.z"、"上次更新没装上"）在菜单最上面加一项，点它打开窗口；传 undefined 去掉。菜单栏图标本身不变。 */
  setUpdate(notice: string | undefined): void;
}

export function createDesktopTray(pngPath: string, show: () => void, quit: () => void, platform: NodeJS.Platform = process.platform): DesktopTray {
  const source = nativeImage.createFromPath(pngPath);
  if (source.isEmpty()) throw new Error('找不到菜单栏图标文件。');
  const icon = platform === 'darwin' ? source.resize({width: 18, height: 18, quality: 'best'}) : source;
  if (platform === 'darwin') {
    icon.addRepresentation({scaleFactor: 2, dataURL: source.resize({width: 36, height: 36, quality: 'best'}).toDataURL()});
    icon.setTemplateImage(true);
  }
  const tray = new Tray(icon);
  tray.setToolTip('Vonvon Bot');
  let announced: string | undefined;
  const buildMenu = (): void => {
    tray.setContextMenu(Menu.buildFromTemplate([
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
    setUpdate(notice) {
      if (notice === announced) return;
      announced = notice;
      buildMenu();
      tray.setToolTip(notice ? `Vonvon Bot · ${notice}` : 'Vonvon Bot');
    },
  };
}
