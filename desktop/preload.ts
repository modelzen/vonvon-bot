import {contextBridge,ipcRenderer} from 'electron';
import type {Command,CommandReply,DesktopBridge,DesktopSnapshot} from './shared/bridge';
import type {SettingsReply,SettingsRequest} from './shared/settings';
import {watchSnapshots} from './shared/watch';

const bridge:DesktopBridge={
  collaboration: request => ipcRenderer.invoke('bridge:collaboration', request),
  environment: request => ipcRenderer.invoke('bridge:environment', request),
  machine: request => ipcRenderer.invoke('bridge:machine', request),
  onQuitRequested(listener) {
    const receive = () => listener();
    ipcRenderer.on('bridge:quitRequested', receive);
    return () => ipcRenderer.removeListener('bridge:quitRequested', receive);
  },
  watch(listener) {
    return watchSnapshots({listener,initial:()=>ipcRenderer.invoke('bridge:watch'),listen(receive){
      const onSnapshot=(_event:unknown,snapshot:DesktopSnapshot)=>receive(snapshot);
      ipcRenderer.on('bridge:snapshot',onSnapshot);
      return()=>ipcRenderer.removeListener('bridge:snapshot',onSnapshot);
    }});
  },
  async run(command:Command) {
    const reply:CommandReply=await ipcRenderer.invoke('bridge:run',command);
    if(reply.command!==command.type) return {kind:'refused',code:'mismatched-command',message:'应用返回了不匹配的操作结果。'};
    return reply.result;
  },
  async settings(request:SettingsRequest) {
    const reply:SettingsReply=await ipcRenderer.invoke('bridge:settings',request);
    return reply;
  },
};
contextBridge.exposeInMainWorld('bridge',bridge);
