import {createHash,generateKeyPairSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createRequire} from 'node:module';
import {Agent,createServer,request,type IncomingMessage,type RequestOptions,type Server} from 'node:http';
import {gzipSync} from 'node:zlib';
import {CURRENT_APP_INSTALLER_FILE_NAME} from 'builder-util-runtime';
import type {ProviderRuntimeOptions} from 'electron-updater/out/providers/Provider.js';
import type {AppAdapter} from 'electron-updater/out/AppAdapter.js';
import {ElectronHttpExecutor} from 'electron-updater/out/electronHttpExecutor.js';
import {afterEach,expect,it,vi} from 'vitest';
import {WindowsDesktopUpdater,createWindowsUpdateDriver,windowsUpdateConfiguration,verifyWindowsInstaller,allowedWindowsUpdateRequest,type WindowsUpdateDriver} from '../src/windows-updates.js';
import {signWindowsUpdate,type WindowsUpdateManifest} from '../src/windows-update-manifest.mjs';

const keys=generateKeyPairSync('ed25519');
const publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString(),privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
const bytes=Buffer.from('fixture installer'),roots:string[]=[];
const servers:Server[]=[];
afterEach(async()=>{
  for(const server of servers.splice(0))await new Promise<void>((resolve,reject)=>{
    server.close(error=>error?reject(error):resolve());server.closeAllConnections();
  });
  vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});
});
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

