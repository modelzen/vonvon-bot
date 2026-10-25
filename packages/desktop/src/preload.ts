import { contextBridge, ipcRenderer } from 'electron';
import { desktopChannels, desktopFullScreenChannel } from './ipc-contract.js';
import { createDesktopFacades } from './facade.js';

let fullScreen = false;
function updateWindowChrome(): void {
  if (!document.documentElement) return;
  document.documentElement.dataset.desktopChrome = 'silver';
  document.documentElement.dataset.desktopFullscreen = String(fullScreen);
}
ipcRenderer.on(desktopFullScreenChannel, (_event, value: unknown) => {
  if (typeof value !== 'boolean') return;
  fullScreen = value;
  updateWindowChrome();
});
document.addEventListener('readystatechange', updateWindowChrome);
window.addEventListener('DOMContentLoaded', updateWindowChrome, { once: true });
updateWindowChrome();

const { client, shell } = createDesktopFacades({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  receive(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(value);
    ipcRenderer.on(desktopChannels.event, handler);
    return () => ipcRenderer.removeListener(desktopChannels.event, handler);
  },
});

contextBridge.exposeInMainWorld('vonvonClient', client);
contextBridge.exposeInMainWorld('vonvonShell', shell);
