import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {returnPath} from '../auth.mjs';
const html=(await readFile(new URL('../public/creators.html',import.meta.url),'utf8')).replaceAll('__COMMUNITY_URL__','https://community.example/').replaceAll('__CREATORS_URL__','/creators').replaceAll('__ACCOUNT_URL__','/account').replaceAll('__RECIPE_CREATE_URL__','vonvon-preview://recipes/create').replaceAll('__DESKTOP_CHANNEL__','preview');
const source=await readFile(new URL('../public/creators.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const id='11111111-1111-4111-8111-111111111111',version='22222222-2222-4222-8222-222222222222';
const item={recipeId:id,versionId:version,draftId:id,revision:2,public:{name:'我的作品',summary:'公开简介',version:'v2',access:'coded'},creator:{displayName:'当前昵称'},config:{role:'PRIVATE FULL BODY'}};
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();await new Promise(setImmediate);};
async function runtime(t,{signedIn=true}={}){
  const dom=new JSDOM(html,{url:'https://creators.example/creators',pretendToBeVisual:true});t.after(()=>dom.window.close());
  const {window}=dom,state={signedIn,displaySession:'session-A',profile:{authorId:id,displayName:'真实昵称',avatarDataUrl:'data:image/webp;base64,YWJj'},published:[item],drafts:[item]},calls=[],broadcasts=[];
  let channel;class Broadcast {constructor(){channel=this;}postMessage(value){broadcasts.push(value);}}
  const fetch=async(path,options={})=>{
    calls.push({path,options});
    if(path==='/auth/session')return Response.json({signedIn:state.signedIn,displaySession:state.displaySession});
    assert.equal(options.headers['X-Vonvon-Session'],state.displaySession);
    if(path==='/api/v2/me/account-profile'){if(state.profilePending)return state.profilePending;if(state.profileError)return Response.json({error:{code:'unavailable'}},{status:state.profileError});return Response.json(state.profile);}
    if(state.pending)return state.pending;
    if(state.error)return Response.json({error:{code:state.error.code}},{status:state.error.status});
    if(path==='/api/v2/me/publications')return Response.json({items:state.published});
    if(path==='/api/v2/me/drafts')return Response.json({items:state.drafts});
    throw Error('Unexpected request '+path);
  };
  await new AsyncFunction('document','window','location','fetch','BroadcastChannel','AbortSignal',source)(window.document,window,window.location,fetch,Broadcast,AbortSignal);
  await settle();return {window,document:window.document,state,calls,broadcasts,channel,choose:async tab=>{window.document.querySelector('[data-tab='+tab+']').click();await settle();}};
}
test('anonymous center links independent login and trusted App creation without requesting private data',async t=>{
  const h=await runtime(t,{signedIn:false});
  assert.equal(h.document.querySelector('#creators-login').hidden,false);assert.equal(h.document.querySelector('#creators-account').textContent,'登录');assert.equal(h.document.querySelector('#creators-account').getAttribute('href'),'/login?returnTo=%2Fcreators');assert.equal(h.document.querySelector('#creators-list').textContent,'');
  assert.equal(h.document.querySelector('#creators-login a').getAttribute('href'),'/login?returnTo=%2Fcreators');
  assert.equal(h.document.querySelector('[data-create-recipe]').getAttribute('href'),'vonvon-preview://recipes/create');
  assert.deepEqual(h.calls.map(x=>x.path),['/auth/session']);assert.equal(returnPath('/creators'),'/creators');assert.equal(returnPath('/creators?q=private'),'/');
});
test('chosen tab alone reads real guarded metadata and uses safe community and explicit App links',async t=>{
  const h=await runtime(t);assert.equal(h.document.querySelectorAll('.creator-row').length,1);
  assert.equal(h.calls.filter(x=>x.path.startsWith('/api/')).length,2);assert.equal(h.calls.at(-1).path,'/api/v2/me/publications');
  const account=h.document.querySelector('#creators-account');assert.equal(account.textContent,'真实昵称');assert.equal(new URL(account.href).hash,'#account='+id);assert.ok(account.querySelector('img'));
  assert.match(h.document.querySelector('.creator-row').textContent,/当前昵称/);assert.match(h.document.querySelector('.creator-row').textContent,/需获取码/);
  assert.equal(h.document.querySelector('.creator-row>.secondary').href,'https://community.example/recipes/'+id+'/versions/'+version+'?from=creator');
  assert.equal(new URL(h.document.querySelector('.creator-meta a').href).searchParams.get('q'),'当前昵称');
  await h.choose('drafts');assert.equal(h.calls.at(-1).path,'/api/v2/me/drafts');
  assert.equal(h.document.querySelector('.creator-row>.secondary').getAttribute('href'),'/open/draft#'+id+'?revision=2');
  assert.doesNotMatch(h.document.body.textContent,/PRIVATE FULL BODY/);
  assert.ok(h.calls.every(x=>!x.options.method||x.options.method==='GET'));assert.ok(h.calls.every(x=>!x.path.includes('/drafts/')));
  assert.equal(h.document.querySelector('[data-tab=drafts]').getAttribute('aria-selected'),'true');
});
test('session change clears rows immediately and late old private responses cannot cross accounts',async t=>{
  const h=await runtime(t);let release;h.state.pending=new Promise(resolve=>{release=resolve;});
  h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  assert.equal(h.document.querySelector('#creators-list').textContent,'');
  h.state.pending=null;h.state.displaySession='session-B';h.state.published=[{...item,public:{...item.public,name:'另一个账号的作品'},creator:{displayName:'新账号'}}];
  h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  release(Response.json({items:[{...item,public:{...item.public,name:'迟到的旧账号作品'}}]}));await settle();
  assert.match(h.document.querySelector('#creators-list').textContent,/另一个账号的作品/);assert.doesNotMatch(h.document.body.textContent,/迟到的旧账号作品/);
});
for(const error of [{status:401,code:'login_required'},{status:409,code:'session_changed'}])test('private '+error.status+' removes old rows and offers safe recovery',async t=>{
  const h=await runtime(t);h.state.error=error;h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  assert.equal(h.document.querySelector('#creators-list').textContent,'');assert.equal(h.document.querySelector('#creators-login').hidden,error.status!==401);assert.equal(h.document.querySelector('#creators-retry').hidden,error.status===401);
});
test('a tab switch discards late publication reads and invalid draft links never render',async t=>{
  const h=await runtime(t);let release;h.state.pending=new Promise(resolve=>{release=resolve;});h.window.dispatchEvent(new h.window.Event('focus'));await settle();h.state.pending=null;
  await h.choose('drafts');release(Response.json({items:[{...item,public:{...item.public,name:'迟到的发布列表'}}]}));await settle();assert.doesNotMatch(h.document.body.textContent,/迟到的发布列表/);
  h.state.drafts=[{...item,draftId:'javascript:alert(1)'}];h.window.dispatchEvent(new h.window.Event('focus'));await settle();assert.equal(h.document.querySelector('#creators-list').textContent,'');assert.equal(h.document.querySelector('#creators-retry').hidden,false);
});

test('startup broadcasts once and remote account changes clear old cards/header before refreshing',async t=>{
  const h=await runtime(t);assert.deepEqual(h.broadcasts,['check']);let release;
  h.state.pending=new Promise(resolve=>{release=resolve;});h.state.profilePending=new Promise(()=>{});
  h.state.displaySession='session-B';h.channel.onmessage({data:'check'});await settle();
  assert.equal(h.document.querySelector('#creators-list').textContent,'');assert.equal(h.document.querySelector('#creators-account').textContent,'账号');assert.equal(h.document.querySelector('#creators-account').hasAttribute('href'),false);assert.equal(h.document.querySelector('#creators-account').getAttribute('aria-disabled'),'true');
  release(Response.json({items:[]}));await settle();assert.deepEqual(h.broadcasts,['check']);
});
test('unavailable profile leaves the list usable and never invents a header identity',async t=>{
  const h=await runtime(t);h.state.profileError=503;h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  assert.equal(h.document.querySelectorAll('.creator-row').length,1);assert.equal(h.document.querySelector('#creators-account').textContent,'账号');assert.equal(h.document.querySelector('#creators-account').hasAttribute('href'),false);assert.equal(h.document.querySelector('#creators-account').getAttribute('aria-disabled'),'true');
});
test('a late old header profile cannot overwrite the next account or resurrect cleared private rows',async t=>{
  const h=await runtime(t);let release;
  h.state.profilePending=new Promise(resolve=>{release=resolve;});h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  h.state.profilePending=null;h.state.displaySession='session-B';h.state.profile={authorId:version,displayName:'下一个账号'};
  h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  release(Response.json({authorId:id,displayName:'迟到的旧昵称'}));await settle();
  assert.equal(h.document.querySelector('#creators-account').textContent,'下一个账号');assert.equal(new URL(h.document.querySelector('#creators-account').href).hash,'#account='+version);
  h.state.profileError=401;h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  assert.equal(h.document.querySelector('#creators-list').textContent,'');assert.equal(h.document.querySelector('#creators-account').textContent,'登录');
});

test('account settings stay inactive until the guarded profile binds the expected account',async t=>{
  const h=await runtime(t);let release;
  h.state.profilePending=new Promise(resolve=>{release=resolve;});h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  const account=h.document.querySelector('#creators-account');assert.equal(account.hasAttribute('href'),false);assert.equal(account.getAttribute('aria-disabled'),'true');assert.equal(account.tabIndex,-1);assert.equal(h.document.querySelector('[data-creators-account]').hasAttribute('href'),false);assert.equal(h.document.querySelectorAll('.creator-row').length,1);
  release(Response.json({authorId:id,displayName:'已确认账号'}));await settle();
  assert.equal(new URL(account.href).hash,'#account='+id);assert.equal(account.hasAttribute('aria-disabled'),false);assert.equal(account.hasAttribute('tabindex'),false);
});
