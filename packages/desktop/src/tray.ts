import { Menu, nativeImage, Tray } from 'electron';

export function createDesktopTray(pngPath: string, show: () => void, quit: () => void, platform: NodeJS.Platform = process.platform): Tray {
  const source = nativeImage.createFromPath(pngPath);
  if (source.isEmpty()) throw new Error('Desktop tray icon is unavailable.');
  const icon = platform === 'darwin' ? source.resize({width: 18, height: 18, quality: 'best'}) : source;
  if (platform === 'darwin') {
    icon.addRepresentation({scaleFactor: 2, dataURL: source.resize({width: 36, height: 36, quality: 'best'}).toDataURL()});
    icon.setTemplateImage(true);
  }
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
