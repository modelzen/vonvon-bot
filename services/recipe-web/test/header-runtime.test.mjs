import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const source=await readFile(new URL('../public/header.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();await new Promise(setImmediate);};
async function runtime(t,{signedIn=true,path='/login',appOwned=false,signals=AbortSignal}={}){
  const dom=new JSDOM('<html data-account-url="https://accounts.example/account" data-library-url="/library"><body><div id="site-account"></div>'+(appOwned?'<button id="account"></button>':'')+'</body></html>',{url:'https://community.example'+path,pretendToBeVisual:true});t.after(()=>dom.window.close());
  const {window}=dom,state={signedIn,displaySession:'session-A',profile:{authorId:id,displayName:'真实网站昵称',avatarDataUrl:'data:image/webp;base64,YWJj'}},calls=[],broadcasts=[];let channel;
  const peers=[];class Broadcast {constructor(name){this.name=name;if(!channel)channel=this;peers.push(this);}postMessage(value){broadcasts.push(value);for(const peer of peers)if(peer!==this&&peer.name===this.name)queueMicrotask(()=>peer.onmessage?.({data:value}));}}
  const fetch=async(url,options={})=>{
    calls.push({url,options});
    if(url==='/auth/session')return Response.json({signedIn:state.signedIn,displaySession:state.displaySession});
    if(url==='/api/v2/me/account-profile'){
      if(options.headers['X-Vonvon-Session']!==state.displaySession)return Response.json({error:{code:'session_changed'}},{status:409});
      if(state.pending)return state.pending;
      if(state.profileError)return Response.json({error:{code:state.profileError===409?'session_changed':'unavailable'}},{status:state.profileError});
      return Response.json(state.profile);
    }
    if(url==='/auth/logout'){
      if(options.headers['X-Vonvon-Session']!==state.displaySession)return Response.json({error:{code:'session_changed'}},{status:409});
      assert.equal(options.method,'POST');if(options.signal?.aborted)throw new DOMException('aborted','AbortError');
      if(state.logoutPending)return state.logoutPending;if(state.logoutError)return new Response('unavailable',{status:503});
      state.signedIn=false;return new Response('signed out');
    }
    throw Error('Unexpected header request '+url);
  };
  await new AsyncFunction('document','window','location','fetch','BroadcastChannel','AbortSignal',source)(window.document,window,window.location,fetch,Broadcast,signals);await settle();
  return {window,document:window.document,state,calls,broadcasts,channel,peer:()=>new Broadcast('vv-recipe-auth'),host:window.document.querySelector('#site-account')};
}
test('anonymous non-app header links to ordinary login with fixed safe return path',async t=>{
  const h=await runtime(t,{signedIn:false,path:'/auth/native#ticket=not-forwarded'});
  assert.equal(h.host.querySelector('a').textContent,'登录');assert.equal(h.host.querySelector('a').getAttribute('href'),'/login?returnTo=%2Flibrary');
  assert.deepEqual(h.calls.map(x=>x.url),['/auth/session']);assert.deepEqual(h.broadcasts,['check']);assert.equal(h.host.querySelector('img'),null);
});
test('only a genuine guarded profile enables website menu/avatar and UUID-bound cross-origin account settings',async t=>{
  const h=await runtime(t);assert.equal(h.host.querySelector('summary').getAttribute('aria-label'),'网站账号菜单');assert.match(h.host.textContent,/真实网站昵称/);
  assert.equal(h.host.querySelector('img').getAttribute('src'),'data:image/webp;base64,YWJj');
  const settings=[...h.host.querySelectorAll('a')].find(x=>x.textContent==='账号设置');assert.equal(settings.href,'https://accounts.example/account#account='+id);
  assert.equal(h.host.querySelector('a').href,'https://community.example/library');assert.equal(h.calls.at(-1).options.headers['X-Vonvon-Session'],'session-A');
});
for(const status of [401,409,503])test('profile '+status+' clears identity and never enables unbound account settings',async t=>{
  const h=await runtime(t);h.state.profileError=status;h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  assert.doesNotMatch(h.host.textContent,/真实网站昵称/);assert.equal(h.host.querySelector('img'),null);assert.equal(h.host.querySelector('a[href*="accounts.example"]'),null);
  if(status===401)assert.equal(h.host.querySelector('a').textContent,'登录');else assert.equal(h.host.querySelector('button').textContent,'重新读取');
});
test('late profiles cannot cross sessions and refresh broadcasts only once at startup',async t=>{
  const h=await runtime(t);let release;h.state.pending=new Promise(resolve=>{release=resolve;});h.channel.onmessage({data:'check'});await settle();assert.equal(h.host.textContent,'');assert.equal(h.host.querySelector('a'),null);
  h.state.pending=null;h.state.displaySession='session-B';h.state.profile={authorId:other,displayName:'另一个网站账号'};h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  release(Response.json({authorId:id,displayName:'迟到的旧账号'}));await settle();assert.match(h.host.textContent,/另一个网站账号/);assert.doesNotMatch(h.host.textContent,/迟到的旧账号/);assert.deepEqual(h.broadcasts,['check']);
  assert.equal(h.host.querySelector('a[href*="accounts.example"]').hash,'#account='+other);
});
test('logout is explicit, guarded by displayed session and cannot sign out a newly switched website account',async t=>{
  const h=await runtime(t);h.state.displaySession='session-B';h.state.profile={authorId:other,displayName:'B账号'};
  h.host.querySelector('button').click();await settle();assert.equal(h.state.signedIn,true);assert.match(h.host.textContent,/B账号/);
  const first=h.calls.find(x=>x.url==='/auth/logout');assert.equal(first.options.headers['X-Vonvon-Session'],'session-A');
  h.host.querySelector('button').click();await settle();assert.equal(h.state.signedIn,false);assert.equal(h.host.querySelector('a').textContent,'登录');
  assert.ok(h.calls.filter(x=>x.url==='/auth/logout').every(x=>x.options.method==='POST'));assert.equal(h.calls.some(x=>x.url.startsWith('/auth/native')),false);
});
test('malformed profile cannot create fake identity/avatar or unsafe settings link',async t=>{
  const h=await runtime(t);
  for(const profile of [{authorId:'invalid',displayName:'伪造昵称'},{authorId:id,displayName:'真实昵称',avatarDataUrl:'https://outside.example/tracker'}, {authorId:id,displayName:''}]){
    h.state.profile=profile;const event=new h.window.Event('pageshow');Object.defineProperty(event,'persisted',{value:true});h.window.dispatchEvent(event);await settle();assert.equal(h.host.querySelector('details'),null);assert.equal(h.host.querySelector('img'),null);assert.equal(h.host.querySelector('button').textContent,'重新读取');
  }
});
test('app-owned headers receive no duplicate listeners, auth reads or menu',async t=>{
  const h=await runtime(t,{appOwned:true});assert.deepEqual(h.calls,[]);assert.equal(h.host.textContent,'');assert.deepEqual(h.broadcasts,[]);
});

test('invalid site configuration fails with reread rather than an unsafe menu',async t=>{
  const h=await runtime(t);h.document.documentElement.dataset.accountUrl='javascript:alert(1)';h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  assert.equal(h.host.querySelector('a'),null);assert.equal(h.host.querySelector('details'),null);assert.equal(h.host.querySelector('button').textContent,'重新读取');
});

test('logout creates a fresh action lease after the original profile read timeout expires',async t=>{
 const timers=[];const signals={any:values=>AbortSignal.any(values),timeout:()=>{const controller=new AbortController();timers.push(controller);return controller.signal;}};
 const h=await runtime(t,{signals});assert.equal(timers.length,1);timers[0].abort();
 const readSignal=h.calls.find(call=>call.url==='/api/v2/me/account-profile').options.signal;assert.equal(readSignal.aborted,true);
 h.host.querySelector('button').click();await settle();const logout=h.calls.find(call=>call.url==='/auth/logout');
 assert.ok(logout);assert.notEqual(logout.options.signal,readSignal);assert.equal(logout.options.headers['X-Vonvon-Session'],'session-A');
 assert.equal(h.state.signedIn,false);assert.equal(h.host.querySelector('a').textContent,'登录');assert.deepEqual(h.broadcasts,['check','check']);
});
test('successful logout broadcasts once so another same-page account panel clears private identity',async t=>{
 const h=await runtime(t);const panel=h.document.createElement('section');panel.textContent='旧私有账号资料';h.document.body.append(panel);
 const peer=h.peer();peer.onmessage=event=>{if(event.data==='check')panel.replaceChildren();};
 h.host.querySelector('button').click();await settle();assert.equal(panel.textContent,'');assert.deepEqual(h.broadcasts,['check','check']);
 h.window.dispatchEvent(new h.window.Event('focus'));await settle();assert.deepEqual(h.broadcasts,['check','check']);
});
test('failed and stale-generation logout responses never broadcast success',async t=>{
 const h=await runtime(t);h.state.logoutError=true;h.host.querySelector('button').click();await settle();assert.deepEqual(h.broadcasts,['check']);
 h.state.logoutError=false;h.window.dispatchEvent(new h.window.Event('focus'));await settle();let release;
 h.state.logoutPending=new Promise(resolve=>{release=resolve;});h.host.querySelector('button').click();await settle();
 h.state.displaySession='session-B';h.state.profile={authorId:other,displayName:'新的网页账号'};h.window.dispatchEvent(new h.window.Event('focus'));await settle();
 release(new Response('late success'));await settle();assert.deepEqual(h.broadcasts,['check']);assert.match(h.host.textContent,/新的网页账号/);
});
