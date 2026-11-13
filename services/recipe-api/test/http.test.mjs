import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
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
  assert.equal((await write('/v1/drafts','POST',{a:'x'.repeat(460_000)})).status,413);
  assert.equal(calls.length,3);
});

test('setup stores preparation text, with bounded steps and field-specific credential errors', async t => {
  const {write, calls} = await fixture(t);
  const context = {kind:'context', title:'准备项目', instructions:'选择已有的项目目录', required:true, check:'能看到项目说明'};
  const withSetup = setup => ({...draft, config:{...draft.config, setup}});
  const submit = setup => write('/v1/drafts', 'POST', withSetup(setup));
  assert.equal((await submit({steps:[context]})).status, 200);
  assert.deepEqual(calls[0][2][3].setup.steps, [context]);
  const boundary = {...context, title:'🧰'.repeat(80), instructions:'🧰'.repeat(512), check:'🧰'.repeat(128)};
  assert.equal((await submit({steps:Array(8).fill(boundary)})).status, 200);
  for (const invalid of [
    null, {steps:[]}, {steps:Array(9).fill(context)}, {steps:[null]}, {steps:'text'},
    {steps:[context], command:'prepare'},
    ...[{kind:'script'}, {title:boundary.title+'x'}, {instructions:boundary.instructions+'x'}, {check:boundary.check+'x'},
      {required:'true'}, {required:null}, {title:null}, {command:'prepare'}].map(change => ({steps:[{...context,...change}]})),
  ]) assert.equal((await submit(invalid)).status, 422);
  const credential = 'sb_secret_'+'a'.repeat(24);
  for (const field of ['title','instructions','check']) {
    const res = await submit({steps:[context, {...context,[field]:credential}]});
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), {error:{code:'credential_detected', field:'config.setup.steps.1.'+field}});
  }
  assert.equal(calls.length, 2);
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

async function oversizedUpload(t, base, chunked = false) {
  const url = new URL(base);
  const socket = createConnection({host:url.hostname, port:url.port});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const closed = new Promise(resolve => socket.once('close', resolve));
  const response = new Promise((resolve, reject) => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('data', chunk => {
      data += chunk;
      const index = data.indexOf('\r\n\r\n');
      if (index < 0) return;
      const length = /^Content-Length: (\d+)$/im.exec(data.slice(0, index));
      let payload = data.slice(index + 4);
      if (length) {
        if (Buffer.byteLength(payload) < Number(length[1])) return;
      } else {
        if (!payload.endsWith('0\r\n\r\n')) return;
        const pieces = [];
        while (payload !== '0\r\n\r\n') {
          const line = payload.indexOf('\r\n');
          const size = Number.parseInt(payload.slice(0, line), 16);
          pieces.push(payload.slice(line + 2, line + 2 + size));
          payload = payload.slice(line + 2 + size + 2);
        }
        payload = pieces.join('');
      }
      resolve({status:Number(data.slice(9, 12)), body:JSON.parse(payload)});
    });
    socket.once('end', () => reject(new Error('The upload socket ended before the JSON error completed')));
  });
  const body = Buffer.alloc(2 * 1024 * 1024, 'x');
  const firstSize = chunked ? 448 * 1024 + 1 : 64 * 1024;
  const frame = chunk => Buffer.concat([Buffer.from(chunk.length.toString(16) + '\r\n'), chunk, Buffer.from('\r\n')]);
  socket.write('POST /v1/drafts HTTP/1.1\r\nHost: ' + url.host + '\r\n' +
    'Authorization: Bearer valid\r\nContent-Type: application/json\r\nIdempotency-Key: ' + id + '\r\n' +
    (chunked ? 'Transfer-Encoding: chunked' : 'Content-Length: ' + body.length) + '\r\n\r\n');
  socket.write(chunked ? frame(body.subarray(0, firstSize)) : body.subarray(0, firstSize));
  return {socket, closed, response, finish:() => socket.end(chunked ?
    Buffer.concat([frame(body.subarray(firstSize)), Buffer.from('0\r\n\r\n')]) : body.subarray(firstSize))};
}

test('known-length and chunked uploads can read JSON 413 before the server closes the upload', {timeout:3_000}, async t => {
  const {base, write, calls} = await fixture(t);
  for (const chunked of [false, true]) {
    const upload = await oversizedUpload(t, base, chunked);
    const response = await upload.response;
    assert.equal(response.status, 413);
    assert.deepEqual(response.body, {error:{code:'payload_too_large'}});
    await delay(25);
    assert.equal(upload.socket.readableEnded, false);
    assert.equal(upload.socket.destroyed, false);
    upload.finish();
    await upload.closed;
  }
  assert.equal(calls.length, 0);
  assert.equal((await write('/v1/drafts', 'POST', draft)).status, 200);
  assert.equal(calls.length, 1);
});

test('a stalled rejected upload closes within a bounded wait and does not block another request', {timeout:3_000}, async t => {
  const {base, write, calls} = await fixture(t);
  const upload = await oversizedUpload(t, base);
  assert.equal((await upload.response).status, 413);
  assert.equal((await write('/v1/drafts', 'POST', draft)).status, 200);
  await upload.closed;
  assert.equal(calls.length, 1);
});
