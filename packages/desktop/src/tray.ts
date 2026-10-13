import { Menu, nativeImage, Tray } from 'electron';

export function createDesktopTray(pngPath: string, show: () => void, quit: () => void): Tray {
  const icon = nativeImage.createFromPath(pngPath);
  if (icon.isEmpty()) throw new Error('Desktop tray icon is unavailable.');
  const tray = new Tray(icon);
  tray.setToolTip('Vonvon Bot');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Vonvon Bot', click: show },
    { type: 'separator' },
    { label: 'Quit Vonvon Bot', click: quit },
  ]));
  tray.on('click', show);
  return tray;
}