// Keep these cases in the Windows CI/release regression file. Only the Electron
// app/session and socket transport are adapted: the signed Provider, NSIS driver,
// cache discovery, blockmap planner, differential/full download and hashes are real.
const blockSize=4096;
const oldChunks=Array.from({length:10},(_,i)=>Buffer.alloc(blockSize,i+1));
const newChunks=oldChunks.map((chunk,i)=>[1,5,9].includes(i)?Buffer.alloc(blockSize,i+101):chunk);
const oldInstaller=Buffer.concat(oldChunks),newInstaller=Buffer.concat(newChunks);
function blockmap(chunks:Buffer[]):Buffer {
  return gzipSync(JSON.stringify({version:'2',files:[{name:'file',offset:0,
    checksums:chunks.map(chunk=>createHash('sha256').update(chunk).digest('base64')),
    sizes:chunks.map(chunk=>chunk.length)}]}));
}
type HttpRecord={path:string;range?:string;status:number;bytes:number;contentRange?:string};
async function differentialFixture(options:{architecture?:'x64'|'arm64';missingCache?:boolean;cachedBlockmap?:boolean;failRange?:boolean;corruptRange?:boolean;corruptFull?:boolean;signedSize?:number}={}) {
  const architecture=options.architecture??'x64';
  const root=mkdtempSync(join(tmpdir(),'windows-differential-'));roots.push(root);
  const cache=join(root,'cache','fixture-updater');mkdirSync(cache,{recursive:true});
  if(!options.missingCache)writeFileSync(join(cache,CURRENT_APP_INSTALLER_FILE_NAME),oldInstaller);
  if(options.cachedBlockmap)writeFileSync(join(cache,'current.blockmap'),blockmap(oldChunks));
  const configPath=join(root,'app-update.yml');writeFileSync(configPath,'updaterCacheDirName: fixture-updater\n');
  const payload={...manifest('1.1.0',architecture),size:options.signedSize??newInstaller.length,
    sha512:createHash('sha512').update(newInstaller).digest('base64')};
  const installerPath=new URL(payload.url).pathname;
  const oldMapPath=installerPath.replaceAll('1.1.0','1.0.0')+'.blockmap';
  const requests:HttpRecord[]=[];
  // Electron net owns a persistent network session. Reuse the Node fixture's
  // connection too, keeping fresh socket fd allocation out of the downloader's
  // asynchronous file cleanup when differential download falls back to full.
  const agent=new Agent({keepAlive:true,maxSockets:1});
  const server=createServer((req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname;
    // Copy the primitive Range value now; the downloader reuses its headers object.
    const range=req.headers.range;
    const send=(status:number,body:Buffer,contentRange?:string)=>{
      requests.push({path,range,status,bytes:body.length,contentRange});
      res.writeHead(status,{'Content-Length':body.length,'Accept-Ranges':'bytes',...(contentRange?{'Content-Range':contentRange}:{})});res.end(body);
    };
    if(path===`/bot/windows/stable/${architecture}/update.json`)return send(200,Buffer.from(JSON.stringify(signWindowsUpdate(payload,privateKey))));
    if(path===oldMapPath)return send(200,blockmap(oldChunks));
    if(path===installerPath+'.blockmap')return send(200,blockmap(newChunks));
    if(path!==installerPath)return send(404,Buffer.alloc(0));
    if(!range)return send(200,options.corruptFull?Buffer.alloc(newInstaller.length):newInstaller);
    const match=/^bytes=(\d+)-(\d+)$/.exec(range);
    // Deliberately reject multipart Range; full GET remains available for fallback.
    if(options.failRange||!match)return send(416,Buffer.alloc(0));
    const start=Number(match[1]),end=Number(match[2]);
    if(start>end||end>=newInstaller.length)return send(416,Buffer.alloc(0));
    const body=newInstaller.subarray(start,end+1);
    return send(206,options.corruptRange?Buffer.alloc(body.length):body,`bytes ${start}-${end}/${newInstaller.length}`);
  });
  servers.push(server);
  server.on('close',()=>agent.destroy());
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('Missing fixture server address');
  const require=createRequire(import.meta.url),adapter=require('electron-updater/out/ElectronAppAdapter.js'),{AppUpdater}=require('electron-updater/out/AppUpdater.js');
  const app:AppAdapter={version:'1.0.0',name:'fixture',isPackaged:true,appUpdateConfigPath:configPath,
    userDataPath:join(root,'userData'),baseCachePath:join(root,'cache'),whenReady:async()=>{},relaunch:vi.fn(),quit:vi.fn(),onQuit:vi.fn()};
  vi.spyOn(adapter,'ElectronAppAdapter').mockImplementation(function(){return app;});
  let guard:((details:{url:string},callback:(result:{cancel:boolean})=>void)=>void)|undefined;
  const onBeforeRequest=vi.fn((_filter:unknown,listener:NonNullable<typeof guard>)=>{guard=listener;});
  vi.spyOn(AppUpdater.prototype,'netSession','get').mockReturnValue({webRequest:{onBeforeRequest}});
  vi.spyOn(ElectronHttpExecutor.prototype,'createRequest').mockImplementation((opts:RequestOptions,callback:(response:IncomingMessage)=>void)=>{
    const logicalUrl=`${opts.protocol}//${opts.hostname}${opts.path}`;
    let cancelled=true;guard?.({url:logicalUrl},result=>{cancelled=result.cancel;});
    if(cancelled)throw Error(`Blocked fixture request: ${logicalUrl}`);
    // The product URL and guard remain intact; only sockets use loopback HTTP.
    // Inherited request/download/downloadToBuffer retain real streaming/hash logic.
    // No redirects/uploads in this fixture; those Electron-only request methods
    // are intentionally not emulated by the Node socket adapter.
    return request({hostname:'127.0.0.1',port:address.port,path:opts.path,method:opts.method,headers:{...opts.headers},agent},callback) as unknown as ReturnType<ElectronHttpExecutor['createRequest']>;
  });
  const runtimeSpy=vi.spyOn(AppUpdater.prototype,'createProviderRuntimeOptions');
  const driver=createWindowsUpdateDriver(publicKey,architecture);
  const runtime=runtimeSpy.mock.results[0]!.value as ProviderRuntimeOptions;
  const provider=await (driver as unknown as {clientPromise:Promise<{runtimeOptions:ProviderRuntimeOptions;isUseMultipleRangeRequest:boolean}>}).clientPromise;
  const logger={info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()};driver.logger=logger;
  const quitAndInstall=vi.spyOn(driver,'quitAndInstall').mockImplementation(()=>{}),beforeInstall=vi.fn(async()=>{});
  const updater=new WindowsDesktopUpdater({current:'1.0.0',publicKey,architecture,driver,beforeInstall});
  const installerPathOnDisk=()=> (driver as unknown as {installerPath:string}).installerPath;
  return {root,driver,provider,runtime,onBeforeRequest,updater,payload,requests,logger,quitAndInstall,beforeInstall,oldMapPath,installerPathOnDisk,
    ranges:()=>requests.filter(r=>r.path===installerPath&&r.range),full:()=>requests.filter(r=>r.path===installerPath&&!r.range)};
}

