import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createObjectBroker } from '../src/object-broker.mjs';
import { createObjectStore } from '../src/object-store.mjs';

const actor='019a0011-abcd-7abc-8123-abcdef012345';
const operation='019a0012-abcd-7abc-8123-abcdef012345';
const body=Buffer.from('member');
const member={ordinal:0,kind:'text',bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')};

test('invalid object member identity fails before acquiring a pool client or entering work',async () => {
  let connections=0, work=0;
  const store=await createObjectStore({waitingCount:0,
    async query() { return {rows:[{dedicated:true}]}; },
    async connect() { connections++; throw new Error('unexpected_pool_acquisition'); },
  });
  const invalid=e=>e.status===422 && e.code==='invalid_object_member';
  const malformedIds=['not-a-uuid',actor.replaceAll('-',''),'{'+actor+'}',actor+'\n',actor+'\r\n',
    ' '+actor,actor+' ',null,0,[actor],{toString:()=>actor}];
  const badScopes=[...malformedIds.map(value=>[value,operation,0]),
    ...malformedIds.map(value=>[actor,value,0]),
    ...['0','00','0.0',null,-1,66,0.5,NaN,Infinity,2147483648].map(value=>[actor,operation,value])];
  for (const scope of badScopes) {
    await assert.rejects(store.withMember(...scope,async ()=>{work++;}),invalid);
  }
  const broker=createObjectBroker({store,storage:{}});
  for (const [owner,id,ordinal] of badScopes) {
    await assert.rejects(broker.receive(owner,id,{...member,ordinal},body),invalid);
    await assert.rejects(broker.reconcileQuiescent(owner,id,ordinal,'temp','0'.repeat(64)),invalid);
  }
  for (const value of malformedIds) {
    await assert.rejects(broker.collect(value,operation),invalid);
    await assert.rejects(broker.collect(actor,value),invalid);
  }
  assert.equal(connections,0);
  assert.equal(work,0);
});
