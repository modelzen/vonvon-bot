import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { boundedObjectBytes, createPrivateStorage } from '../src/object-storage.mjs';

test('private adapter uses exact create-only keys, authenticated reads, no redirects and independent absence confirmation',async()=>{
  const requests=[], id=randomUUID(), key='final/'+id;
  let response, absent=false;
  const storage=createPrivateStorage({origin:'https://storage.example',bucket:'recipe-private',apiKey:'fake',bearer:'fixture',
    verifyAbsent:async(bucket,k)=>{ assert.deepEqual([bucket,k],['recipe-private',key]); return absent; },
    fetchImpl:async(url,options)=>{requests.push({url,options});return response;}});
  response=new Response('{}');
  await storage.create(id,'final',Buffer.from('payload'));
  assert.equal(requests[0].url.pathname,'/storage/v1/object/recipe-private/'+key);
  assert.equal(requests[0].options.headers['x-upsert'],'false');
  assert.equal(requests[0].options.method,'POST');
  assert.equal(requests[0].options.redirect,'manual');
  response=new Response('payload');
  assert.equal((await storage.read(id,'final',7)).toString(),'payload');
  assert.equal(requests[1].url.pathname,'/storage/v1/object/authenticated/recipe-private/'+key);
  assert.equal(requests[1].options.headers.authorization,'Bearer fixture');
  response=Response.json({code:'NoSuchKey'},{status:404});
  await assert.rejects(storage.read(id,'final',7),/object_storage_unavailable/);
  absent=true;
  response=Response.json({code:'NoSuchKey'},{status:404});
  assert.equal(await storage.read(id,'final',7),null);
  response=Response.json({code:'NoSuchBucket'},{status:404});
  await assert.rejects(storage.read(id,'final',7),/object_storage_unavailable/);
  const beforeRedirect = requests.length;
  response=Response.redirect('https://different.example/',307);
  await assert.rejects(storage.read(id,'final',7),/object_storage_unavailable/);
  assert.equal(requests.length,beforeRedirect+1);
  response=new Response('abcdefgh');
  await assert.rejects(storage.read(id,'final',7),/object_too_large/);
  response=new Response('{}');
  await storage.remove(id,'final');
  assert.equal(requests.at(-1).options.method,'DELETE');
  await assert.rejects(storage.create('../x','temp',Buffer.alloc(1)),/invalid_object_key/);
});
test('ingress enforces streamed limits and aborts a stalled source',async()=>{
  assert.equal((await boundedObjectBytes(new Response('test').body,4)).toString(),'test');
  await assert.rejects(boundedObjectBytes(new Response('test').body,3),/object_too_large/);
  const hold=new AbortController();
  const hanging=boundedObjectBytes(new ReadableStream({}),2,hold.signal);
  hold.abort(); await assert.rejects(hanging);
});
