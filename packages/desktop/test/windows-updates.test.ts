import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {WindowsDesktopUpdater,windowsUpdateConfiguration,allowedWindowsUpdateRequest,type WindowsUpdateDriver} from '../src/windows-updates.js';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
class Driver extends EventEmitter {
  autoDownload=true;autoInstallOnAppQuit=true;allowPrerelease=true;disableWebInstaller=false;
  checkForUpdates=vi.fn<WindowsUpdateDriver['checkForUpdates']>(async()=>({isUpdateAvailable:true,updateInfo:{version:'1.1.0',files:[{url:'../1.1.0/app.exe',sha512:'fixture-checksum'}]}}));
  downloadUpdate=vi.fn(async()=>['C:\\cache\\app.exe']);
  quitAndInstall=vi.fn();
}
function fixture(signed=true){
  const driver=new Driver(),verify=vi.fn(async()=>true),beforeInstall=vi.fn(async()=>{});
  const root=mkdtempSync(join(tmpdir(),'windows-update-'));roots.push(root);
  const statePath=join(root,'expected');
  const updater=new WindowsDesktopUpdater({current:'1.0.0',signed,publisherName:'Fixture Publisher',driver,verify,beforeInstall,statePath});
  return {driver,verify,beforeInstall,updater,statePath,root};
}
it('does not enable an unsigned Windows candidate or contact the server',async()=>{
  const h=fixture(false);expect(h.updater.enabled).toBe(false);expect(await h.updater.check()).toMatchObject({state:'unavailable'});expect(h.driver.checkForUpdates).not.toHaveBeenCalled();
});
it('blocks foreign origins, HTTP and paths outside the Windows release area, including redirect targets',()=>{
  expect(allowedWindowsUpdateRequest('https://dl.vonvon.cc/bot/windows/stable/latest.yml?noCache=1')).toBe(true);
  for(const url of ['http://dl.vonvon.cc/bot/windows/stable/latest.yml','https://evil.example/file.exe','https://dl.vonvon.cc/bot/mac/file.exe'])expect(allowedWindowsUpdateRequest(url)).toBe(false);
});
it('checks without downloading, verifies the installer, then installs only after another click',async()=>{
  const h=fixture();expect(h.driver.autoDownload).toBe(false);expect(h.driver.autoInstallOnAppQuit).toBe(false);expect(h.driver.disableWebInstaller).toBe(true);
  expect(await h.updater.check()).toMatchObject({state:'available',latest:'1.1.0'});expect(h.driver.downloadUpdate).not.toHaveBeenCalled();
  expect(await h.updater.install()).toMatchObject({state:'downloaded'});expect(h.beforeInstall).not.toHaveBeenCalled();expect(h.driver.quitAndInstall).not.toHaveBeenCalled();
  await h.updater.install();expect(h.verify).toHaveBeenCalledTimes(2);expect(h.beforeInstall).toHaveBeenCalledTimes(1);expect(h.driver.quitAndInstall).toHaveBeenCalledWith(false,true);expect(readFileSync(h.statePath,'utf8')).toBe('1.1.0');
});
it('refuses an installer with the wrong signer before shutdown',async()=>{
  const h=fixture();await h.updater.check();h.verify.mockResolvedValue(false);await expect(h.updater.install()).rejects.toThrow('签名校验失败');expect(h.beforeInstall).not.toHaveBeenCalled();expect(h.driver.quitAndInstall).not.toHaveBeenCalled();
});
it('invalidates a previous check when later metadata points at a foreign origin',async()=>{
  const h=fixture();await h.updater.check();h.driver.checkForUpdates.mockResolvedValue({isUpdateAvailable:true,updateInfo:{version:'1.2.0',files:[{url:'https://evil.example/app.exe',sha512:'fixture'}]}});
  await expect(h.updater.check()).rejects.toThrow('检查桌面更新失败');await expect(h.updater.install()).rejects.toThrow('请先检查');expect(h.driver.downloadUpdate).not.toHaveBeenCalled();
});
it('honors native rollout and OS compatibility eligibility, invalidating an older available check',async()=>{
  const h=fixture();await h.updater.check();h.driver.checkForUpdates.mockResolvedValue({isUpdateAvailable:false,updateInfo:{version:'1.2.0',files:[]}});
  expect(await h.updater.check()).toMatchObject({state:'current'});await expect(h.updater.install()).rejects.toThrow('请先检查');expect(h.driver.downloadUpdate).not.toHaveBeenCalled();
});
it('rejects web installers with a separate package payload',async()=>{
  const h=fixture();h.driver.checkForUpdates.mockResolvedValue({isUpdateAvailable:true,updateInfo:{version:'1.1.0',files:[{url:'app.exe',sha512:'fixture'}],packages:{x64:{path:'payload.7z'}}}});
  await expect(h.updater.check()).rejects.toThrow('检查桌面更新失败');await expect(h.updater.install()).rejects.toThrow('请先检查');
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
it('enables the packaged configuration only when the running executable has the expected signature',async()=>{
  const h=fixture();mkdirSync(join(h.root,'dist'));writeFileSync(join(h.root,'dist','windows-update-config.json'),JSON.stringify({publisherName:'Fixture Publisher'}));
  const verify=vi.fn(async()=>true);expect(await windowsUpdateConfiguration({appPath:h.root,isPackaged:true,executable:'app.exe',verify})).toEqual({signed:true,publisherName:'Fixture Publisher'});expect(verify).toHaveBeenCalledWith('app.exe','Fixture Publisher');
  verify.mockResolvedValue(false);expect(await windowsUpdateConfiguration({appPath:h.root,isPackaged:true,verify})).toEqual({signed:false});
});
