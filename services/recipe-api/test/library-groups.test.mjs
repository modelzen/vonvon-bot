import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createRecipeServer} from '../src/http.mjs';

const recipe='11111111-1111-4111-8111-111111111111',cursor='abcd.'+'a'.repeat(64);
test('personal recipe grouping is authenticated, read-only and accepts only bounded scope-bound cursor data',async t=>{
  const calls=[],identity={issuer:'https://identity.example',subject:recipe},page={items:[],nextCursor:null};
  const server=createRecipeServer({verify:async()=>identity,execute:async(...args)=>{calls.push(args);return page;}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const get=(path,method='GET',auth=true)=>fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:auth?{Authorization:'Bearer test'}:{}});
  for(const prefix of ['/v2','/api/v2'])for(const [suffix,operation,ids] of [['','readerRecipeGroups',[]],['/'+recipe+'/versions','readerRecipeGroupVersions',[recipe]]]){
    const path=prefix+'/me/recipe-groups'+suffix;
    for(const scope of ['all','acquired','published']){
      assert.deepEqual(await (await get(path+'?scope='+scope)).json(),page);
      assert.deepEqual(calls.at(-1),[identity,operation,[...ids,scope,null]]);
    }
    assert.equal((await get(path+'?scope=all&cursor='+cursor)).status,200);
    assert.deepEqual(calls.at(-1),[identity,operation,[...ids,'all',cursor]]);
    for(const query of ['', '?scope=', '?scope=other', '?scope=all&scope=all','?scope=all&limit=1000','?scope=all&accountId='+recipe,
      '?scope=all&cursor=','?scope=all&cursor='+recipe,'?scope=all&cursor='+cursor+'&cursor='+cursor,'?scope=all&cursor='+('a'.repeat(1601))])
      assert.equal((await get(path+query)).status,422);
    for(const method of ['POST','DELETE','PATCH'])assert.equal((await get(path+'?scope=all',method)).status,405);
    assert.equal((await get(path+'?scope=all','GET',false)).status,401);
  }
  assert.equal((await get('/v2/me/recipe-groups/invalid/versions?scope=all')).status,422);
  assert.equal(calls.length,16);
});
