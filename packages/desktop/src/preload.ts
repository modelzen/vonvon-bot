import { contextBridge, ipcRenderer } from 'electron';
import { desktopChannels } from './ipc-contract.js';
import { createDesktopFacades } from './facade.js';

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
