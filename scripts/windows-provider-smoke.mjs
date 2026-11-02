import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@vonvon/protocol';

/** Native-protocol fixture for the actual packaged daemon. No accounts, Bot or
 * Feishu transport are created; every production build exercises these bytes. */
export async function createPackagedCodexFixture(home, executable) {
  const directory = join(home, 'provider-fixture');
  await mkdir(directory, {recursive: true});
  const script = join(directory, 'codex.cjs');
  const bin = join(directory, 'codex.cmd');
  const stateFile = join(directory, 'state.json');
  const callsFile = join(directory, 'calls.ndjson');
  await writeFile(callsFile, '');
  await writeFile(stateFile, JSON.stringify({model: 'native-first'}));
  await writeFile(script, `
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0);}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(typeof m.id!=='number')return;
 const state=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)},'utf8'));
 fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({method:m.method,params:m.params})+'\\n');
 const send=result=>console.log(JSON.stringify({id:m.id,result}));
 if(m.method==='model/list'){
  if(state.fail)return console.log(JSON.stringify({id:m.id,error:{code:-32000,message:'fixture unavailable'}}));
  return send({data:[{id:'native-row',model:state.model,displayName:'Native model',description:'Fixture',isDefault:true,hidden:false,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'high'},{id:'hidden-row',hidden:true}],nextCursor:null});
 }
 if(m.method==='config/read')return send({config:{model_provider:'fixture'}});
 if(m.method==='account/read')return send({requiresOpenaiAuth:false,account:null});
 if(m.method==='configRequirements/read')return send({requirements:null});
 send({});
});
`);
  const quote = value => value.replaceAll('%', '%%');
  await writeFile(bin, `@echo off\r\n"${quote(executable)}" "${quote(script)}" %*\r\n`);
  return {bin, directory, stateFile, callsFile};
}

/** The hello carries the protocol this checkout builds: an older one is held to status, upgrade and stop. */
export async function verifyPackagedProvider(listen, home, fixture) {
  const credential = (await readFile(join(home, 'local-credential'), 'utf8')).trim();
  const socket = new WebSocket(`ws://${listen}`);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Packaged Provider handshake timed out')), 10_000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({type:'hello',protocolVersion:PROTOCOL_VERSION,clientKind:'cli',credential})));
    socket.addEventListener('error', () => {clearTimeout(timeout); reject(new Error('Packaged Provider connection failed'));});
    socket.addEventListener('message', event => {const value=JSON.parse(event.data); if(value.type==='serverInfo'){clearTimeout(timeout);resolve();}else if(value.id){pending.get(value.id)?.(value);pending.delete(value.id);}});
  });
  const request = refresh => new Promise((resolve, reject) => {
    const id = String(nextId++);
    const timer = setTimeout(() => {pending.delete(id);reject(new Error('Packaged model discovery timed out'));}, 60_000);
    pending.set(id, value => {clearTimeout(timer);value.type==='error'?reject(new Error(value.message)):resolve(value.payload);});
    socket.send(JSON.stringify({type:'request',id,method:'collaboration',payload:{action:'providerModels',backend:'codex-appserver',...(refresh?{refresh:true}:{})}}));
  });
  const expected = id => [{id,displayName:'Native model',description:'Fixture',hidden:false,isDefault:true,supportedEfforts:['low','high'],defaultEffort:'high'}];
  const calls = async () => (await readFile(fixture.callsFile,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  try {
    await ready;
    assert.deepEqual((await request()).models, expected('native-first'));
    const firstCalls = (await calls()).filter(call=>call.method==='model/list');
    assert.equal(firstCalls.length, 1);
    assert.equal(firstCalls[0].params.includeHidden, true);
    const warm = performance.now();
    assert.deepEqual((await request()).models, expected('native-first'));
    const cachedMs = Math.round(performance.now()-warm);
    assert.equal((await calls()).filter(call=>call.method==='model/list').length, 1, 'ordinary reads must reuse the successful catalog');
    await writeFile(fixture.stateFile,JSON.stringify({model:'native-refreshed'}));
    assert.deepEqual((await request()).models, expected('native-first'));
    assert.deepEqual((await request(true)).models, expected('native-refreshed'));
    await writeFile(fixture.stateFile,JSON.stringify({model:'native-refreshed',fail:true}));
    assert.equal((await request(true)).state, 'unavailable');
    await writeFile(fixture.stateFile,JSON.stringify({model:'native-recovered'}));
    assert.deepEqual((await request()).models, expected('native-recovered'));
    await writeFile(fixture.stateFile,JSON.stringify({model:'native-config-change'}));
    await writeFile(join(fixture.directory,'config.toml'),'# changed config identity');
    assert.deepEqual((await request()).models, expected('native-config-change'));
    return {nativeModelParity:true,catalogCache:true,explicitRefresh:true,refreshFailureRecovery:true,configInvalidation:true,cachedMs};
  } finally { socket.close(); }
}
