import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createRecipeServer} from '../src/http.mjs';
import {richExecute} from '../src/rich-database.mjs';

const author='11111111-1111-4111-8111-111111111111',cursor='22222222-2222-4222-8222-222222222222';
test('author pages allow anonymous reads with bounded UUID cursors while writes are disabled',async t=>{
  const calls=[],page={creator:{authorId:author,displayName:'作者'},items:[],nextCursor:null};
  const server=createRecipeServer({verify:async()=>{throw Error('unexpected authentication');},execute:async(...args)=>{calls.push(args);return page;}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const get=(path,method='GET')=>fetch('http://127.0.0.1:'+server.address().port+path,{method});
  for(const prefix of ['/v2','/api/v2']){
    const path=prefix+'/authors/'+author+'/recipes';
    assert.deepEqual(await (await get(path)).json(),page);
    assert.deepEqual(calls.at(-1),[null,'richAuthorRecipes',[author,null]]);
    assert.equal((await get(path+'?cursor='+cursor)).status,200);
    assert.deepEqual(calls.at(-1),[null,'richAuthorRecipes',[author,cursor]]);
    for(const query of ['?cursor=','?cursor=x','?cursor='+cursor+'&cursor='+cursor,'?limit=500','?accountId='+author,'?cursor='+('x'.repeat(1601))])assert.equal((await get(path+query)).status,422);
    for(const method of ['POST','PATCH','DELETE'])assert.equal((await get(path,method)).status,405);
  }
  assert.equal((await get('/v2/authors/invalid/recipes')).status,422);
  assert.equal(calls.length,4);
  const queries=[];
  assert.deepEqual(await richExecute({query:async(...args)=>{queries.push(args);return {rows:[{result:page}]};}},'richAuthorRecipes',[author,cursor]),page);
  assert.deepEqual(queries,[['select recipe_api.reader_author_recipes($1,$2) as result',[author,cursor]]]);
});
