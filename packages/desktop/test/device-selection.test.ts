import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {LOCAL_VIEW,PROTOCOL_VERSION} from '@vonvon/protocol';
import {generateStaticKey} from '@vonvon/client/secure';
import {createDeviceConnections,type DeviceConnections,type ViewChange} from '../src/connections.js';
import {openDeviceRegistry,type StoredDevice} from '../src/device-registry.js';
import {openDeviceSelection,savedDeviceView,type DeviceSelectionStore} from '../src/device-selection.js';
import {RemoteConnectError,type RemoteConnectOptions} from '../src/remote-transport.js';
import {plainSecretBox} from './helpers/fake-secure-server.js';

const directories:string[]=[],managers:DeviceConnections[]=[];
afterEach(async()=>{
  await Promise.all(managers.splice(0).map(manager=>manager.dispose()));
  await Promise.all(directories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})));
});
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'vonvon-device-selection-'));directories.push(directory);
  const file=join(directory,'device-selection.json'),registryFile=join(directory,'devices.json'),box=plainSecretBox();
  async function launch(preferenceFile=file,store?:DeviceSelectionStore){
    const registry=await openDeviceRegistry(registryFile,box),selection=store??await openDeviceSelection(preferenceFile);
    const connect=vi.fn(async(_options:RemoteConnectOptions):Promise<never>=>{throw new RemoteConnectError('refused','socket');});
    const log=vi.fn();
    const devices=createDeviceConnections({registry,selection,box,connector:{connect},log,client:{version:'0.10.1',protocolVersion:PROTOCOL_VERSION}});
    managers.push(devices);
    return {registry,selection,devices,connect,log};
  }
  const first=await launch();
  async function add(overrides:Partial<StoredDevice>={}){
    const device:StoredDevice={deviceId:randomUUID(),pk:generateStaticKey().publicKeyBase64url,name:'Paired test device',clientId:'cl_test',
      clientKey:first.registry.sealKey(generateStaticKey()),routes:[{host:'127.0.0.1',port:49818,kind:'lan'}],addedAt:1,...overrides};
    await first.registry.put(device);return device;
  }
  return {directory,file,registryFile,box,first,launch,add};
}

it('restores the explicitly selected paired device across launches after view listeners are attached',async()=>{
  const f=await fixture(),device=await f.add();
  await f.first.devices.switchTo(device.deviceId);
  expect(JSON.parse(await readFile(f.file,'utf8'))).toEqual({v:1,selection:{kind:'paired',deviceId:device.deviceId,pk:device.pk}});
  if(process.platform!=='win32')expect((await stat(f.file)).mode&0o777).toBe(0o600);
  expect(await readFile(f.file,'utf8')).not.toContain(device.clientKey.secretKeySealed);
  await f.first.devices.dispose();
  const restarted=await f.launch(),views:ViewChange[]=[];
  restarted.devices.onView(change=>views.push(change));
  await restarted.devices.switchTo(savedDeviceView(restarted.selection,restarted.registry));
  expect(views[0]).toEqual({kind:'waiting',id:device.deviceId});
  await vi.waitFor(()=>expect(restarted.connect).toHaveBeenCalledOnce());
  expect(restarted.devices.state().active.id).toBe(device.deviceId);
  expect(views.some(change=>change.kind==='local')).toBe(false);
  expect(restarted.connect.mock.calls[0]![0].device.pk).toBe(device.pk);
});

it('remembers an explicit return to this computer and removal of the selected device',async()=>{
  const f=await fixture(),device=await f.add();
  await f.first.devices.switchTo(device.deviceId);await f.first.devices.switchTo(LOCAL_VIEW);
  expect((await f.launch()).selection.get()).toEqual({kind:'local'});
  await f.first.devices.switchTo(device.deviceId);await f.first.devices.remove(device.deviceId);
  const restarted=await f.launch();
  expect(savedDeviceView(restarted.selection,restarted.registry)).toBe(LOCAL_VIEW);
  expect(restarted.selection.get()).toEqual({kind:'local'});
  expect(restarted.registry.get(device.deviceId)).toBeUndefined();
});

it('keeps local when no historical choice exists even if several devices were connected recently',async()=>{
  const f=await fixture();await f.add({lastConnectedAt:Date.now()});await f.add({lastConnectedAt:Date.now()+1});
  const restarted=await f.launch();
  expect(savedDeviceView(restarted.selection,restarted.registry)).toBe(LOCAL_VIEW);
  expect(restarted.connect).not.toHaveBeenCalled();
});

