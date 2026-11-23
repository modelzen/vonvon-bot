import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {applyChanges,document,parseRichPayload,richDigest,validateRichWritePayload,writableDocument} from '../src/rich-document.mjs';
import {richExecute} from '../src/rich-database.mjs';

const fixture=()=>JSON.parse(readFileSync(new URL('../../../packages/protocol/test/fixtures/recipe-rich-v2.content.json',import.meta.url)));
const identity=()=>({itemId:randomUUID(),originId:randomUUID()});
const sha=value=>createHash('sha256').update(value).digest('hex');
const unavailable=()=>{throw new Error('unexpected candidate resolution');};
const payload=(content,changes)=>({format:'rich-v2',purpose:'editDraft',draftId:randomUUID(),baseRevision:1,requestId:randomUUID(),schemaVersion:2,changes});

test('whole-collection cleanup preserves shared parts, survivor identities and historical bytes',()=>{
  const content=fixture(),shared=content.parts[0],orphan={...shared,objectId:randomUUID()};
  content.role.text={kind:'part',objectId:shared.objectId};
  content.parts.push(orphan);
  content.memories=Array.from({length:64},(_,index)=>({...identity(),text:{kind:'part',objectId:index%2?orphan.objectId:shared.objectId}}));
  const before=document(content),snapshots=[];
  assert.throws(()=>writableDocument(content),/invalid_input/);
  const changes=[{op:'removeLegacyMemories'}];
  assert.equal(parseRichPayload(payload(content,changes)).changes.length,1);
  const result=applyChanges(content,changes,unavailable,'cleanup',[],snapshot=>snapshots.push(snapshot));
  assert.equal(snapshots.length,1);
  assert.equal(snapshots[0].memories.length,0);
  assert.deepEqual(result.copies,[]);
  assert.deepEqual(result.doc.content,{...content,memories:[],parts:[shared]});
  assert.deepEqual(writableDocument(result.doc.content),result.doc);
  assert.equal(document(content).canonical,before.canonical);
  assert.equal(content.memories.length,64);
  const inline={...fixture(),parts:[],memories:[{...identity(),text:{kind:'inline',value:'private'}}]};
  assert.throws(()=>writableDocument(inline),/invalid_input/);
});

test('historical interpreters retain memory semantics while new intent rejects copy/include before resolution',()=>{
  const content=fixture(),memory=content.memories[0];
  const copy={op:'copyItem',source:{kind:'memory',itemId:memory.itemId}};
  const include={op:'includeCandidate',value:{kind:'memory',source:{sourceIntentId:randomUUID(),candidateId:memory.itemId,expectedRevision:1}}};
  for(const change of [copy,include]){
    const parsed=parseRichPayload(payload(content,[change,{op:'removeLegacyMemories'}]));
    assert.throws(()=>validateRichWritePayload(parsed),/invalid_input/);
    assert.equal(applyChanges(content,parsed.changes,()=>({content,itemId:memory.itemId}),'historical').doc.content.memories.length,0);
  }
  const prepare=parseRichPayload({format:'rich-v2',purpose:'prepareDraft',sourceIntentId:randomUUID(),content});
  assert.throws(()=>validateRichWritePayload(prepare),/invalid_input/);
  assert.equal(document(prepare.content).content.memories.length,content.memories.length);
});

test('new freeze validates memory intent and final state before source or origin writes',async()=>{
  const content=fixture(),base=document(content),draftId=randomUUID(),id=randomUUID();
  const ctx={purpose:'editDraft',draftId,revision:1,manifest:{sha256:sha(base.canonicalUTF8)},seed:'freeze',access:'direct'};
  const calls=[];
  const client={async query(query){calls.push(query);assert.match(query,/rich_plan_context/);return {rows:[{result:ctx}]};}};
  const edit=changes=>({format:'rich-v2',baseCanonical:Buffer.from(base.canonicalUTF8).toString('base64url'),payload:{...payload(content,changes),draftId}});
  await assert.rejects(richExecute(client,'richFreeze',[id,edit([{op:'includeCandidate',value:{kind:'memory',source:{sourceIntentId:id,candidateId:randomUUID(),expectedRevision:1}}},{op:'removeLegacyMemories'}])]),/invalid_input/);
  await assert.rejects(richExecute(client,'richFreeze',[id,edit([{op:'setPublicText',field:'name',itemId:content.public.name.itemId,value:'Clean-looking edit'}])]),/invalid_input/);
  await assert.rejects(richExecute(client,'richFreeze',[id,{...edit([{op:'removeLegacyMemories'}]),payload:{...edit([{op:'removeLegacyMemories'}]).payload,baseRevision:2}}]),/conflict/);
  ctx.purpose='prepareDraft';
  await assert.rejects(richExecute(client,'richFreeze',[id,{format:'rich-v2',content,access:'direct',origins:[],sourceVersionId:randomUUID()}]),/invalid_input/);
  assert.equal(calls.length,4);
});

test('metadata receipt replay precedes the write policy, and a new dirty result is rejected',async()=>{
  const content=fixture(),base=document(content),requestId=randomUUID(),draftId=randomUUID();
  const input={transformVersion:1,baseManifestSha256:sha(base.canonicalUTF8),public:{...Object.fromEntries(Object.entries(content.public).map(([k,v])=>[k,v.value])),access:'direct'},logo:{kind:'keep'}};
  const body={input,baseCanonical:Buffer.from(base.canonicalUTF8).toString('base64url'),manifestId:randomUUID()};
  const receipt={requestId,draftId,revision:2,manifestSha256:'a'.repeat(64)};
  let replay=true,calls=0;
  const client={async query(query,args){calls++;assert.match(query,/rich_metadata_context/);assert.equal(args[3],richDigest(body));return {rows:[{result:replay?{receipt}:{accountId:randomUUID(),manifest:{sha256:sha(base.canonicalUTF8)}}}]};}};
  assert.deepEqual(await richExecute(client,'richMetadata',[requestId,draftId,1,body]),{status:'committed',receipt});
  replay=false;
  await assert.rejects(richExecute(client,'richMetadata',[requestId,draftId,1,body]),/invalid_input/);
  assert.equal(calls,2);
});
