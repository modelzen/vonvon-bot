import {createHash,generateKeyPairSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createRequire} from 'node:module';
import {afterEach,expect,it,vi} from 'vitest';
import {WindowsDesktopUpdater,createWindowsUpdateDriver,windowsUpdateConfiguration,verifyWindowsInstaller,allowedWindowsUpdateRequest,type WindowsUpdateDriver} from '../src/windows-updates.js';
import {signWindowsUpdate,type WindowsUpdateManifest} from '../src/windows-update-manifest.mjs';

const keys=generateKeyPairSync('ed25519');
const publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString(),privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
const bytes=Buffer.from('fixture installer'),roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function manifest(version='1.1.0',architecture:'x64'|'arm64'='x64'):WindowsUpdateManifest{return {schemaVersion:1,product:'vonvon-bot',version,architecture,url:`https://dl.vonvon.cc/bot/windows/${version}/Vonvon-Bot-Setup-${version}-${architecture}.exe`,size:bytes.length,sha512:createHash('sha512').update(bytes).digest('base64'),notes:'改进 Windows 升级'};}
function info(payload:WindowsUpdateManifest){return {version:payload.version,files:[{url:payload.url,sha512:payload.sha512,size:payload.size}],signedUpdate:signWindowsUpdate(payload,privateKey)};}
class Driver extends EventEmitter {
  autoDownload=true;autoInstallOnAppQuit=true;allowPrerelease=true;disableWebInstaller=false;
  checkForUpdates=vi.fn<WindowsUpdateDriver['checkForUpdates']>();
  downloadUpdate=vi.fn<WindowsUpdateDriver['downloadUpdate']>();
  quitAndInstall=vi.fn();
}
function fixture(trusted=true){
  const driver=new Driver(),verify=vi.fn(verifyWindowsInstaller),beforeInstall=vi.fn(async()=>{}),onUpdate=vi.fn();
  const root=mkdtempSync(join(tmpdir(),'windows-update-'));roots.push(root);
  const statePath=join(root,'expected'),file=join(root,'app.exe'),payload=manifest();writeFileSync(file,bytes);
  driver.checkForUpdates.mockResolvedValue({isUpdateAvailable:true,updateInfo:info(payload)});driver.downloadUpdate.mockResolvedValue([file]);
  const updater=new WindowsDesktopUpdater({current:'1.0.0',publicKey:trusted?publicKey:undefined,architecture:'x64',driver,verify,beforeInstall,statePath,onUpdate});
  return {driver,verify,beforeInstall,onUpdate,updater,statePath,root,file,payload};
}
it('passes the running installation directory last to the real NSIS driver, including spaces and Unicode',()=>{
  const require=createRequire(import.meta.url),adapter=require('electron-updater/out/ElectronAppAdapter.js'),{AppUpdater}=require('electron-updater/out/AppUpdater.js');
  vi.spyOn(adapter,'ElectronAppAdapter').mockImplementation(function(){return {version:'0.7.8'};});
  vi.spyOn(AppUpdater.prototype,'netSession','get').mockReturnValue({webRequest:{onBeforeRequest:vi.fn()}});
  const h=fixture(),executable=join(h.root,'自选 安装路径','Vonvon Bot.exe'),original=Object.getOwnPropertyDescriptor(process,'execPath')!;
  Object.defineProperty(process,'execPath',{...original,value:executable});
  try {
    const driver=createWindowsUpdateDriver(publicKey,'arm64');
    const native=driver as unknown as {spawnLog:(command:string,args:string[])=>Promise<boolean>;doInstall:(options:{isSilent:boolean;isForceRunAfter:boolean;isAdminRightsRequired:boolean})=>boolean};
    Object.defineProperty(driver,'installerPath',{value:h.file});const spawn=vi.spyOn(native,'spawnLog').mockResolvedValue(true);
    expect(driver.installDirectory).toBe(dirname(executable));
    expect(native.doInstall({isSilent:false,isForceRunAfter:true,isAdminRightsRequired:false})).toBe(true);
    expect(spawn).toHaveBeenCalledWith(h.file,['--updated','--force-run',`/D=${dirname(executable)}`]);
  }finally{Object.defineProperty(process,'execPath',original);}
});
it('requires an embedded update key before contacting the server, without requiring Authenticode',async()=>{
  const h=fixture(false);expect(h.updater.enabled).toBe(false);expect(await h.updater.check()).toMatchObject({state:'unavailable'});expect(h.driver.checkForUpdates).not.toHaveBeenCalled();
  expect(fixture().updater.enabled).toBe(true);
});
it('blocks foreign origins, HTTP and paths outside the Windows release area, including redirect targets',()=>{
  expect(allowedWindowsUpdateRequest('https://dl.vonvon.cc/bot/windows/stable/x64/update.json?noCache=1')).toBe(true);
  for(const url of ['http://dl.vonvon.cc/bot/windows/stable/update.json','https://evil.example/file.exe','https://dl.vonvon.cc/bot/mac/file.exe'])expect(allowedWindowsUpdateRequest(url)).toBe(false);
});
it('checks without downloading, verifies the final EXE, then installs only after another click',async()=>{
  const h=fixture();expect(h.driver.autoDownload).toBe(false);expect(h.driver.autoInstallOnAppQuit).toBe(false);expect(h.driver.disableWebInstaller).toBe(true);
  expect(await h.updater.check()).toMatchObject({state:'available',latest:'1.1.0',releaseNotes:h.payload.notes});expect(h.driver.downloadUpdate).not.toHaveBeenCalled();
  expect(await h.updater.install()).toMatchObject({state:'downloaded'});expect(h.beforeInstall).not.toHaveBeenCalled();expect(h.driver.quitAndInstall).not.toHaveBeenCalled();
  await h.updater.install();expect(h.verify).toHaveBeenCalledTimes(2);expect(h.beforeInstall).toHaveBeenCalledTimes(1);expect(h.driver.quitAndInstall).toHaveBeenCalledWith(false,true);expect(readFileSync(h.statePath,'utf8')).toBe('1.1.0');
});
it.each(['missing','tampered','architecture'] as const)('rejects %s manifest trust before downloading',async kind=>{
  const h=fixture(),value=info(kind==='architecture'?manifest('1.1.0','arm64'):h.payload);
  if(kind==='missing')value.signedUpdate=undefined as never;
  if(kind==='tampered')value.signedUpdate.payload=Buffer.from(JSON.stringify({...h.payload,version:'9.0.0'})).toString('base64');
  h.driver.checkForUpdates.mockResolvedValue({isUpdateAvailable:true,updateInfo:value});
  await expect(h.updater.check()).rejects.toThrow('检查桌面更新失败');await expect(h.updater.install()).rejects.toThrow('请先检查');expect(h.driver.downloadUpdate).not.toHaveBeenCalled();
});
it.each(['url','sha512','size','version','extra-file','packages'] as const)('rejects %s substitution outside signed metadata and invalidates the preceding check',async field=>{
  const h=fixture();await h.updater.check();const value:ReturnType<typeof info>&{packages?:unknown}=info(h.payload);
  if(field==='url')value.files[0]!.url='https://evil.example/app.exe';
  if(field==='sha512')value.files[0]!.sha512=createHash('sha512').update('other').digest('base64');
  if(field==='size')value.files[0]!.size++;
  if(field==='version')value.version='1.2.0';
  if(field==='extra-file')value.files.push({...value.files[0]!});
  if(field==='packages')value.packages={x64:{path:'payload.7z'}};
  h.driver.checkForUpdates.mockResolvedValue({isUpdateAvailable:true,updateInfo:value});
  await expect(h.updater.check()).rejects.toThrow('检查桌面更新失败');await expect(h.updater.install()).rejects.toThrow('请先检查');expect(h.driver.downloadUpdate).not.toHaveBeenCalled();
});
it('rejects changed downloaded bytes using the signed hash before shutdown',async()=>{
  const h=fixture();await h.updater.check();writeFileSync(h.file,Buffer.alloc(bytes.length,0));
  await expect(h.updater.install()).rejects.toThrow('签名校验失败');expect(h.beforeInstall).not.toHaveBeenCalled();expect(h.driver.quitAndInstall).not.toHaveBeenCalled();
  expect(await verifyWindowsInstaller(h.file,h.payload)).toBe(false);
});
it('rechecks the downloaded EXE immediately before shutdown and rejects same-size cache tampering',async()=>{
  const h=fixture();await h.updater.check();await h.updater.install();writeFileSync(h.file,Buffer.alloc(bytes.length,1));
  await expect(h.updater.install()).rejects.toThrow('签名校验');expect(h.beforeInstall).not.toHaveBeenCalled();expect(h.driver.quitAndInstall).not.toHaveBeenCalled();
});
it('verifies installer size and rejects missing paths or directories',async()=>{
  const h=fixture();expect(await verifyWindowsInstaller(h.file,h.payload)).toBe(true);
  expect(await verifyWindowsInstaller(h.file,{...h.payload,size:bytes.length+1})).toBe(false);
  expect(await verifyWindowsInstaller(join(h.root,'missing.exe'),h.payload)).toBe(false);expect(await verifyWindowsInstaller(h.root,h.payload)).toBe(false);
});
it('honors native rollout and OS eligibility, invalidating an older available check',async()=>{
  const h=fixture();await h.updater.check();h.driver.checkForUpdates.mockResolvedValue({isUpdateAvailable:false,updateInfo:{version:'1.2.0',files:[]}});
  expect(await h.updater.check()).toMatchObject({state:'current'});await expect(h.updater.install()).rejects.toThrow('请先检查');expect(h.driver.downloadUpdate).not.toHaveBeenCalled();
});
it('shares concurrent checks and downloads, emitting only measured in-flight progress',async()=>{
  const h=fixture();await Promise.all([h.updater.check(),h.updater.check()]);expect(h.driver.checkForUpdates).toHaveBeenCalledTimes(1);
  let finish!:(paths:string[])=>void;h.driver.downloadUpdate.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const a=h.updater.install(),b=h.updater.install();h.driver.emit('download-progress',{percent:37.5,transferred:375,total:1000});
  expect(h.onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({state:'available',downloadProgress:{percent:37.5,transferred:375,total:1000}}));
  h.driver.emit('download-progress',{percent:NaN,transferred:1,total:1000});expect(h.onUpdate).toHaveBeenCalledTimes(1);
  expect(h.updater.busy).toBe(true);expect(h.driver.downloadUpdate).toHaveBeenCalledTimes(1);finish([h.file]);await Promise.all([a,b]);
  expect((await h.updater.check()).downloadProgress).toBeUndefined();h.driver.emit('download-progress',{percent:100,transferred:1000,total:1000});expect(h.onUpdate).toHaveBeenCalledTimes(1);
});
it('installs once when the user clicks again while shutdown is pending',async()=>{
  const h=fixture();await h.updater.check();await h.updater.install();let finish!:()=>void;h.beforeInstall.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const first=h.updater.install(),second=h.updater.install();await vi.waitFor(()=>expect(h.beforeInstall).toHaveBeenCalledTimes(1));expect(h.updater.busy).toBe(true);finish();await Promise.all([first,second]);expect(h.driver.quitAndInstall).toHaveBeenCalledTimes(1);
});
it('reports an install that did not take effect and allows a retry',async()=>{
  const h=fixture();writeFileSync(h.statePath,'1.1.0');expect(await h.updater.check()).toMatchObject({state:'install-pending'});expect(await h.updater.retry()).toMatchObject({state:'available'});
});
it('keeps a failed installation visible when the update server is unreachable',async()=>{
  const h=fixture();writeFileSync(h.statePath,'1.1.0');h.driver.checkForUpdates.mockRejectedValue(new Error('offline'));expect(await h.updater.check()).toMatchObject({state:'install-pending',latest:'1.1.0'});
});
it('enables only a packaged configuration containing one valid Ed25519 public key',async()=>{
  const h=fixture();mkdirSync(join(h.root,'dist'));const path=join(h.root,'dist','windows-update-config.json');
  writeFileSync(path,JSON.stringify({publicKey}));expect(await windowsUpdateConfiguration({appPath:h.root,isPackaged:true})).toEqual({publicKey});
  expect(await windowsUpdateConfiguration({appPath:h.root,isPackaged:false})).toEqual({});
  for(const config of [{publicKey:'invalid'},{publicKey,publisherName:'Legacy'},{}]){writeFileSync(path,JSON.stringify(config));expect(await windowsUpdateConfiguration({appPath:h.root,isPackaged:true})).toEqual({});}
});