it.each(['corrupt','unknown','changed-key','revoked','identity_changed','unknown_client','key-unreadable'] as const)(
  'does not auto-connect an invalid saved choice: %s',async failure=>{
    const f=await fixture(),device=await f.add();
    const selected={kind:'paired',deviceId:device.deviceId,pk:device.pk};
    if(failure==='unknown')selected.deviceId=randomUUID();
    if(failure==='changed-key')selected.pk=generateStaticKey().publicKeyBase64url;
    if(failure==='revoked'||failure==='identity_changed'||failure==='unknown_client')await f.first.registry.update(device.deviceId,value=>({...value,problem:{code:failure,at:1}}));
    if(failure==='key-unreadable')vi.spyOn(f.box,'available').mockReturnValue(false);
    await writeFile(f.file,failure==='corrupt'?'broken JSON':JSON.stringify({v:1,selection:selected}));
    const restarted=await f.launch();
    expect(savedDeviceView(restarted.selection,restarted.registry)).toBe(LOCAL_VIEW);
    expect(restarted.connect).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

it('does not overwrite a preference from a newer app while still allowing an explicit switch',async()=>{
  const f=await fixture(),device=await f.add();
  const newer=JSON.stringify({v:2,selection:{kind:'paired',deviceId:device.deviceId,pk:device.pk},future:true});
  await writeFile(f.file,newer);
  const restarted=await f.launch();
  expect(savedDeviceView(restarted.selection,restarted.registry)).toBe(LOCAL_VIEW);
  await restarted.devices.switchTo(device.deviceId);
  expect(restarted.devices.state().active.id).toBe(device.deviceId);
  expect(restarted.connect).toHaveBeenCalledOnce();
  expect(await readFile(f.file,'utf8')).toBe(newer);
});

it('does not block a device switch or removal when the preference store refuses writes',async()=>{
  const f=await fixture(),device=await f.add(),refusal='private-error-not-for-logs';
  const selected=await f.launch(f.file,{get:()=>undefined,set:vi.fn(async()=>{throw new Error(refusal);})});
  await selected.devices.switchTo(device.deviceId);
  expect(selected.devices.state().active.id).toBe(device.deviceId);
  await selected.devices.remove(device.deviceId);
  expect(selected.devices.state().active.id).toBe(LOCAL_VIEW);
  expect(selected.registry.get(device.deviceId)).toBeUndefined();
  expect(selected.log).toHaveBeenCalledWith('device-selection-failed',{id:device.deviceId.slice(0,8),code:'write_failed'});
  const logs=JSON.stringify(selected.log.mock.calls);
  expect(logs).not.toContain(refusal);expect(logs).not.toContain(device.pk);expect(logs).not.toContain(device.clientKey.secretKeySealed);
});

it('persists rapid switches in order and retains the latest valid paired choice',async()=>{
  const f=await fixture(),a=await f.add(),b=await f.add();
  await Promise.all([f.first.devices.switchTo(a.deviceId),f.first.devices.switchTo(b.deviceId)]);
  const restarted=await f.launch();
  expect(f.first.devices.state().active.id).toBe(b.deviceId);
  expect(savedDeviceView(restarted.selection,restarted.registry)).toBe(b.deviceId);
  expect((await restarted.registry.list()).map(device=>device.deviceId)).toEqual([a.deviceId,b.deviceId]);
});

it('does not let removing the previous device overwrite a newer pending selection',async()=>{
  const f=await fixture(),a=await f.add(),b=await f.add();
  await f.first.devices.switchTo(a.deviceId);
  const switching=f.first.devices.switchTo(b.deviceId);
  expect(f.first.devices.state().active.id).toBe(b.deviceId);
  await f.first.devices.remove(a.deviceId);await switching;
  const restarted=await f.launch();
  expect(f.first.devices.state().active.id).toBe(b.deviceId);
  expect(savedDeviceView(restarted.selection,restarted.registry)).toBe(b.deviceId);
  expect(restarted.registry.list().map(device=>device.deviceId)).toEqual([b.deviceId]);
});

it('cancels the selected connection on disposal while waiting for the preference write',async()=>{
  const f=await fixture(),device=await f.add();
  const switching=f.first.devices.switchTo(device.deviceId);
  const disposed=f.first.devices.dispose();
  await switching;await disposed;
  expect(f.first.connect.mock.calls.every(([options])=>options.signal.aborted)).toBe(true);
});
