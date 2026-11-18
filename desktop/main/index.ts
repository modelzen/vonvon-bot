import {app,autoUpdater,BrowserWindow,clipboard,dialog,ipcMain,Menu,nativeImage,shell,Tray} from 'electron';
import {homedir} from 'node:os';
import {join,dirname,delimiter} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stat} from 'node:fs/promises';
import {z} from 'zod';
import {commandSchema,type CommandReply,type CommandResult} from '../shared/bridge';
import {settingsRequestSchema,type SettingsReply} from '../shared/settings';
import {ExecutableCapabilities,FolderCapabilities,trustedSender} from './capabilities';
import {DesktopController} from './controller';
import {messageOf} from './projection';
import type {HostModule} from './host';
import {MachineService} from './machine';
import {DesktopUpdater} from './updates';
import {desktopUpdateConfiguration} from './update-configuration';
import {machineRequestSchema} from '../shared/machine';
import {createCollaborationService} from './collaboration';
import {collaborationRequestSchema} from '../shared/collaboration';
import {EnvironmentService} from './environment';
import {environmentRequestSchema} from '../shared/environment';
import {registerCli,type Registration} from './cli-registration';

const home=homedir();
if(process.env.VONVON_DESKTOP_TEST_HOME) {
  if(home!==process.env.VONVON_DESKTOP_TEST_HOME||process.env.USERPROFILE!==home||!process.env.CODEX_HOME?.startsWith(home)) throw new Error('Desktop test requires isolated HOME, USERPROFILE and CODEX_HOME.');
  app.setPath('userData',join(home,'electron-user-data'));
}
let window:BrowserWindow|undefined;
let tray:Tray|undefined;
let controller:DesktopController|undefined;
let machine:MachineService|undefined;
let collaboration: ReturnType<typeof createCollaborationService> | undefined;
let environment: EnvironmentService | undefined;
let allowQuit=false;
let quitPending=false;
let cliRegistration:Registration={kind:'error',message:'尚未检查命令行工具。'};
const folders=new FolderCapabilities();
const executables=new ExecutableCapabilities();
const documentPath=join(__dirname,'renderer','index.html');
const documentUrl=pathToFileURL(documentPath).href;
const lock=app.requestSingleInstanceLock();
if(!lock) app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.on('activate',()=>window?.show());
  app.on('window-all-closed',()=>undefined);
  app.on('before-quit',event=>{if(!allowQuit){event.preventDefault();requestQuit();}});
  void app.whenReady().then(start).catch(error=>{dialog.showErrorBox('Vonvon Bot 启动失败',messageOf(error));allowQuit=true;app.quit();});
}
function requestQuit(): void {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed() && !window.webContents.isLoadingMainFrame()) {
    window.show();
    window.webContents.send('bridge:quitRequested');
  } else void quit();
}
async function quit():Promise<void> {
  if(quitPending)return;
  quitPending=true;
  try {await machine?.close();await environment?.close();await controller?.quit();allowQuit=true;tray?.destroy();app.quit();}
  catch(error){window?.show();dialog.showErrorBox('退出未完成',messageOf(error));}
  finally{quitPending=false;}
}
function validateSender(event:Electron.IpcMainInvokeEvent):void {
  const valid=window&&trustedSender({id:event.sender.id,url:event.senderFrame?.url??'',isMainFrame:event.senderFrame===event.sender.mainFrame},{id:window.webContents.id,url:documentUrl});
  if(!valid)throw new Error('Untrusted IPC sender.');
}
async function start():Promise<void> {
  window=new BrowserWindow({width:1060,height:780,minWidth:720,minHeight:560,title:'Vonvon Bot',backgroundColor:'#f7f7f8',titleBarStyle:process.platform==='darwin'?'hiddenInset':'default',webPreferences:{preload:join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
  const currentWindow=window;
  currentWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  currentWindow.webContents.on('will-navigate',event=>event.preventDefault());
  currentWindow.webContents.on('will-attach-webview',event=>event.preventDefault());
  currentWindow.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  currentWindow.webContents.session.setPermissionCheckHandler(()=>false);
  currentWindow.on('close',event=>{if(!allowQuit){event.preventDefault();currentWindow.hide();}});
  currentWindow.webContents.on('render-process-gone',()=>{folders.clear();executables.clear();void Promise.all(controller?.current().jobs.filter(job=>job.type!=='installCodex').map(job=>controller?.cancel(job.id))??[]);});
  ipcMain.handle('bridge:watch',event=>{validateSender(event);return controller?.current();});
  ipcMain.handle('bridge:machine', async (event, value: unknown) => {
    validateSender(event);
    if (JSON.stringify(value).length > 16384) throw new Error('Request too large.');
    if (!machine) throw new Error('本机服务尚未就绪。');
    return machine.request(machineRequestSchema.parse(value));
  });
  ipcMain.handle('bridge:collaboration', async (event, value: unknown) => {
    validateSender(event);
    if (JSON.stringify(value).length > 16384) throw new Error('Request too large.');
    if (!collaboration) throw new Error('Bridge 正在启动。');
    return collaboration(collaborationRequestSchema.parse(value));
  });
  ipcMain.handle('bridge:environment', async (event, value: unknown) => {
    validateSender(event);
    if (JSON.stringify(value).length > 16384) throw new Error('Request too large.');
    if (!environment) throw new Error('本机环境尚未就绪。');
    const request = environmentRequestSchema.safeParse(value);
    if (!request.success) throw new Error('本机环境请求无效。');
    return environment.run(request.data);
  });
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
        case 'openEventSettings':await shell.openExternal(command.url);result={kind:'applied',revision:controller.current().revision};break;
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
  ipcMain.handle(
    "bridge:settings",
    async (event, value: unknown): Promise<SettingsReply> => {
      validateSender(event);
      if (JSON.stringify(value).length > 256_000)
        return {
          kind: "refused",
          code: "request-too-large",
          message: "设置内容超过支持的大小。",
        };
      const parsed = settingsRequestSchema.safeParse(value);
      if (!parsed.success)
        return {
          kind: "refused",
          code: "invalid-request",
          message: "设置请求无效，请检查输入。",
        };
      if (!controller)
        return {
          kind: "refused",
          code: "not-ready",
          message: "Bridge 正在启动。",
        };
      try {
        if (parsed.data.type === "chooseExecutable") {
          const chosen = await dialog.showOpenDialog(currentWindow, {
            title: "选择 Codex 可执行文件",
            properties: ["openFile"],
          });
          const path = chosen.filePaths[0];
          return chosen.canceled || !path
            ? { kind: "cancelled" }
            : {
                kind: "fileChosen",
                file: await executables.grant(
                  path,
                  currentWindow.webContents.id,
                ),
              };
        }
        if (parsed.data.type === "saveExecutable") {
          const path = await executables.resolve(
            parsed.data.token,
            currentWindow.webContents.id,
          );
          return controller.saveExecutable(path, parsed.data.revision);
        }
        return controller.settings(parsed.data);
      } catch (error) {
        return {
          kind: "refused",
          code: "settings-failed",
          message: messageOf(error),
        };
      }
    },
  );
  let trayIcon: Electron.NativeImage|string=join(__dirname,'renderer','vonvon-tray.ico');
  if(process.platform==='darwin') {
    const source=nativeImage.createFromPath(join(__dirname,'renderer','vonvon-tray.png'));
    const icon=source.resize({width:18,height:18});
    icon.addRepresentation({scaleFactor:2,width:36,height:36,buffer:source.resize({width:36,height:36}).toPNG()});
    icon.setTemplateImage(false);
    trayIcon=icon;
  }
  tray=new Tray(trayIcon);
  tray.setToolTip('Vonvon Bot');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'显示 Vonvon Bot',click:()=>currentWindow.show()},{type:'separator'},{label:'退出 Vonvon Bot',click:()=>requestQuit()}]));
  tray.on('click',()=>currentWindow.show());
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Vonvon Bot',submenu:[{label:'显示窗口',click:()=>currentWindow.show()},{label:'隐藏窗口',accelerator:'CmdOrCtrl+W',click:()=>currentWindow.hide()},{type:'separator'},{label:'退出',accelerator:'CmdOrCtrl+Q',click:()=>requestQuit()}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'窗口',submenu:[{role:'minimize'},{role:'zoom'}]}]));
  const target=process.platform==='darwin'?'mac-arm64':'win-x64';
  const runtime=app.isPackaged?join(process.resourcesPath,'runtime'):join(__dirname,'..','build','runtime',target);
  const nodePath=join(runtime,'node',process.platform==='win32'?'node.exe':'bin/node');
  const npmPath=join(runtime,'node',process.platform==='win32'?'node_modules/npm/bin/npm-cli.js':'lib/node_modules/npm/bin/npm-cli.js');
  const coreRoot=join(runtime,'core');
  const coreHost=join(coreRoot,'dist','host.js');
  const cliPath=join(coreRoot,'bin','feishu-codex-bridge.mjs');
  const repairCli=async ():Promise<Registration> => {
    if (!app.isPackaged || process.env.VONVON_DESKTOP_TEST_HOME) {
      cliRegistration={kind:'error',message:'开发或隔离验证模式不会修改本机 PATH。'};
      return cliRegistration;
    }
    cliRegistration=await registerCli({platform:process.platform==='win32'?'win32':'darwin',scope:'user',runtime,home});
    return cliRegistration;
  };
  await repairCli();
  const application={platform:process.platform==='darwin'?'macos':process.platform==='win32'?'windows':'unsupported',version:app.getVersion(),loginItem:app.getLoginItemSettings().openAtLogin,dataPath:'尚未确认'} as const;
  let coreResolution: {resolveDataRoot: (home: string) => {path: string}; resolveCodexBin: (options: {force: boolean; home: string; dataRoot: string; env: NodeJS.ProcessEnv}) => Promise<string | null>} | undefined;
  try {
    await Promise.all([nodePath,npmPath,coreHost,cliPath].map(path=>stat(path)));
    process.env.PATH=`${dirname(nodePath)}${delimiter}${process.env.PATH??''}`;
    process.env.VONVON_NPM_CLI=npmPath;
    const imported:unknown=await import(pathToFileURL(coreHost).href);
    const module=z.object({inspectHost:z.function(),connectHost:z.function(),migrateHostDataOffline:z.function()}).parse(imported) as HostModule;
    coreResolution = z.object({resolveDataRoot: z.function(), resolveCodexBin: z.function()}).parse(imported) as typeof coreResolution;
    controller=new DesktopController(module,{home,nodePath,cliPath},application);
  } catch(error) {
    const blocked:HostModule={inspectHost:async()=>({kind:'blocked',reason:'startup-failed',message:`打包运行时不可用。${messageOf(error)}`}),connectHost:async()=>({kind:'blocked',reason:'startup-failed',message:'打包运行时不可用。'}),migrateHostDataOffline:async()=>({kind:'recovery-required',message:'打包运行时不可用。'})};
    controller=new DesktopController(blocked,{home,nodePath,cliPath},application);
  }
  controller.subscribe(snapshot=>{if(!currentWindow.isDestroyed())currentWindow.webContents.send('bridge:snapshot',snapshot);});
  const activeController = controller;
  collaboration = createCollaborationService({
    host: () => {
      const host = activeController.currentHost();
      if (!host) throw new Error('Bridge 已停止。');
      return {...host, request: (path, init) => activeController.requestManagement(path, init)};
    },
    snapshot: () => activeController.current(),
    resolveFolder: token => folders.resolve(token, currentWindow.webContents.id),
    openExternal: url => shell.openExternal(url),
  });
  const getDataRoot = () => {
    if (!coreResolution) throw new Error('打包内核尚未就绪。');
    const reported = activeController.current().application.dataPath;
    return reported.startsWith('/') || /^[A-Za-z]:[\\/]/.test(reported) ? reported : coreResolution.resolveDataRoot(home).path;
  };
  environment = new EnvironmentService({home, nodePath, npmPath, getDataRoot,
    resolveCodex: async () => {
      if (activeController.currentHost()) {
        const response = await activeController.requestManagement('/api/tools/codex/setup');
        if (!response.ok) throw new Error('无法确认 Bridge 当前使用的 Codex。');
        const setup = z.object({executable: z.string().nullable().optional(), message: z.string().optional()}).parse(await response.json());
        if (setup.executable !== undefined) return setup.executable;
        const legacyPath = setup.message?.match(/^(?:当前 Codex：|无法确认当前 Codex 的账户状态：)(.+)$/)?.[1];
        if (legacyPath) return legacyPath;
        throw new Error('当前 Bridge 不支持检查工具路径，请更新内核并重启。');
      }
      return coreResolution?.resolveCodexBin({force: true, home, dataRoot: getDataRoot(), env: process.env}) ?? null;
    },
    hostRequest: (path, init) => activeController.requestManagement(path, init),
    openExternal: url => shell.openExternal(url),
  });
  const updateConfiguration = await desktopUpdateConfiguration({appPath: app.getAppPath(), isPackaged: app.isPackaged});
  machine = new MachineService({
    cliRegistration:()=>cliRegistration,
    repairCli,
    runtime: {home, nodePath, cliPath},
    host: () => activeController.currentHost(),
    stopHost: () => activeController.stop(),
    startHost: async bot => {
      await activeController.start(bot);
      const state = activeController.current().host;
      if (state.kind !== 'connected') throw new Error(state.kind === 'starting' ? 'Bridge 尚未完成启动。' : state.message);
    },
    openReleases: () => shell.openExternal('https://github.com/modelzen/vonvon-bot/releases'),
    updater: new DesktopUpdater({current: app.getVersion(), ...updateConfiguration, driver: autoUpdater,
      statePath: join(app.getPath('userData'), 'desktop-update-expected-version'),
      beforeInstall: async () => {machine?.beginClosing();await environment?.close();await activeController.quit(); allowQuit = true;},
    }),
  });
  await currentWindow.loadFile(documentPath);
  await controller.start();
}
