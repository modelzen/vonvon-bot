import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRecipeServer } from '../src/http.mjs';
import { ApiError } from '../src/errors.mjs';

const id = 'd8706efa-ea64-4d82-bd7f-60f83ff13d23';
const author = '17201760-02e9-4ef0-932f-1ccad2bed95e';
const draft = {public:{name:'开发晨报',summary:'工作日报',version:'1',overview:'',access:'coded'},config:{role:'团队助手'}};

async function fixture(t, execute) {
  const calls = [];
  const server = createRecipeServer({ verify: async token => {
    if (token !== 'valid') throw new ApiError(401,'auth_required');
    return author;
  }, execute: async (...params) => { calls.push(params); return execute ? execute(...params) : {}; } });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const write = (url, method, body, extra={}) => fetch(base + url, {method,
    headers:{Authorization:'Bearer valid','Content-Type':'application/json','Idempotency-Key':id,...extra},
    body:JSON.stringify(body)});
  return {base,write,calls};
}

test('public routes distinguish a visitor from an expired supplied credential', async t => {
  const {base,calls} = await fixture(t);
  assert.equal((await fetch(base + '/api/v1/community/recipes?q=日报')).status,200);
  assert.deepEqual(calls[0],[null,'catalog',['日报',null]]);
  const locked = await fetch(base + '/v1/community/recipes', {headers:{authorization:'Bearer expired'}});
  assert.equal(locked.status,401);
  assert.match(locked.headers.get('cache-control'),/no-store/);
  assert.equal((await fetch(base + '/v1/me/recipes')).status,401);
  assert.equal(calls.length,1);
});

test('draft writes validate and preserve operation identity and revision',async t => {
  const {write,calls} = await fixture(t);
  assert.equal((await write('/v1/drafts','POST',draft)).status,200);
  assert.deepEqual(calls[0],[author,'saveDraft',[id,0,draft.public,draft.config,id,null,null]]);
  const editUrl = '/v1/drafts/' + id;
  assert.equal((await write(editUrl,'PATCH',draft)).status,428);
  assert.equal((await write(editUrl,'PATCH',draft,{'If-Match':'"2"'})).status,200);
  assert.equal(calls[1][2][1],2);
  assert.equal((await write('/v1/drafts','POST',{...draft,recipeId:id,sourceVersionId:author})).status,200);
  assert.deepEqual(calls.at(-1)[2].slice(-2),[id,author]);
  for (const bad of [{...draft,recipeId:id},{...draft,sourceVersionId:author},{...draft,accountId:author},{...draft,config:{...draft.config,token:'secret'}},
    {...draft,public:{...draft.public,name:'长'.repeat(61)}},{...draft,public:{...draft.public,overview:'好'.repeat(11000)}}]) {
    assert.equal((await write('/v1/drafts','POST',bad)).status,422);
  }
  assert.equal((await write('/v1/drafts','POST',{a:'x'.repeat(350_000)})).status,413);
  assert.equal(calls.length,3);
});

test('invalid share attempts are bounded and rejected requests do not execute SQL', async t => {
  const {write,calls} = await fixture(t, () => { throw new ApiError(422,'invalid_code'); });
  const url='/v1/versions/'+id+'/redeem';
  for (let i=0;i<10;i++) assert.equal((await write(url,'POST',{code:'TEST-CODE'})).status,422);
  const limited = await write(url,'POST',{code:'TEST-CODE'});
  assert.equal(limited.status,429);
  assert.ok(Number(limited.headers.get('retry-after'))>0);
  assert.equal(calls.length,10);
});

test('credential-shaped text is rejected by field, including code-gated content', async t => {
  const {write,calls} = await fixture(t);
  const marker = 'sb_secret_' + 'a'.repeat(24);
  for (const [group,field] of [['public','overview'],['config','role']]) {
    const body = {...draft, [group]:{...draft[group],[field]:'请使用 '+marker}};
    const response = await write('/v1/drafts','POST',body);
    assert.equal(response.status,422);
    assert.deepEqual(await response.json(),{error:{code:'credential_detected',field:group+'.'+field}});
  }
  assert.equal(calls.length,0);
  // A benign example, SHA or identifier embedded in a document can still be published.
  const ok = await write('/v1/drafts','POST',{...draft,config:{role:'使用 Git SHA '+'ab'.repeat(20)}});
  assert.equal(ok.status,200);
});
