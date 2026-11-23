import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { authoringMaterial, authoringProof, authoringTranscript, DISPATCH_DIGEST } from '../src/authoring-proof.mjs';
import { authoringInput, canonicalJson, checkDraftPatch, decodePayload, payloadBytes } from '../src/authoring-input.mjs';
import { sha256 } from '../src/install-proof.mjs';
import { createRecipeServer } from '../src/http.mjs';
import { ApiError } from '../src/errors.mjs';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/authoring-proof.json',import.meta.url)));
const key=raw=>createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b656e04220420','hex'),Buffer.from(raw,'hex')]),format:'der',type:'pkcs8'});
const body={public:{name:'',summary:'',overview:'',version:'',access:'direct'},config:{role:'已选择的角色'}};
const id='019d641b-2910-7000-8000-000000000001';
const patch={schemaVersion:1,draftId:id,baseRevision:1,changes:[{op:'setDraftRole',value:'新角色'},{op:'setSetup',value:null}]};

test('authoring golden transcript and X25519/HKDF/HMAC proof stay separate from install authority',()=>{
  assert.equal(authoringTranscript(fixture.binding).toString('hex'),fixture.transcriptHex);
  assert.equal(authoringProof(key(fixture.targetPrivateKeyHex),fixture.binding).toString('hex'),fixture.proofHex);
  for(const changed of [
    {operationId:'019d641b-2910-7000-8000-000000000099'}, {accountId:'11111111-2222-4333-8444-555555555599'},
    {draftId:'11111111-2222-4333-8444-555555555599'}, {baseRevision:8}, {stateRevision:3},
    {purpose:'prepareDraft'}, {stage:'dispatch'}, {payloadDigest:'f'.repeat(64)},
    {nonceCommitment:Buffer.alloc(32,1).toString('base64url')}, {deadline:fixture.binding.deadline+1},
  ])assert.notEqual(authoringProof(key(fixture.targetPrivateKeyHex),{...fixture.binding,...changed}).toString('hex'),fixture.proofHex);
  const {privateKey,publicKey}=generateKeyPairSync('x25519');
  const binding={...fixture.binding,targetPublicKey:publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64url')};
  const material=authoringMaterial(binding);
  assert.deepEqual(sha256(authoringProof(privateKey,{...binding,...material})),material.proofHash);
  assert.notDeepEqual(sha256(authoringProof(generateKeyPairSync('x25519').privateKey,{...binding,...material})),material.proofHash);
  assert.throws(()=>authoringMaterial({...binding,targetPublicKey:Buffer.alloc(32).toString('base64url')}));
  assert.ok(createPublicKey(key(fixture.targetPrivateKeyHex)));
});

test('encoded candidates bind canonical UTF-8 bytes and reject alternate JSON encodings',()=>{
  assert.deepEqual(decodePayload(payloadBytes(body).toString('base64url')),payloadBytes(body));
  assert.deepEqual(decodePayload(payloadBytes(patch).toString('base64url')),payloadBytes(patch));
  assert.equal(canonicalJson({z:'😀\n',a:1}),'{"a":1,"z":"😀\\n"}');
  for(const input of [
    Buffer.from(JSON.stringify(body)).toString('base64url'),
    Buffer.from('{"config":{"role":"a","role":"b"},"public":{}}').toString('base64url'),
    Buffer.from([0xff]).toString('base64url'), 'e30=', '', 'a'.repeat(180001),
    payloadBytes({...body,sourceVersionId:id}).toString('base64url'),
    payloadBytes({...body,config:{role:'x',botId:'PRIVATE'}}).toString('base64url'),
    payloadBytes({...body,config:{role:'sb_secret_'+'a'.repeat(24)}}).toString('base64url'),
  ])assert.throws(()=>decodePayload(input));
  assert.throws(()=>canonicalJson(Array.from({length:20}).reduce(value=>[value],[])));
});

test('typed patch uses the draft validator and rejects arbitrary paths or permission changes',()=>{
  checkDraftPatch(patch);
  for(const change of [
    {op:'setPublicText',field:'access',value:'direct'}, {op:'setPublicText',field:'name',value:'x'.repeat(61)},
    {op:'setDraftRole',value:'x'.repeat(16385)}, {op:'setDraftRole',value:null},
    {op:'setSetup',value:{steps:[]}}, {op:'publish',value:true}, {op:'set',path:'/config/role',value:'a'},
    {op:'setDraftRole',value:'x',accountId:id},
  ])assert.throws(()=>checkDraftPatch({...patch,changes:[change]}));
  for(const change of [{schemaVersion:2},{baseRevision:null},{changes:[]},{changes:[...patch.changes,patch.changes[0]]}]) {
    assert.throws(()=>checkDraftPatch({...patch,...change}));
  }
  for(const stage of ['dispatch','accept'])for(const field of ['ticket','nonce','proof']) {
    assert.throws(()=>authoringInput(stage==='dispatch'?'dispatchAuthoring':'acceptAuthoring',id,
      {ticket:fixture.ticket,nonce:fixture.nonce,proof:fixture.nonce,
        ...(stage==='accept'?{payload:payloadBytes(body).toString('base64url')} : {}),[field]:null}));
  }
});

test('authoring HTTP separates original-account stages from possession and bounds private payloads',async t=>{
  const calls=[];
  const server=createRecipeServer({verify:async token=>{if(token!=='valid')throw new ApiError(401,'auth_required');return {issuer:'synthetic',subject:id};},
    execute:async(...args)=>{calls.push(args);return {ok:true};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port+'/v1';
  const request=(path,body,auth=true)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer valid'}:{})},body:JSON.stringify(body)});
  const registration={purpose:'prepareDraft',targetPublicKey:fixture.binding.targetPublicKey,nonceCommitment:fixture.binding.nonceCommitment};
  assert.equal((await request('/authoring/'+id+'/register',registration)).status,200);
  assert.equal((await request('/authoring/'+id+'/register',registration,false)).status,401);
  for(const field of ['accountId','botId','chatId','recipientOpenId','path','source']) {
    assert.equal((await request('/authoring/'+id+'/register',{...registration,[field]:'PRIVATE'})).status,422);
  }
  assert.equal((await request('/authoring/'+id+'/authorize',{stage:'dispatch',stateRevision:1,payloadDigest:DISPATCH_DIGEST})).status,200);
  assert.equal((await request('/authoring/'+id+'/authorize',{stage:'accept',stateRevision:2,payloadDigest:'f'.repeat(64)},false)).status,401);
  const credentials={ticket:fixture.ticket,nonce:fixture.nonce,proof:fixture.nonce};
  assert.equal((await request('/authoring/'+id+'/accept',{...credentials,payload:payloadBytes(body).toString('base64url')},false)).status,200);
  assert.equal(calls.at(-1)[0],null);
  assert.deepEqual(calls.at(-1)[2].at(-1),payloadBytes(body));
  assert.equal((await request('/authoring/'+id+'/accept',{...credentials,payload:payloadBytes(body).toString('base64url')})).status,422);
  assert.equal((await request('/authoring/'+id+'/accept',{...credentials,payload:'x'.repeat(196608)},false)).status,413);
  assert.equal((await request('/authoring/'+id+'/dispatch',{...credentials,payload:payloadBytes(body).toString('base64url')},false)).status,422);
  assert.equal((await request('/authoring/'+id+'/accept',{...credentials,payload:payloadBytes({...body,config:{role:'x',tasks:[{enabled:true}]}}).toString('base64url')},false)).status,422);
  assert.equal(calls.length,3);
});
