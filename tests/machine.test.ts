import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {MachineService} from '../desktop/main/machine';
import {DesktopUpdater} from '../desktop/main/updates';
import {recentLogs,LOG_LIMIT} from '../desktop/main/logs';
import type {HostHandle} from '../desktop/main/host';

class Driver extends EventEmitter {
  calls:string[]=[];
  setFeedURL({url}:{url:string}) {this.calls.push(url);}
  checkForUpdates() {this.calls.push('download');queueMicrotask(()=>this.emit('update-downloaded'));}
  quitAndInstall() {this.calls.push('install');}
}
const runtime={home:'/fixture',nodePath:'/fixture/node',cliPath:'/fixture/cli'};
const status={platformName:'fixture',installed:false,running:false,servicePath:'/fixture/service',stdoutPath:'/fixture/out',stderrPath:'/fixture/err'};
function host(ownership:'owned'|'attached'='owned',request:HostHandle['request']=async()=>new Response('{}')):HostHandle {return {kind:'connected',ownership,pid:12,request,close:async()=>{},restart:async()=>{}};}

test('temporary Agent selection is passed to lifecycle and stop stays stopped on status reads',async()=>{
  let current:HostHandle|undefined;
  const calls:string[]=[];
  const service=new MachineService({runtime,host:()=>current,stopHost:async()=>{calls.push('stop');current=undefined;},startHost:async bot=>{calls.push(bot ?? 'default');current=host();},serviceCommand:async()=>status,updater:new DesktopUpdater({current:'0.7.0',signed:false,driver:new Driver()})});
  await service.request({type:'startHost',bot:'cli_test'});
  assert.equal((await service.request({type:'status'})).type,'status');
  await service.request({type:'stopHost'});
  await service.request({type:'status'});
  assert.deepEqual(calls,['cli_test','stop']);
  assert.equal(current,undefined);
});
test('service install stops owned Host before registering and reconnects afterward',async()=>{
  let current:HostHandle|undefined=host();
  const calls:string[]=[];
  const service=new MachineService({runtime,host:()=>current,stopHost:async()=>{calls.push('stop');current=undefined;},startHost:async()=>{calls.push('connect');current=host('attached');},serviceCommand:async action=>{calls.push(action);return status;},updater:new DesktopUpdater({current:'0.7.0',signed:false,driver:new Driver()})});
  await service.request({type:'service',action:'install'});
  assert.deepEqual(calls,['status','stop','install','connect']);
  await assert.rejects(service.request({type:'service',action:'install'}),/外部/);
});
test('owned Core refuses global npm update and attached check never installs',async()=>{
  const requests:string[]=[];
  let current=host('owned',async(path)=>{requests.push(path);return Response.json(path==='/api/daemon'?{distribution:{kind:'global-npm',cliPath:'/npm/bridge'}}:{current:'0.7.0',latest:'0.8.0',hasUpdate:true,dev:false});});
  const service=new MachineService({runtime,host:()=>current,stopHost:async()=>{},startHost:async()=>{},serviceCommand:async()=>status,updater:new DesktopUpdater({current:'0.7.0',signed:false,driver:new Driver()})});
  await assert.rejects(service.request({type:'applyCoreUpdate'}),/内置/);
  current={...current,ownership:'attached'};
  await service.request({type:'checkCoreUpdate'});
  assert.deepEqual(requests,['/api/daemon','/api/update/check']);
});
test('logs preserve server text and reject oversized response',async()=>{
  assert.equal(await recentLogs(host('owned',async()=>new Response('one\ntwo'))),'one\ntwo');
  await assert.rejects(recentLogs(host('owned',async()=>new Response('x'.repeat(LOG_LIMIT+4097)))),/限制/);
});
test('desktop check is read-only; native download and install require separate requests',async()=>{
  const driver=new Driver();
  const updater=new DesktopUpdater({current:'0.7.0',signed:true,manifestURL:'https://updates.example/manifest.json',driver,fetch:async()=>Response.json({version:'0.8.0',feedURL:'https://updates.example/mac/feed'})});
  assert.equal((await updater.check()).state,'available');
  assert.deepEqual(driver.calls,[]);
  assert.equal((await updater.install()).state,'downloaded');
  assert.deepEqual(driver.calls,['https://updates.example/mac/feed','download']);
  await updater.install();
  assert.equal(driver.calls.at(-1),'install');
  assert.equal(driver.listenerCount('error'),1);
});
test('unsigned builds and untrusted feed cannot invoke native updater',async()=>{
  const driver=new Driver();
  assert.equal((await new DesktopUpdater({current:'0.7.0',signed:false,driver}).check()).state,'unavailable');
  const updater=new DesktopUpdater({current:'0.7.0',signed:true,manifestURL:'https://updates.example/manifest',driver,fetch:async()=>Response.json({version:'0.8.0',feedURL:'https://attacker.example/feed'})});
  await assert.rejects(updater.check(),/不可信/);
  await assert.rejects(updater.install(),/检查/);
  assert.deepEqual(driver.calls,[]);
});

