import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const html=await readFile(new URL('../public/account.html',import.meta.url),'utf8');
const source=await readFile(new URL('../public/account.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const accountId='11111111-1111-4111-8111-111111111111',otherId='22222222-2222-4222-8222-222222222222';
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();await new Promise(setImmediate);};
async function runtime(t,{route='/account',signedIn=true,profileId=accountId,profileRevision=1,saveError,pendingExpected}={}){
  const dom=new JSDOM(html,{url:'https://recipes.example'+route,pretendToBeVisual:true});t.after(()=>dom.window.close());
  const {window}=dom,calls=[],copied=[];
  const state={signedIn,displaySession:signedIn?'session-A':null,profile:{authorId:profileId,displayName:'原昵称',revision:profileRevision},saveError};
  if(pendingExpected)window.sessionStorage.setItem('vv-account-login-expected',JSON.stringify({accountId:pendingExpected,expiresAt:Date.now()+60_000}));
  const fetch=async(path,options={})=>{
    calls.push({path,options});
    if(path==='/auth/session')return Response.json({signedIn:state.signedIn,displaySession:state.displaySession,providers:['github']});
    if(path==='/auth/logout'){state.signedIn=false;state.displaySession=null;return new Response('logout');}
    if(path==='/api/v2/me/account-profile/initialize'){
      assert.equal(options.headers['X-Vonvon-Session'],state.displaySession);
      state.profile={...state.profile,displayName:'Vonvon 用户',revision:1};return Response.json(state.profile);
    }
    if(path==='/api/v2/me/account-profile'){
      assert.equal(options.headers['X-Vonvon-Session'],state.displaySession);
      if(options.method==='POST'){
        if(state.savePromise)return state.savePromise;
        if(state.saveError)return Response.json({error:{code:state.saveError}},{status:409});
        const input=JSON.parse(options.body);state.profile={...state.profile,displayName:input.displayName,revision:state.profile.revision+1};
      }
      return Response.json(state.profile);
    }
    throw Error('Unexpected account request '+path);
  };
  const bitmap={width:192,height:192,close(){}};
  const run=new AsyncFunction('document','window','location','history','sessionStorage','navigator','fetch','BroadcastChannel','AbortSignal','FileReader','createImageBitmap',source);
  await run(window.document,window,window.location,window.history,window.sessionStorage,{clipboard:{writeText:async value=>copied.push(value)}},fetch,undefined,AbortSignal,window.FileReader,async()=>bitmap);
  const input=window.document.querySelector('#account-name');
  const fill=value=>{input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}));};
  const submit=async()=>{window.document.querySelector('#account-profile').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();};
  return {window,document:window.document,state,calls,copied,fill,submit,bitmap};
}

test('account login offers only enabled providers and keeps the App account comparison across OAuth',async t=>{
  const h=await runtime(t,{signedIn:false,route:'/account#account='+accountId});
  assert.equal(h.window.location.hash,'');
  assert.equal(h.document.querySelector('#account-profile').hidden,true);
  const form=h.document.querySelector('#account-providers form');
  assert.equal(form.action,'https://recipes.example/auth/start');assert.equal(form.querySelector('[name=returnTo]').value,'/account');
  assert.equal(h.document.querySelectorAll('#account-providers form').length,1);
  form.dispatchEvent(new h.window.Event('submit',{cancelable:true}));
  assert.equal(JSON.parse(h.window.sessionStorage.getItem('vv-account-login-expected')).accountId,accountId);
});
test('nickname saves use the current session revision and keep the same account ID',async t=>{
  const h=await runtime(t);
  assert.equal(h.document.querySelector('#account-profile').hidden,false);
  assert.equal(h.document.querySelector('label[for=account-name]').textContent,'昵称');
  assert.doesNotMatch(h.document.body.textContent,/作者署名|独立公开名称/);
  h.fill('新的昵称');await h.submit();
  const write=h.calls.find(x=>x.options.method==='POST');
  assert.deepEqual(JSON.parse(write.options.body),{displayName:'新的昵称',revision:1,avatar:{kind:'keep'}});
  assert.equal(h.document.querySelector('#account-id').value,accountId);
  assert.match(h.document.body.textContent,/个人资料已保存/);
  h.document.querySelector('#account-copy').click();await settle();assert.deepEqual(h.copied,[accountId]);
});
test('a taken nickname leaves the edit in place with a clear error',async t=>{
  const h=await runtime(t,{saveError:'nickname_taken'});h.fill('已占用昵称');await h.submit();
  assert.equal(h.document.querySelector('#account-name').value,'已占用昵称');
  assert.match(h.document.querySelector('#account-feedback').textContent,/这个昵称已被使用/);
  assert.doesNotMatch(h.document.body.textContent,/个人资料已保存/);
});
for(const sourceName of ['fragment','OAuth tab storage'])test('mismatched App account from '+sourceName+' blocks all editing',async t=>{
  const h=await runtime(t,{profileId:otherId,...(sourceName==='fragment'?{route:'/account#account='+accountId}:{pendingExpected:accountId})});
  assert.equal(h.document.querySelector('#account-profile').hidden,true);
  assert.equal(h.document.querySelector('#account-mismatch').hidden,false);
  assert.equal(h.document.querySelector('#account-name').value,'');
  assert.equal(h.calls.some(x=>x.options.method==='POST'),false);
});
test('a late save response from an old website account cannot overwrite the next account',async t=>{
  const h=await runtime(t);let release;
  h.state.savePromise=new Promise(resolve=>{release=resolve;});
  h.fill('旧账号在途昵称');await h.submit();
  h.state.displaySession='session-B';h.state.profile={authorId:otherId,displayName:'另一个账号',revision:2};
  h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  release(Response.json({authorId:accountId,displayName:'迟到的旧昵称',revision:2}));await settle();
  assert.equal(h.document.querySelector('#account-name').value,'另一个账号');
  assert.equal(h.document.querySelector('#account-id').value,otherId);
});
test('avatar dimensions are checked before upload and website logout does not call a third party',async t=>{
  const h=await runtime(t);h.bitmap.width=3000;
  const input=h.document.querySelector('#account-avatar');
  Object.defineProperty(input,'files',{value:[new h.window.File(['png'],'photo.png',{type:'image/png'})]});
  input.dispatchEvent(new h.window.Event('change',{bubbles:true}));await settle();
  assert.match(h.document.querySelector('#account-feedback').textContent,/2048 × 2048/);
  assert.equal(h.calls.some(x=>x.options.method==='POST'),false);
  h.document.querySelector('#account-logout').click();await settle();
  const exit=h.calls.find(x=>x.path==='/auth/logout');assert.equal(exit.options.headers['X-Vonvon-Session'],'session-A');
  assert.equal(h.document.querySelector('#account-login').hidden,false);
  assert.equal(h.calls.every(x=>x.path.startsWith('/')),true);
});

