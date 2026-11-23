import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createRecipeServer} from '../src/http.mjs';
import {richExecute} from '../src/rich-database.mjs';
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
