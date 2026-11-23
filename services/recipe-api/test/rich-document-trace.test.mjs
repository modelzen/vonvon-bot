import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {applyChanges,document} from '../src/rich-document.mjs';

const identity=()=>({itemId:randomUUID(),originId:randomUUID()});
function fixture(){
  const content=JSON.parse(readFileSync(new URL('../../../packages/protocol/test/fixtures/recipe-rich-v2.content.json',import.meta.url)));
  content.memories=[];content.parts=[];
  content.files=['SKILL.md','a.md','b.md'].map((name,index)=>({...identity(),name,use:index?'reference':'skillDescription',text:{kind:'inline',value:'body-'+index}}));
  content.skills=[{...identity(),name:'Review',entryFileId:content.files[0].itemId,fileIds:content.files.map(file=>file.itemId)}];
  return document(content).content;
}
const unavailable=()=>{throw new Error('unexpected source');};

test('observes isolated step snapshots while validating only the complete batch',()=>{
  const content=fixture(),before=structuredClone(content),snapshots=[];
  const changes=[{op:'setFile',itemId:content.files[1].itemId,value:{name:'b.md'}},
    {op:'setFile',itemId:content.files[2].itemId,value:{name:'a.md'}}];
  const result=applyChanges(content,changes,unavailable,'batch-seed',[],snapshot=>snapshots.push(snapshot));
  assert.equal(snapshots.length,2);
  assert.deepEqual(snapshots[0].files.map(file=>file.name),['SKILL.md','b.md','b.md']);
  assert.throws(()=>document(snapshots[0]));
  assert.deepEqual(result.doc.content.files.map(file=>file.name),['SKILL.md','b.md','a.md']);
  assert.deepEqual(applyChanges(content,changes,unavailable,'batch-seed'),result);
  assert.deepEqual(applyChanges(content,changes,unavailable,'batch-seed',[],snapshot=>{snapshot.files[1].text.value='observer mutation';}),result);
  snapshots[0].files[1].text.value='changed by observer';
  assert.equal(snapshots[1].files[1].text.value,'body-1');
  assert.equal(result.doc.content.files[1].text.value,'body-1');
  assert.deepEqual(content,before);
  assert.throws(()=>applyChanges(content,changes.slice(0,1),unavailable,'batch-seed',[],()=>{}));
});

test('observes each successful control branch and never observes a failed command',()=>{
  const content=fixture(),snapshots=[];
  const changes=[{op:'setAccess',value:'coded'},
    {op:'copyItem',source:{kind:'skill',itemId:content.skills[0].itemId}},
    {op:'includeCandidate',value:{kind:'rule',source:{sourceIntentId:randomUUID(),candidateId:randomUUID(),expectedRevision:1}}},
    {op:'removeItem',kind:'file',itemId:content.files[1].itemId}];
  const donor=structuredClone(content),rule={...identity(),purpose:'work',text:{kind:'inline',value:'Rule'}};donor.rules=[rule];
  applyChanges(content,changes,()=>({content:donor,itemId:rule.itemId}),'branch-seed',[],snapshot=>snapshots.push(snapshot));
  assert.equal(snapshots.length,4);
  assert.equal(snapshots[0].skills.length,1);assert.equal(snapshots[1].skills.length,2);
  assert.equal(snapshots[2].rules.length,1);assert.equal(snapshots[3].files.length,5);
  let failedCalls=0;
  assert.throws(()=>applyChanges(content,[{op:'removeItem',kind:'file',itemId:randomUUID()}],unavailable,'failure-seed',[],()=>failedCalls++));
  assert.equal(failedCalls,0);
});