it('overrides only multiple Range through createWindowsUpdateDriver and retains the supplied runtime',async()=>{
  const h=await differentialFixture();
  expect(h.runtime.isUseMultipleRangeRequest).toBe(true);
  expect(h.provider.runtimeOptions).toEqual({...h.runtime,isUseMultipleRangeRequest:false});
  expect(h.provider.runtimeOptions).not.toBe(h.runtime);
  expect(h.provider.runtimeOptions.executor).toBe(h.runtime.executor);
  expect(h.provider.runtimeOptions.platform).toBe(h.runtime.platform);
  expect(h.provider.isUseMultipleRangeRequest).toBe(false);
  expect(h.driver.disableDifferentialDownload).toBe(false);
  expect(h.onBeforeRequest).toHaveBeenCalledWith({urls:['<all_urls>']},expect.any(Function));
});
it.each(['x64','arm64'] as const)('reconstructs %s through the real signed Provider and NSIS downloader using only single ranges',async architecture=>{
  const h=await differentialFixture({architecture,cachedBlockmap:architecture==='arm64'});
  expect(await h.updater.check()).toMatchObject({state:'available'});
  expect(await h.updater.install()).toMatchObject({state:'downloaded'});
  expect(h.full()).toHaveLength(0);
  expect(h.ranges().map(r=>({range:r.range,status:r.status,bytes:r.bytes,contentRange:r.contentRange}))).toEqual([1,5,9].map(i=>({
    range:`bytes=${i*blockSize}-${(i+1)*blockSize-1}`,status:206,bytes:blockSize,
    contentRange:`bytes ${i*blockSize}-${(i+1)*blockSize-1}/${newInstaller.length}`,
  })));
  expect(h.requests.some(r=>r.path===h.oldMapPath)).toBe(architecture==='x64');
  const rebuilt=readFileSync(h.installerPathOnDisk());
  expect(rebuilt.length).toBe(h.payload.size);
  expect(createHash('sha512').update(rebuilt).digest('base64')).toBe(h.payload.sha512);
  expect(h.requests.reduce((total,r)=>total+r.bytes,0)).toBeLessThan(newInstaller.length);
  expect(h.beforeInstall).not.toHaveBeenCalled();expect(h.quitAndInstall).not.toHaveBeenCalled();
  await h.updater.install();expect(h.beforeInstall).toHaveBeenCalledTimes(1);expect(h.quitAndInstall).toHaveBeenCalledWith(false,true);
});
it.each(['missingCache','failRange','corruptRange'] as const)('falls back to a verified full installer after %s',async failure=>{
  const h=await differentialFixture({[failure]:true});
  await h.updater.check();expect(await h.updater.install()).toMatchObject({state:'downloaded'});
  expect(h.full()).toEqual([expect.objectContaining({status:200,bytes:newInstaller.length})]);
  if(failure==='missingCache')expect(h.ranges()).toHaveLength(0);
  else expect(h.ranges().length).toBeGreaterThan(0);
  if(failure==='failRange'){
    expect(h.ranges().some(r=>r.status===416)).toBe(true);
    expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining('fallback to full download: HttpError: 416'));
  }
  expect(h.ranges().every(r=>/^bytes=\d+-\d+$/.test(r.range!))).toBe(true);
  expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining('fallback to full download'));
  expect(readFileSync(h.installerPathOnDisk())).toEqual(newInstaller);
  expect(await verifyWindowsInstaller(h.installerPathOnDisk(),h.payload)).toBe(true);
  await h.updater.install();expect(h.quitAndInstall).toHaveBeenCalledTimes(1);
});
it.each(['hash','size'] as const)('rejects a full fallback with the wrong final %s before installation',async kind=>{
  const h=await differentialFixture({missingCache:true,corruptFull:kind==='hash',signedSize:kind==='size'?newInstaller.length+1:undefined});
  await h.updater.check();await expect(h.updater.install()).rejects.toThrow('下载或签名校验失败');
  expect(h.full()).toHaveLength(1);
  expect(h.beforeInstall).not.toHaveBeenCalled();expect(h.quitAndInstall).not.toHaveBeenCalled();
});
it.each(['same-size','truncated'] as const)('rechecks the real reconstructed cache and refuses %s tampering before installation',async kind=>{
  const h=await differentialFixture();await h.updater.check();await h.updater.install();
  writeFileSync(h.installerPathOnDisk(),Buffer.alloc(kind==='same-size'?newInstaller.length:newInstaller.length-1));
  await expect(h.updater.install()).rejects.toThrow('签名校验');
  expect(h.beforeInstall).not.toHaveBeenCalled();expect(h.quitAndInstall).not.toHaveBeenCalled();
});