test('install honors draft veto and records expected version for restart verification',async()=>{
  const {mkdtemp,readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'vonvon-update-'));
  try {
    const driver=new Driver();
    let allow=false;
    const options={current:'0.7.0',signed:true,manifestURL:'https://updates.example/manifest',driver,statePath:join(dir,'expected'),fetch:async()=>Response.json({version:'0.8.0',feedURL:'https://updates.example/feed'}),beforeInstall:async()=>{if(!allow)throw new Error('unsaved draft');}};
    const updater=new DesktopUpdater(options);
    await updater.check();await updater.install();
    await assert.rejects(updater.install(),/unsaved/);
    assert.ok(!driver.calls.includes('install'));
    allow=true;await updater.install();
    assert.equal(await readFile(options.statePath,'utf8'),'0.8.0');
    assert.match((await new DesktopUpdater(options).check()).message,/尚未生效/);
    assert.equal((await new DesktopUpdater({...options,current:'0.8.0'}).check()).state,'current');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('attached foreground Host cannot stop a different OS service',async()=>{
  const calls:string[]=[];
  const service=new MachineService({runtime,host:()=>host('attached'),stopHost:async()=>{calls.push('detach');},startHost:async()=>{},serviceCommand:async action=>{calls.push(action);return {...status,installed:true,running:true,pid:'99'};},updater:new DesktopUpdater({current:'0.7.0',signed:false,driver:new Driver()})});
  await assert.rejects(service.request({type:'service',action:'stop'}),/不属于/);
  assert.deepEqual(calls,['status']);
});


test('failed conversion restores owned temporary run only when service remains unregistered',async()=>{
  for (const registered of [false,true]) {
    let current:HostHandle|undefined;
    let attempted=false;
    const starts:(string|undefined)[]=[];
    const service=new MachineService({runtime,host:()=>current,stopHost:async()=>{current=undefined;},startHost:async bot=>{starts.push(bot);current=host();},serviceCommand:async action=>{if(action==='install'){attempted=true;throw new Error('installation failed');}return {...status,installed:attempted&&registered};},updater:new DesktopUpdater({current:'0.7.0',signed:false,driver:new Driver()})});
    await service.request({type:'startHost',bot:'cli_temp'});
    await assert.rejects(service.request({type:'service',action:'install'}),/installation failed/);
    assert.deepEqual(starts,registered?['cli_temp']:['cli_temp','cli_temp']);
    assert.equal(!!current,!registered);
  }
});
test('inapplicable service start leaves working Host untouched',async()=>{
  let stopped=false;
  const service=new MachineService({runtime,host:()=>host(),stopHost:async()=>{stopped=true;},startHost:async()=>{},serviceCommand:async()=>status,updater:new DesktopUpdater({current:'0.7.0',signed:false,driver:new Driver()})});
  await assert.rejects(service.request({type:'service',action:'start'}),/已安装/);
  assert.equal(stopped,false);
});
test('resolved start without a connected Host is a failure',async()=>{
  const service=new MachineService({runtime,host:()=>undefined,stopHost:async()=>{},startHost:async()=>{},serviceCommand:async()=>status,updater:new DesktopUpdater({current:'0.7.0',signed:false,driver:new Driver()})});
  await assert.rejects(service.request({type:'startHost',bot:'cli_temp'}),/已停止/);
  const reply=await service.request({type:'status'});
  assert.equal(reply.type==='status'&&reply.temporaryAgent,undefined);
});
test('attached bundled service cannot update an unrelated global npm installation',async()=>{
  const calls:string[]=[];
  const service=new MachineService({runtime,host:()=>host('attached',async path=>{calls.push(path);return Response.json({distribution:{kind:'bundled',cliPath:'/App/runtime/core/bin/bridge'}});}),stopHost:async()=>{},startHost:async()=>{},serviceCommand:async()=>status,updater:new DesktopUpdater({current:'0.7.0',signed:false,driver:new Driver()})});
  await assert.rejects(service.request({type:'applyCoreUpdate'}),/内置/);
  assert.deepEqual(calls,['/api/daemon']);
});
test('unpackaged and unsigned artifacts do not enable native updates',async()=>{
  const {desktopUpdateConfiguration}=await import('../desktop/main/update-configuration');
  assert.deepEqual(await desktopUpdateConfiguration({appPath:'/fixture',isPackaged:false}),{signed:false});
  assert.deepEqual(await desktopUpdateConfiguration({appPath:'/fixture/app.asar',isPackaged:true,platform:'darwin'}),{signed:false});
});

function deferred() {
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}

test('close waits for an in-flight service installation and cancels queued mutations',async()=>{
  const started=deferred(),finish=deferred();
  const calls:string[]=[];
  let current:HostHandle|undefined;
  const service=new MachineService({runtime,host:()=>current,stopHost:async()=>{current=undefined;},startHost:async()=>{calls.push('connect');current=host('attached');},serviceCommand:async action=>{
    calls.push(action);
    if(action==='install'){started.resolve();await finish.promise;}
    return status;
  },updater:new DesktopUpdater({current:'0.7.0',signed:false,driver:new Driver()})});
  const installing=service.request({type:'service',action:'install'});
  await started.promise;
  const queued=assert.rejects(service.request({type:'service',action:'stop'}),/退出/);
  let closed=false;
  const closing=service.close().then(()=>{closed=true;});
  await assert.rejects(service.request({type:'startHost'}),/退出/);
  assert.equal(closed,false);
  assert.deepEqual(calls,['status','install']);
  finish.resolve();
  await Promise.all([installing,queued,closing]);
  assert.deepEqual(calls,['status','install','connect']);
  assert.equal(closed,true);
  await service.close();
});

test('close fails closed on timeout and a retry waits for the same running operation',async()=>{
  const started=deferred(),finish=deferred();
  const service=new MachineService({runtime,host:()=>undefined,stopHost:async()=>{},startHost:async()=>{},serviceCommand:async()=>{
    started.resolve();await finish.promise;return status;
  },updater:new DesktopUpdater({current:'0.7.0',signed:false,driver:new Driver()})});
  const running=service.request({type:'status'});
  await started.promise;
  await assert.rejects(service.close(5),/阻止桌面退出/);
  await assert.rejects(service.request({type:'status'}),/退出/);
  finish.resolve();
  await Promise.all([running,service.close()]);
});

test('failed machine operation settles before close completes',async()=>{
  const started=deferred(),finish=deferred();
  const service=new MachineService({runtime,host:()=>undefined,stopHost:async()=>{},startHost:async()=>{},serviceCommand:async()=>{
    started.resolve();await finish.promise;throw new Error('service failed');
  },updater:new DesktopUpdater({current:'0.7.0',signed:false,driver:new Driver()})});
  const failed=assert.rejects(service.request({type:'status'}),/service failed/);
  await started.promise;
  const closing=service.close();
  finish.resolve();
  await Promise.all([failed,closing]);
});

test('updater shutdown inside the machine lane prevents later work without self-deadlock',async()=>{
  const driver=new Driver();
  const shutdown=deferred(),finish=deferred();
  const updater=new DesktopUpdater({current:'0.7.0',signed:true,manifestURL:'https://updates.example/manifest',driver,fetch:async()=>Response.json({version:'0.8.0',feedURL:'https://updates.example/feed'}),beforeInstall:async()=>{
    service.beginClosing();shutdown.resolve();await finish.promise;
  }});
  let commands=0;
  const service=new MachineService({runtime,host:()=>undefined,stopHost:async()=>{},startHost:async()=>{},serviceCommand:async()=>{commands++;return status;},updater});
  await service.request({type:'checkDesktopUpdate'});
  await service.request({type:'installDesktopUpdate'});
  const installing=service.request({type:'installDesktopUpdate'});
  const queued=assert.rejects(service.request({type:'service',action:'install'}),/退出/);
  await shutdown.promise;
  await assert.rejects(service.request({type:'status'}),/退出/);
  finish.resolve();
  await Promise.all([installing,queued,service.close()]);
  assert.equal(commands,0);
  assert.equal(driver.calls.at(-1),'install');
});
