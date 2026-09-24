import {app,BrowserWindow,clipboard,dialog,ipcMain,Menu,nativeImage,shell,Tray} from 'electron';
import {homedir} from 'node:os';
import {join,dirname,delimiter} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stat} from 'node:fs/promises';
import {z} from 'zod';
import {commandSchema,type CommandReply,type CommandResult} from '../shared/bridge';
import {FolderCapabilities,trustedSender} from './capabilities';
import {DesktopController} from './controller';
import {messageOf} from './projection';
import type {HostModule} from './host';

const home=homedir();
if(process.env.VONVON_DESKTOP_TEST_HOME) {
  if(home!==process.env.VONVON_DESKTOP_TEST_HOME||process.env.USERPROFILE!==home||!process.env.CODEX_HOME?.startsWith(home)) throw new Error('Desktop test requires isolated HOME, USERPROFILE and CODEX_HOME.');
  app.setPath('userData',join(home,'electron-user-data'));
}
let window:BrowserWindow|undefined;
let tray:Tray|undefined;
let controller:DesktopController|undefined;
let allowQuit=false;
let quitPending=false;
const folders=new FolderCapabilities();
const documentPath=join(__dirname,'renderer','index.html');
const documentUrl=pathToFileURL(documentPath).href;
const lock=app.requestSingleInstanceLock();
if(!lock) app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.on('activate',()=>window?.show());
  app.on('window-all-closed',()=>undefined);
  app.on('before-quit',event=>{if(!allowQuit){event.preventDefault();void quit();}});
  void app.whenReady().then(start).catch(error=>{dialog.showErrorBox('Vonvon Bridge 启动失败',messageOf(error));allowQuit=true;app.quit();});
}
async function quit():Promise<void> {
  if(quitPending)return;
  quitPending=true;
  try {await controller?.quit();allowQuit=true;tray?.destroy();app.quit();}
  catch(error){window?.show();dialog.showErrorBox('退出未完成',messageOf(error));}
  finally{quitPending=false;}
}
function validateSender(event:Electron.IpcMainInvokeEvent):void {
  const valid=window&&trustedSender({id:event.sender.id,url:event.senderFrame?.url??'',isMainFrame:event.senderFrame===event.sender.mainFrame},{id:window.webContents.id,url:documentUrl});
  if(!valid)throw new Error('Untrusted IPC sender.');
}
async function start():Promise<void> {
  window=new BrowserWindow({width:1060,height:780,minWidth:720,minHeight:560,title:'Vonvon Bridge',backgroundColor:'#f7f7f8',titleBarStyle:process.platform==='darwin'?'hiddenInset':'default',webPreferences:{preload:join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
  const currentWindow=window;
  currentWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  currentWindow.webContents.on('will-navigate',event=>event.preventDefault());
  currentWindow.webContents.on('will-attach-webview',event=>event.preventDefault());
  currentWindow.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  currentWindow.webContents.session.setPermissionCheckHandler(()=>false);
  currentWindow.on('close',event=>{if(!allowQuit){event.preventDefault();currentWindow.hide();}});
  currentWindow.webContents.on('render-process-gone',()=>{folders.clear();void Promise.all(controller?.current().jobs.filter(job=>job.type!=='installCodex').map(job=>controller?.cancel(job.id))??[]);});
  ipcMain.handle('bridge:watch',event=>{validateSender(event);return controller?.current();});
  ipcMain.handle('bridge:run',async(event,value:unknown):Promise<CommandReply>=>{
    validateSender(event);
    if(JSON.stringify(value).length>16384)throw new Error('Command too large.');
    const command=commandSchema.parse(value);
    let result:CommandResult;
    try {
      if(!controller)throw new Error('Bridge 正在启动。');
      switch(command.type) {
        case 'chooseFolder': {
          const selected=await dialog.showOpenDialog(currentWindow,{title:'选择这个群的工作目录',properties:['openDirectory']});
          const path=selected.filePaths[0];
          result=selected.canceled||!path?{kind:'cancelled'}:{kind:'folderChosen',folder:await folders.grant(path,currentWindow.webContents.id)};
          break;
        }
        case 'openJobAuthorization':await shell.openExternal(controller.authorization(command.jobId));result={kind:'applied',revision:controller.current().revision};break;
        case 'copyJobAuthorization':clipboard.writeText(controller.authorization(command.jobId));result={kind:'applied',revision:controller.current().revision};break;
        case 'setLoginItem':
          if(process.env.VONVON_DESKTOP_TEST_HOME)throw new Error('隔离验证模式不修改登录启动项。');
          app.setLoginItemSettings({openAtLogin:command.enabled});controller.setLoginItem(app.getLoginItemSettings().openAtLogin);result={kind:'applied',revision:controller.current().revision};break;
        case 'hideWindow':currentWindow.hide();result={kind:'applied',revision:controller.current().revision};break;
        case 'quit':void quit();result={kind:'applied',revision:controller.current().revision};break;
        default:result=await controller.run(command,token=>folders.resolve(token,currentWindow.webContents.id));
      }
    } catch(error){result={kind:'refused',code:'operation-failed',message:messageOf(error)};}
    return {command:command.type,result};
  });
  const icon=nativeImage.createFromPath(join(__dirname,'renderer','vonvon-logo.png')).resize({width:18,height:18});
  icon.setTemplateImage(process.platform==='darwin');
  tray=new Tray(icon);
  tray.setToolTip('Vonvon Bridge');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'显示 Vonvon Bridge',click:()=>currentWindow.show()},{type:'separator'},{label:'退出 Vonvon Bridge',click:()=>void quit()}]));
  tray.on('click',()=>currentWindow.show());
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Vonvon Bridge',submenu:[{label:'显示窗口',click:()=>currentWindow.show()},{label:'隐藏窗口',accelerator:'CmdOrCtrl+W',click:()=>currentWindow.hide()},{type:'separator'},{label:'退出',accelerator:'CmdOrCtrl+Q',click:()=>void quit()}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'窗口',submenu:[{role:'minimize'},{role:'zoom'}]}]));
  const target=process.platform==='darwin'?'mac-arm64':'win-x64';
  const runtime=app.isPackaged?join(process.resourcesPath,'runtime'):join(__dirname,'..','build','runtime',target);
  const nodePath=join(runtime,'node',process.platform==='win32'?'node.exe':'bin/node');
  const npmPath=join(runtime,'node',process.platform==='win32'?'node_modules/npm/bin/npm-cli.js':'lib/node_modules/npm/bin/npm-cli.js');
  const coreRoot=join(runtime,'core');
  const coreHost=join(coreRoot,'dist','host.js');
  const cliPath=join(coreRoot,'bin','feishu-codex-bridge.mjs');
  const application={platform:process.platform==='darwin'?'macos':process.platform==='win32'?'windows':'unsupported',version:app.getVersion(),loginItem:app.getLoginItemSettings().openAtLogin,dataPath:join(home,'.vonvon-bridge')} as const;
  try {
    await Promise.all([nodePath,npmPath,coreHost,cliPath].map(path=>stat(path)));
    process.env.PATH=`${dirname(nodePath)}${delimiter}${process.env.PATH??''}`;
    process.env.VONVON_NPM_CLI=npmPath;
    const imported:unknown=await import(pathToFileURL(coreHost).href);
    const module=z.object({inspectHost:z.function(),connectHost:z.function(),migrateHostDataOffline:z.function()}).parse(imported) as HostModule;
    controller=new DesktopController(module,{home,nodePath,cliPath},application);
  } catch(error) {
    const blocked:HostModule={inspectHost:async()=>({kind:'blocked',reason:'startup-failed',message:`打包运行时不可用。${messageOf(error)}`}),connectHost:async()=>({kind:'blocked',reason:'startup-failed',message:'打包运行时不可用。'}),migrateHostDataOffline:async()=>({kind:'recovery-required',message:'打包运行时不可用。'})};
    controller=new DesktopController(blocked,{home,nodePath,cliPath},application);
  }
  controller.subscribe(snapshot=>{if(!currentWindow.isDestroyed())currentWindow.webContents.send('bridge:snapshot',snapshot);});
  await currentWindow.loadFile(documentPath);
  await controller.start();
}
