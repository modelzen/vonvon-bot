import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createRecipeServer} from '../src/http.mjs';
import {ApiError} from '../src/errors.mjs';

const requestId='d8706efa-ea64-4d82-bd7f-60f83ff13d23',draftId='17201760-02e9-4ef0-932f-1ccad2bed95e';
const identity={issuer:'https://creator-test.invalid/auth/v1',subject:draftId};
const hash='ab'.repeat(32),wire='cd'.repeat(32);
const metadata='/v2/receipts/metadata/'+requestId+'?draftId='+draftId+'&revision=2&baseManifestSha256='+hash+'&transformVersion=1&inputSha256='+hash;
const legacy='/v1/drafts/'+draftId+'/creator-context?revision=2';
const rich='/api/v2/drafts/'+draftId+'/creator-context?revision=2&contentSha256='+hash;

async function fixture(t){
  const calls=[],server=createRecipeServer({verify:async token=>{
    if(token!=='valid')throw new ApiError(401,'auth_required');
    return identity;
  },execute:async(...args)=>{calls.push(args);return {status:'unknown'};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  return {calls,get:(path,token='valid',method='GET')=>fetch(base+path,{method,headers:token?{authorization:'Bearer '+token}:{}})};
}

test('creator reads dispatch bounded authenticated GETs while rich writes are disabled',async t=>{
  const {calls,get}=await fixture(t),cases=[
    [metadata,'metadataReceipt',[requestId,draftId,2,hash,1,hash,null]],
    [metadata+'&wireSha256='+wire,'metadataReceipt',[requestId,draftId,2,hash,1,hash,wire]],
    [legacy,'creatorContext',['role-v1',draftId,2,null]],
    [rich,'creatorContext',['rich-v2',draftId,2,hash]],
  ];
  for(const [path,action,args] of cases){
    const response=await get(path);assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(calls.at(-1),[identity,action,args]);
    for(const token of [null,'expired'])assert.equal((await get(path,token)).status,401);
    for(const method of ['POST','PATCH','DELETE'])assert.equal((await get(path,'valid',method)).status,405);
  }
  assert.equal(calls.length,cases.length);
});

test('creator reads reject missing, duplicate, unbounded, and caller-selected bindings before SQL',async t=>{
  const {calls,get}=await fixture(t);
  const invalid=[
    ...['draftId='+draftId+'&','revision=2&','baseManifestSha256='+hash+'&','transformVersion=1&','&inputSha256='+hash].map(part=>metadata.replace(part,'')),
    ...['draftId='+draftId,'revision=2','baseManifestSha256='+hash,'transformVersion=1','inputSha256='+hash,'wireSha256='+wire+'&wireSha256='+wire].map(part=>metadata+'&'+part),
    metadata.replace('transformVersion=1','transformVersion=2'),metadata.replace('transformVersion=1','transformVersion=01'),
    metadata+'&wireSha256=',metadata+'&wireSha256='+wire.toUpperCase(),metadata.replace(hash,'x'.repeat(64)),
    metadata.replace(hash,hash.toUpperCase()),metadata+'&action=richMetadata',metadata+'&accountId='+draftId,
    legacy.replace('?revision=2',''),rich.replace('&contentSha256='+hash,''),legacy+'&contentSha256='+hash,
    rich+'&contentSha256='+hash,rich.replace(hash,hash.toUpperCase()),
    ...[metadata,legacy,rich].flatMap(path=>[
      path+'&revision=2',path+'&canonical=secret',path.replace(draftId,'invalid'),
      ...['0','-1','01','1.5','2147483648','99999999999999999999'].map(n=>path.replace('revision=2','revision='+n)),
    ]),
  ];
  for(const path of invalid){
    const response=await get(path);assert.equal(response.status,422,path);
    assert.deepEqual(await response.json(),{error:{code:'invalid_input'}});
  }
  assert.equal((await get(metadata.replace('/v2/','/v1/'))).status,404);
  assert.deepEqual(calls,[]);
});
