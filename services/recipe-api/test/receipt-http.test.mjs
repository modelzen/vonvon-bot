import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createRecipeServer} from '../src/http.mjs';
import {ApiError} from '../src/errors.mjs';

const requestId='d8706efa-ea64-4d82-bd7f-60f83ff13d23';
const targetId='17201760-02e9-4ef0-932f-1ccad2bed95e';
const identity={issuer:'https://receipt-test.invalid/auth/v1',subject:targetId};
const hash='ab'.repeat(32);
const paths=[
  ['/v1/receipts/publications/'+requestId+'?draftId='+targetId+'&revision=2','publicationReceipt',['role-v1',requestId,targetId,2,null]],
  ['/api/v2/receipts/publications/'+requestId+'?draftId='+targetId+'&revision=2&contentSha256='+hash,'publicationReceipt',['rich-v2',requestId,targetId,2,hash]],
  ['/v1/receipts/code-issuance/'+requestId+'?versionId='+targetId+'&count=3','codeIssuanceReceipt',[requestId,targetId,3]],
];

async function fixture(t){
  const calls=[];
  const server=createRecipeServer({verify:async token=>{
    if(token!=='valid')throw new ApiError(401,'auth_required');
    return identity;
  },execute:async(...args)=>{calls.push(args);return {status:'unknown'};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  return {calls,get:(path,token='valid',method='GET')=>fetch(base+path,{method,headers:token?{authorization:'Bearer '+token}:{}})};
}

test('receipt readers accept only authenticated GETs and exact typed argument bindings with writes disabled',async t=>{
  const {calls,get}=await fixture(t);
  for(const [path,operation,args] of paths){
    const response=await get(path);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(await response.json(),{status:'unknown'});
    assert.deepEqual(calls.at(-1),[identity,operation,args]);
    for(const token of [null,'expired']){
      const denied=await get(path,token);assert.equal(denied.status,401);
      assert.equal(denied.headers.get('www-authenticate'),'Bearer');
    }
    for(const method of ['POST','PATCH','DELETE'])assert.equal((await get(path,'valid',method)).status,405);
  }
  assert.equal(calls.length,3);
});

test('receipt reader boundaries reject missing, duplicate, unbounded and caller-selected fields before SQL',async t=>{
  const {calls,get}=await fixture(t);
  const legacy=paths[0][0],rich=paths[1][0],batch=paths[2][0];
  const invalid=[
    legacy.replace('&revision=2',''),legacy.replace('draftId='+targetId+'&',''),
    legacy+'&draftId='+targetId,legacy+'&revision=2',legacy+'&action=publish',legacy+'&digest='+hash,
    legacy+'&accountId='+targetId,legacy+'&canonical=secret',legacy+'&contentSha256='+hash,
    rich.replace('&contentSha256='+hash,''),rich+'&contentSha256='+hash,
    rich.replace(hash,hash.toUpperCase()),rich.replace(hash,'x'.repeat(64)),
    batch.replace('&count=3',''),batch.replace('versionId='+targetId+'&',''),batch+'&count=3',batch+'&action=issue',
    ...['0','-1','01','1.5','2147483648','99999999999999999999'].map(n=>legacy.replace('revision=2','revision='+n)),
    ...['0','-1','01','1.5','101','99999999999999999999'].map(n=>batch.replace('count=3','count='+n)),
    ...paths.map(([path])=>path.replace(requestId,'invalid')),
  ];
  for(const path of invalid){
    const response=await get(path);assert.equal(response.status,422,path);
    assert.deepEqual(await response.json(),{error:{code:'invalid_input'}});
  }
  assert.equal((await get('/v2/receipts/code-issuance/'+requestId+'?versionId='+targetId+'&count=3')).status,404);
  assert.equal((await get('/v1/receipts/arbitrary/'+requestId)).status,404);
  assert.deepEqual(calls,[]);
});