test('first website login initializes one shared nickname only after matching the App account ID',async t=>{
  const h=await runtime(t,{profileRevision:0,route:'/account#account='+accountId});
  const init=h.calls.find(x=>x.path.endsWith('/initialize'));assert.ok(init);
  assert.deepEqual(JSON.parse(init.options.body),{displayName:'Vonvon 用户'});
  assert.equal(h.document.querySelector('#account-name').value,'Vonvon 用户');
  assert.equal(h.document.querySelector('#account-profile').hidden,false);
  const wrong=await runtime(t,{profileId:otherId,profileRevision:0,route:'/account#account='+accountId});
  assert.equal(wrong.calls.some(x=>x.path.endsWith('/initialize')),false);
  assert.equal(wrong.document.querySelector('#account-profile').hidden,true);
});

test('website nickname validation matches normalized Unicode account names',async t=>{
  const h=await runtime(t);
  h.fill('👨‍👩‍👧‍👦');assert.equal(h.document.querySelector('#account-save').disabled,false);
  for(const value of ['abc\u202ebcd','\u200d','Ａ＠Ｂ','a'.repeat(61)]){h.fill(value);assert.equal(h.document.querySelector('#account-save').disabled,true,value);}
  h.fill('Ｃｌａｙ　　Ｘ');await h.submit();
  const write=h.calls.find(x=>x.options.method==='POST');assert.equal(JSON.parse(write.options.body).displayName,'Clay X');
});

test('Unicode Hangul fillers cannot be used alone or hidden inside visible nicknames',async t=>{
  const h=await runtime(t);
  for(const value of ['Clay\u3164','\u3164','Clay\uffa0','\uffa0','Clay\u115f','\u115f']){
    h.fill(value);assert.equal(h.document.querySelector('#account-save').disabled,true,JSON.stringify(value));
    await h.submit();
  }
  assert.equal(h.calls.some(x=>x.options.method==='POST'),false);
  h.fill('👨‍👩‍👧‍👦');assert.equal(h.document.querySelector('#account-save').disabled,false);
});
test('a reused account tab clears the old form and checks a newly supplied App account hash',async t=>{
  const h=await runtime(t,{route:'/account#account='+accountId});
  assert.equal(h.document.querySelector('#account-profile').hidden,false);
  h.window.location.hash='account='+otherId;
  h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange'));
  assert.equal(h.document.querySelector('#account-profile').hidden,true);
  assert.equal(h.document.querySelector('#account-name').value,'');
  await settle();
  assert.equal(h.window.location.hash,'');
  assert.equal(h.document.querySelector('#account-profile').hidden,true);
  assert.equal(h.document.querySelector('#account-mismatch').hidden,false);
  assert.equal(h.window.history.state.accountExpected,otherId);
});
test('a malformed App account hash in a reused tab fails closed before another API request',async t=>{
  const h=await runtime(t);const before=h.calls.length;
  h.window.location.hash='account=invalid';
  h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange'));
  assert.equal(h.document.querySelector('#account-profile').hidden,true);
  await settle();
  assert.equal(h.calls.length,before);
  assert.match(h.document.querySelector('#account-status').textContent,/链接不完整/);
});
