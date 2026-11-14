import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {applyChanges,parseRichPayload,richDigest} from '../src/rich-document.mjs';
const fixture=JSON.parse(readFileSync(new URL('../../../packages/protocol/test/fixtures/recipe-rich-v2.content.json',import.meta.url)));
fixture.parts=[];fixture.memories=[];
const value={kind:'config',title:'Model access',instructions:'Choose a model in settings.',required:true,action:{kind:'nativeSettings',entry:'modelAccess'}};
const change={op:'addSetup',value,source:{kind:'accountClaim'}};
const payload=changes=>({format:'rich-v2',purpose:'editDraft',draftId:randomUUID(),baseRevision:1,requestId:randomUUID(),schemaVersion:2,changes});
test('typed setup addition allocates retry-stable identity and preserves inert settings action',()=>{
  const parsed=parseRichPayload(payload([change]));
  const first=applyChanges(fixture,parsed.changes,()=>null,'operation-seed');
  assert.deepEqual(applyChanges(fixture,parsed.changes,()=>null,'operation-seed'),first);
  assert.notEqual(applyChanges(fixture,parsed.changes,()=>null,'other-operation').doc.content.setup[0].itemId,first.doc.content.setup[0].itemId);
  assert.deepEqual(first.doc.content.setup[0].action,value.action);
  assert.equal(first.copies[0].source.kind,'accountClaim');
  assert.equal(first.doc.content.setup.length,1);assert.equal(fixture.setup.length,0);
  const edited=applyChanges(first.doc.content,[{op:'setSetup',itemId:first.doc.content.setup[0].itemId,value:{...value,title:'Changed title'}}],()=>null,'second-operation');
  assert.equal(edited.doc.content.setup[0].originId,first.doc.content.setup[0].originId);
  assert.notEqual(richDigest(parsed),richDigest({...parsed,changes:[{...change,source:{kind:'releaseItems',parents:[{versionId:randomUUID(),itemId:randomUUID(),baselineSha256:'ab'.repeat(32)}]}}]}));
});
test('setup addition shares strict typed, byte, count and structural budgets',()=>{
  const edge={versionId:randomUUID(),itemId:randomUUID(),baselineSha256:'ab'.repeat(32)};
  for(const bad of [
    {...change,itemId:randomUUID()}, {...change,value:{...value,originId:randomUUID()}},
    {...change,value:{...value,action:{kind:'shell',command:'echo injected'}}},
    {...change,value:{...value,instructions:'😀'.repeat(513)}},
    {...change,source:{kind:'releaseItem',...edge}},
    {...change,source:{kind:'releaseItems',parents:[edge,edge]}},
    {...change,source:{kind:'releaseItems',parents:Array.from({length:65},()=>({...edge,itemId:randomUUID()}))}},
    {...change,value:{...value,action:{kind:'nativeSettings',entry:'terminal'}}},
  ])assert.throws(()=>parseRichPayload(payload([bad])));
  assert.throws(()=>applyChanges(fixture,Array.from({length:9},()=>change),()=>null,'too-many'));
  const large=structuredClone(fixture);large.role.text.value='r'.repeat(16384);
  const long={...change,value:{...value,title:'t'.repeat(80),instructions:'i'.repeat(2048),check:'c'.repeat(512)}};
  assert.throws(()=>applyChanges(large,Array.from({length:8},()=>long),()=>null,'readable-budget'));
  const nested={...change,value:{...value,action:{kind:'manual',extra:Array.from({length:32769},()=>({}))}}};
  assert.throws(()=>parseRichPayload(payload([nested])));
  assert.throws(()=>parseRichPayload(payload([{...change,value:{...value,instructions:'x'.repeat(32769)}}])));
});
