import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createRecipeServer} from '../src/http.mjs';
import {richExecute} from '../src/rich-database.mjs';
import {recipeBrowseDetailSchema} from '../../../packages/protocol/dist/index.js';
import {readerOutput} from '../src/reader-http.mjs';
const recipe='11111111-1111-4111-8111-111111111111',version='22222222-2222-4222-8222-222222222222';
test('browse preview uses one DB dispatch with no broker or object reads',async t=>{
  const calls=[],page={recipeId:recipe,versionId:version,format:'rich-v2',preview:{settings:[],skills:[],ruleCount:1,taskCount:1}};
  const server=createRecipeServer({verify:async()=>{throw Error('unexpected authentication');},execute:async(...args)=>{calls.push(args);return page;}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin='http://127.0.0.1:'+server.address().port;
  for(const prefix of ['/v2','/api/v2']){
    const path=prefix+'/recipes/'+recipe+'/versions/'+version+'/preview';
    const response=await fetch(origin+path);assert.equal(response.status,200);assert.deepEqual(await response.json(),page);
    assert.deepEqual(calls.at(-1),[null,'richBrowsePreview',[recipe,version]]);
    assert.equal((await fetch(origin+path+'?objects=all')).status,422);
    assert.equal((await fetch(origin+path,{method:'POST'})).status,405);
  }
  const queries=[];
  assert.deepEqual(await richExecute({query:async(...args)=>{queries.push(args);return {rows:[{result:page}]};}},'richBrowsePreview',[recipe,version]),page);
  assert.deepEqual(queries,[['select recipe_api.browse_preview($1,$2) as result',[recipe,version]]]);
});
test('the task summary route authenticates before its single private database read',async t=>{
  const calls=[],identity={issuer:'https://fixture.example/auth/v1',subject:recipe};
  const responseBody={recipeId:recipe,versionId:version,tasks:[]};
  const server=createRecipeServer({verify:async()=>identity,execute:async(...args)=>{calls.push(args);return responseBody;}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+`/v2/recipes/${recipe}/versions/${version}/task-summaries`;
  assert.equal((await fetch(url)).status,401);assert.deepEqual(calls,[]);
  const authorized=await fetch(url,{headers:{authorization:'Bearer test'}});
  assert.equal(authorized.status,200);assert.deepEqual(await authorized.json(),responseBody);
  assert.deepEqual(calls,[[identity,'richTaskSummaries',[recipe,version]]]);
  const queries=[];
  await richExecute({query:async(...args)=>{queries.push(args);return {rows:[{result:responseBody}]};}},'richTaskSummaries',[recipe,version]);
  assert.deepEqual(queries,[['select recipe_api.task_summaries($1,$2) as result',[recipe,version]]]);
});
test('public browse capability preserves old coded intro DTOs without changing authorization or fetching source',async t=>{
  const legacy=recipeBrowseDetailSchema.superRefine((value,ctx)=>{
    if(value.public.access==='coded'&&!value.owned&&!value.acquired&&(value.preview||value.previewUnavailable))
      ctx.addIssue({code:'custom',message:'Old client preview gate'});
  });
  const calls=[],base={recipeId:recipe,versionId:version,revision:1,format:'rich-v2',public:{name:'配方',summary:'',overview:'',version:'1',access:'coded'},
    creator:{authorId:recipe,displayName:'作者'},state:'listed',hasDisplayLogo:false,owned:false,acquired:false};
  let value;
  const server=createRecipeServer({verify:async()=>{throw Error('unexpected authentication');},execute:async(...args)=>{calls.push(args);return value;}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const path='http://127.0.0.1:'+server.address().port+`/v2/recipes/${recipe}/versions/${version}/preview`;
  const get=async capability=>{const response=await fetch(path,{headers:capability?{'X-Vonvon-Browse':capability}:{}});assert.equal(response.status,200);return response.json();};
  for(const display of [{preview:{settings:[],skills:[{itemId:version,name:'Skill',description:'公开用途'}],ruleCount:1,taskCount:1}},{previewUnavailable:true}]){
    value={...base,...display};
    assert.equal(legacy.safeParse(value).success,false,'the previous client really rejects the new coded projection');
    for(const capability of [undefined,'unknown','public-v2, public-v2'])assert.deepEqual(legacy.parse(await get(capability)),base);
    assert.deepEqual(await get('public-v2'),value);
    for(const relation of [{owned:true},{acquired:true}]){
      value={...base,...display,...relation};
      assert.deepEqual(legacy.parse(await get()),value);
    }
  }
  value={...base,public:{...base.public,access:'direct'},preview:{settings:[],skills:[],ruleCount:0,taskCount:0}};
  assert.deepEqual(legacy.parse(await get()),value);
  for(const state of ['withdrawn','blocked']){
    value={state,versionId:version};assert.deepEqual(await get('public-v2'),value);
  }
  assert.ok(calls.every(([identity,operation,args])=>identity===null&&operation==='richBrowsePreview'&&JSON.stringify(args)===JSON.stringify([recipe,version])));
});
test('browse negotiation leaves writes, receipts, raw detail and install responses exactly untouched',()=>{
  const value=Object.freeze({public:{access:'coded'},owned:false,acquired:false,preview:{skills:[]},previewUnavailable:true,
    config:{role:'RAW RESPONSE'},manifest:{objectId:recipe},receipt:{requestId:version}});
  const bytes=JSON.stringify(value);
  for(const operation of ['richPublish','richMetadata','publicationReceipt','metadataReceipt','richDetail','readerAcquire','richInstallPreview','readerRecipeGroups'])
    for(const header of [undefined,['public-v2'],['unknown']]){
      assert.equal(readerOutput({headersDistinct:{'x-vonvon-browse':header}},operation,value),value);
      assert.equal(JSON.stringify(value),bytes);
    }
});
