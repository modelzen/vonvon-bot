import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import sharp from 'sharp';
import {createRecipeServer} from '../src/http.mjs';
import {ApiError} from '../src/errors.mjs';

const subject='11111111-1111-4111-8111-111111111111';
async function fixture(t) {
  const calls=[];
  const server=createRecipeServer({admitRich:true,verify:async token=>{
    if(token!=='valid')throw new ApiError(401,'auth_required');
    return {issuer:'https://identity.invalid/auth/v1',subject};
  },execute:async(...args)=>{calls.push(args);return {authorId:subject,displayName:args[2][0]??'昵称', ...(['richAccountProfile','richAccountProfileRead','richAccountProfileInitialize'].includes(args[1])&&{revision:1})};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  return {calls,get:path=>fetch(base+path,{headers:{authorization:'Bearer valid'}}),post:(body,token='valid',path='/v2/me/account-profile')=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token&&{authorization:'Bearer '+token})},body:JSON.stringify(body)})};
}

test('profile accepts explicit nickname and avatar updates and normalizes raster uploads',async t=>{
  const f=await fixture(t);
  const bytes=await sharp({create:{width:320,height:120,channels:4,background:'red'}}).png().withMetadata().toBuffer();
  const res=await f.post({displayName:'  公开昵称  ',revision:0,avatar:{kind:'replace',base64:bytes.toString('base64')}});
  assert.equal(res.status,200);
  const [,operation,[name,action,data,revision]]=f.calls[0];
  assert.equal(operation,'richAccountProfile');assert.equal(name,'公开昵称');assert.equal(action,'replace');assert.equal(revision,0);
  assert.match(data,/^data:image\/webp;base64,/);
  const metadata=await sharp(Buffer.from(data.split(',')[1],'base64')).metadata();
  assert.deepEqual([metadata.format,metadata.width,metadata.height,metadata.exif],['webp',192,192,undefined]);
  for(const kind of ['keep','remove']){
    assert.equal((await f.post({displayName:'名字',revision:1,avatar:{kind}})).status,200);
    assert.deepEqual(f.calls.at(-1).slice(1),['richAccountProfile',['名字',kind,null,1]]);
  }
  assert.equal((await f.post({displayName:'旧版只改昵称'},'valid','/v2/me/profile')).status,200);
  assert.deepEqual(f.calls.at(-1).slice(1),['richProfile',['旧版只改昵称']]);
});

test('profile rejects remote URLs, document formats, malformed base64, invalid revisions and forged ownership',async t=>{
  const f=await fixture(t),valid={displayName:'昵称',revision:0};
  for(const body of [
    {...valid,accountId:subject},{...valid,avatarUrl:'https://example.invalid/avatar.png'},
    {...valid,avatar:{kind:'replace',url:'https://example.invalid/a'}},
    {...valid,avatar:{kind:'replace',base64:'YQ='}},
    {...valid,avatar:{kind:'replace',base64:Buffer.from('<svg/>').toString('base64')}},
    ...[-1,1.5,2147483648,'0',null].map(revision=>({...valid,revision})),
    ...['','@name','a\nb','a'.repeat(61)].map(displayName=>({...valid,displayName})),
  ]) assert.equal((await f.post(body)).status,422,JSON.stringify(body));
  assert.equal((await f.post(valid,null)).status,401);
  assert.deepEqual(f.calls,[]);
});

test('legacy profile GET and POST retain their exact response while modern reads use a distinct route',async t=>{
  const f=await fixture(t);
  const before=await f.get('/v2/me/profile');
  assert.deepEqual(await before.json(),{authorId:subject,displayName:'昵称'});
  assert.equal(f.calls.at(-1)[1],'richProfileRead');
  const saved=await f.post({displayName:'旧客户端昵称'},'valid','/v2/me/profile');
  assert.deepEqual(await saved.json(),{authorId:subject,displayName:'旧客户端昵称'});
  assert.equal(f.calls.at(-1)[1],'richProfile');
  const modern=await f.get('/v2/me/account-profile');
  assert.deepEqual(await modern.json(),{authorId:subject,displayName:'昵称',revision:1});
  assert.equal(f.calls.at(-1)[1],'richAccountProfileRead');
  assert.equal((await f.post({displayName:'不可混用',revision:1},'valid','/v2/me/profile')).status,422);
});

test('initialization uses only the authenticated account and canonicalizes recommended names',async t=>{
  const f=await fixture(t);
  const result=await f.post({displayName:'  Ｖｏｎｖｏｎ　　昵称 👩‍💻  '},'valid','/v2/me/account-profile/initialize');
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{authorId:subject,displayName:'Vonvon 昵称 👩‍💻',revision:1});
  assert.deepEqual(f.calls.at(-1).slice(1),['richAccountProfileInitialize',['Vonvon 昵称 👩‍💻']]);
  for(const body of [{displayName:'昵称',accountId:subject},{displayName:'昵称',revision:0},{displayName:'昵称',avatar:{kind:'remove'}},
    {displayName:'​隐形昵称'},{displayName:'冒名‮'}, {displayName:'＠不能变成邮箱'}, {displayName:'‍'}])
    assert.equal((await f.post(body,'valid','/v2/me/account-profile/initialize')).status,422);
  assert.equal((await f.post({displayName:'昵称'},null,'/v2/me/account-profile/initialize')).status,401);
  assert.equal(f.calls.length,1);
});
