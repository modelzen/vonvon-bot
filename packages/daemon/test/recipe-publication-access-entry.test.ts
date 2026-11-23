import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import type {CreatorSnapshot} from '@vonvon/protocol';
import type {Presence} from '../src/recipe/authoring-service';
import type {CreatorLedger,JobRecord} from '../src/recipe/private-creator';
import {CreatorCards} from '../src/recipe/private-creator-cards';

const p:Presence={peer:{id:'peer',device:'device'},session:randomUUID(),account:randomUUID(),scope:'a'.repeat(64),until:10000,activity:0,activeAt:0};
function fixture(access:'direct'|'coded',incomplete=false){
  const snapshot:CreatorSnapshot={work:{draftId:randomUUID(),source:null},format:'role-v1',recipeId:null,parent:null,revision:7,
    public:{name:'巡检配方',summary:incomplete?'':'巡检说明',overview:'正文'.repeat(10000),version:'1.0',access},
    contentSha256:'b'.repeat(64),parts:[],sections:[{title:'role',pageHashes:['c'.repeat(64)]}]};
  const row:JobRecord={job:{id:randomUUID(),binding:randomUUID(),scope:p.scope,task:{kind:'command',
    command:{kind:'publish',snapshot,snapshotDigest:'d'.repeat(64)},expiresAt:10000,approval:'0'.repeat(64)}},state:'offer',created:0,expiresAt:10000};
  const ledger:CreatorLedger={jobs:{[row.job.id]:row},cards:{}};
  return {snapshot,row,ledger,cards:new CreatorCards(()=>0)};
}
it.each(['direct','coded'] as const)('offers the opposite access bound to the displayed %s draft without changing it',access=>{
  const {snapshot,row,ledger,cards}=fixture(access);
  const before=JSON.stringify(snapshot);
  const card=cards.approvalCard(p,ledger,row,false);
  const option=card.options.find(o=>o.label===(access==='direct'?'改为凭分享码获取':'改为直接获取'));
  expect(option?.choice).toEqual({kind:'offer',command:{kind:'metadata',work:snapshot.work,revision:7,baseSha256:snapshot.contentSha256,
    change:{field:'access',value:access==='direct'?'coded':'direct'}}});
  expect(JSON.stringify(snapshot)).toBe(before);
  expect(card.text.length).toBeLessThan(300);
  expect(Object.keys(ledger.jobs)).toEqual([row.job.id]);
  if(option?.choice.kind!=='offer')throw Error('missing metadata offer');
  const confirmation=cards.approvalCard(p,ledger,{...row,job:{...row.job,task:{kind:'command',command:option.choice.command,expiresAt:10000,approval:'0'.repeat(64)}}},false);
  expect(confirmation.text).toContain('获取方式 → '+(access==='direct'?'凭分享码获取':'直接获取'));
  expect(confirmation.options.map(o=>o.label)).toEqual(['采用修改']);
});
it('keeps incomplete publication information visible while offering access, but never offers it for an unknown request',()=>{
  const {row,ledger,cards}=fixture('direct',true);
  const initial=cards.approvalCard(p,ledger,row,false);
  expect(initial.title).toBe('完善发布信息');
  expect(initial.text).toContain('简介');
  expect(initial.options.some(o=>o.choice.kind==='offer')).toBe(true);
  expect(initial.options.some(o=>o.choice.kind==='approve')).toBe(false);
  row.state='unknown';
  for(const retry of [true,false]){
    const card=cards.approvalCard(p,ledger,row,retry);
    expect(card.options.some(o=>o.choice.kind==='offer')).toBe(false);
  }
  expect(Object.keys(ledger.jobs)).toEqual([row.job.id]);
  expect(row.state).toBe('unknown');
});
