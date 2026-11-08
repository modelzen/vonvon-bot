import { contextBridge, ipcRenderer } from 'electron';
import type { ShareCardBridge, ShareLayout } from '../../ui/src/client-context.js';
import { shareCardChannels } from './share-contract.js';
import { installShareClock } from './share-clock.js';

// now-share N5b: the offscreen share window. Its page gets the model and reports its layout here, and nothing else:
// no daemon client, no shell.
contextBridge.executeInMainWorld({ func: installShareClock });

function read(value: unknown): unknown {
  if (value && typeof value === 'object' && 'ok' in value && value.ok === true && 'value' in value) return value.value;
  throw new Error('分享图没能画出来。');
}

const bridge: ShareCardBridge = {
  model: () => ipcRenderer.invoke(shareCardChannels.model).then(read),
  async ready(layout: ShareLayout) {
    read(await ipcRenderer.invoke(shareCardChannels.ready, layout));
    // After the page's own continuation of this promise, which starts its clock, the first step may run.
    setTimeout(() => contextBridge.executeInMainWorld({
      func: () => { (window as unknown as { __vonvonShareClock?: { started(): void } }).__vonvonShareClock?.started(); },
    }), 0);
  },
};
contextBridge.exposeInMainWorld('vonvonShareCard', bridge);
