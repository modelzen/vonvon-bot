import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM,VirtualConsole} from 'jsdom';
const html=await readFile(new URL('../public/login.html',import.meta.url),'utf8');
const source=await readFile(new URL('../public/native.mjs',import.meta.url),'utf8');
async function page(t, view, complete=false, {legacy=false,mode='app',route}={}) {
 const base=legacy?'/auth/native'+(complete?'/complete':''):mode==='app'?'/login?mode=app':'/login';
 const fragment=complete==='reload'?'':complete?'#receipt=receipt-fixture':'#ticket=ticket-fixture';
 const navigationErrors=[],virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>navigationErrors.push(error));
 const dom=new JSDOM(html,{url:'https://recipes.example'+(route??base+fragment),runScripts:'outside-only',virtualConsole});t.after(()=>dom.window.close());
 const {window}=dom,calls=[],timers=[];window.document.documentElement.dataset.loginMode=mode;let current=view;
 window.AbortSignal.timeout=()=>undefined;
 window.setTimeout=callback=>{timers.push(callback);return timers.length;};
 window.sessionStorage.setItem('vv-native-tab','bound-tab');
 window.fetch=async(path,options)=>{
  calls.push({path,options});
  if(path==='/auth/native/confirm')current={...current,status:'confirmed'};
  if(path==='/auth/native/switch')current={...current,status:'switching'};
  if(path==='/auth/native/cancel')current={...current,status:'cancelled'};
  return {ok:true,json:async()=>current};
 };
 await window.eval('(async()=>{'+source+'})()');
 return {window,document:window.document,calls,timers,navigationErrors,setView:value=>{current=value;}};
}
test('native login names the App destination and links first-party surfaces without inventing a signed-in identity',()=>{
 const dom=new JSDOM(html),doc=dom.window.document;
 assert.equal(doc.querySelector('#native-login-panel h1').textContent,'登录 Vonvon Bot App');
 assert.match(doc.querySelector('#native-login-panel').textContent,/完成登录后，回到 App 继续刚才的操作/);
 assert.deepEqual([...doc.querySelectorAll('.auth-promo figure img')].map(img=>img.getAttribute('src')),['/login-join.webp','/login-provider.webp','/login-product.webp']);
 assert.equal(doc.querySelector('header .brand').textContent,'Vonvon Bot');
 assert.equal(doc.querySelector('header .brand').getAttribute('href'),'__COMMUNITY_URL__');
 assert.equal(doc.querySelector('#site-account'),null);assert.equal(doc.querySelectorAll('header a,header button').length,1);
 assert.doesNotMatch(doc.querySelector('#native-login-panel').textContent,/注册或登录|当前网页账号|已登录为|允许访问您的/);
 assert.doesNotMatch(doc.querySelector('#login-help').textContent,/Apple/);
 dom.window.close();
});
test('provider choice is explicit, filters unknown providers and keeps tab binding on the existing request',async t=>{
 const p=await page(t,{status:'choosing',expiresAt:Date.now()+60000,providers:['github','unknown','google','apple']});
 assert.deepEqual([...p.document.querySelectorAll('#providers button')].map(button=>button.textContent),['使用 GitHub 登录','使用 Google 登录']);
 assert.equal(p.calls.length,1);assert.equal(p.calls[0].path,'/auth/native/launch');
 assert.equal(p.window.location.hash,'');
 p.document.querySelector('#providers button').click();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(p.calls.length,2);assert.equal(p.calls[1].path,'/auth/native/select');
 assert.equal(JSON.parse(p.calls[1].options.body).provider,'github');
 assert.equal(p.calls[1].options.headers['X-Vonvon-Native-Tab'],p.window.sessionStorage.getItem('vv-native-tab'));
});
test('native callback only starts identity verification and never confirms a connection automatically',async t=>{
 for(const [status,message] of [['ready','正在核对登录账号，请保留 App 中的登录窗口…'],['acknowledged','App 已确认登录，请回到 App 继续。']]) {
  const p=await page(t,{status,expiresAt:Date.now()+60000},true);
  assert.equal(p.document.querySelector('#status').textContent,message);
  assert.equal(p.document.querySelector('#providers').hidden,true);assert.equal(p.document.querySelector('#cancel').hidden,status==='acknowledged');
  assert.equal(p.document.querySelector('#native-identity').hidden,true);
  assert.equal(p.calls.length,1);assert.equal(p.calls[0].path,'/auth/native/complete');
  assert.deepEqual(JSON.parse(p.calls[0].options.body),{receipt:'receipt-fixture'});assert.equal(p.timers.length,status==='ready'?1:0);
  assert.equal(p.calls.some(call=>call.path==='/auth/native/confirm'),false);
 }
});

const identity={accountId:'11111111-1111-4111-8111-111111111111',displayName:'已验证的账号'};
test('reloading a completed callback resumes its bound confirmation without storing or reusing a receipt',async t=>{
 const p=await page(t,{status:'confirming',expiresAt:Date.now()+60000,identity},'reload');
 assert.equal(p.document.querySelector('#native-identity').hidden,false);
 assert.equal(p.document.querySelector('#native-name').textContent,identity.displayName);
 assert.deepEqual(p.calls.map(call=>call.path),['/auth/native/browser']);
 assert.equal(p.calls.some(call=>call.path==='/auth/native/confirm'),false);
 for(const status of ['choosing','selected','authorized']){
  const incomplete=await page(t,{status,expiresAt:Date.now()+60000,providers:['github']},'reload',{legacy:true});
  assert.equal(incomplete.document.querySelector('#native-identity').hidden,true);
  assert.match(incomplete.document.querySelector('#status').textContent,/授权未返回有效结果/);assert.equal(incomplete.document.querySelector('#cancel').hidden,false);
 }
});
test('only explicit Continue connects the verified identity and waits for App acknowledgement',async t=>{
 const p=await page(t,{status:'confirming',expiresAt:Date.now()+60000,identity},true);
 assert.equal(p.document.querySelector('#native-name').textContent,identity.displayName);
 assert.equal(p.document.querySelector('#native-account-id').textContent,identity.accountId);
 assert.equal(p.document.querySelector('#native-identity').hidden,false);
 assert.equal(p.calls.some(call=>call.path==='/auth/native/confirm'),false);
 p.document.querySelector('#native-confirm').click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(p.calls.at(-1).path,'/auth/native/confirm');
 assert.deepEqual(JSON.parse(p.calls.at(-1).options.body),{});
 assert.equal(p.document.querySelector('#native-decisions').hidden,true);
 assert.equal(p.document.querySelector('#cancel').hidden,true);
 assert.match(p.document.querySelector('#status').textContent,/等待 App 完成/);
 p.setView({status:'acknowledged',expiresAt:Date.now()+60000});await p.timers.shift()();
 assert.equal(p.document.querySelector('#native-identity').hidden,true);
 assert.equal(p.document.querySelector('#native-name').textContent,'');
});
test('switch and cancel discard the displayed identity without posting connection confirmation',async t=>{
 for(const [selector,path] of [['#native-switch','/auth/native/switch'],['#cancel','/auth/native/cancel']]){
  const p=await page(t,{status:'confirming',expiresAt:Date.now()+60000,identity},true);
  p.document.querySelector(selector).click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.calls.at(-1).path,path);assert.equal(p.calls.some(call=>call.path==='/auth/native/confirm'),false);
  assert.equal(p.document.querySelector('#native-name').textContent,'');assert.equal(p.document.querySelector('#native-identity').hidden,true);
 }
});
test('invalid identity fails closed and an expired flow clears its previously displayed identity',async t=>{
 const invalid=await page(t,{status:'confirming',expiresAt:Date.now()+60000,identity:{...identity,accountId:'invalid'}},true);
 assert.equal(invalid.document.querySelector('#native-identity').hidden,true);assert.match(invalid.document.querySelector('#status').textContent,/未能核对/);
 const p=await page(t,{status:'confirming',expiresAt:Date.now()+60000,identity},true);
 p.setView({status:'expired',expiresAt:Date.now()+60000});await p.timers.shift()();
 assert.equal(p.document.querySelector('#native-name').textContent,'');assert.match(p.document.querySelector('#status').textContent,/已过期/);
});
test('native login keeps cancellation and terminal states on the existing endpoints',async t=>{
 const p=await page(t,{status:'choosing',expiresAt:Date.now()+60000,providers:['github']});
 p.document.querySelector('#cancel').click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(p.calls[1].path,'/auth/native/cancel');
 for(const [status,word] of [['cancelled','登录已取消'],['expired','登录已过期'],['failed','登录未完成']]) {
  const state=await page(t,{status,expiresAt:Date.now()+60000});
  assert.match(state.document.querySelector('#status').textContent,new RegExp(word));
  assert.equal(state.timers.length,0);assert.equal(state.document.querySelector('#providers').hidden,true);
 }
});

test('Web mode native script is inert and leaves ordinary login fragments, fields and storage untouched',async t=>{
 const p=await page(t,{status:'choosing',expiresAt:Date.now()+60000,providers:['github']},false,{mode:'web'});
 assert.deepEqual(p.calls,[]);assert.equal(p.window.location.pathname,'/login');assert.equal(p.window.location.hash,'#ticket=ticket-fixture');assert.equal(p.document.querySelector('#providers').childElementCount,0);assert.equal(p.window.sessionStorage.getItem('vv-native-tab'),'bound-tab');
 p.document.querySelector('#native-confirm').click();assert.deepEqual(p.calls,[]);
});
test('native provider rows stay visible with unavailable choices disabled and unable to select',async t=>{
 for(const enabled of [[],['github'],['github','google'],['github','google','apple']]){
  const p=await page(t,{status:'choosing',expiresAt:Date.now()+60000,providers:enabled});const buttons=[...p.document.querySelectorAll('#providers button')];assert.equal(buttons.length,2);
  for(const [index,provider] of ['github','google'].entries()){
   assert.equal(buttons[index].type,'button');assert.equal(buttons[index].disabled,!enabled.includes(provider));
   if(!enabled.includes(provider)){assert.match(buttons[index].textContent,/暂不可用/);buttons[index].click();}
  }
  assert.doesNotMatch(p.document.querySelector('#providers').textContent,/Apple/);assert.deepEqual(p.calls.map(call=>call.path),['/auth/native/launch']);
 }
});
test('ticket and receipt fragments canonicalize to the same App-mode URL; legacy aliases remain functional',async t=>{
 for(const legacy of [false,true])for(const complete of [false,true]){
  const p=await page(t,{status:complete?'confirming':'choosing',identity,expiresAt:Date.now()+60000,providers:['github']},complete,{legacy});
  assert.equal(p.window.location.pathname,'/login');assert.equal(p.window.location.search,complete?'?mode=app&complete=1':'?mode=app');assert.equal(p.window.location.hash,'');
  assert.equal(p.calls[0].path,complete?'/auth/native/complete':'/auth/native/launch');
  assert.equal(p.calls.some(call=>call.path==='/auth/native/confirm'),false);
 }
 const resumed=await page(t,{status:'confirming',identity,expiresAt:Date.now()+60000},'reload');assert.equal(resumed.document.querySelector('#native-name').textContent,identity.displayName);assert.equal(resumed.calls[0].path,'/auth/native/browser');
});

test('empty and fragment-only OAuth error callbacks never replay authorization across polls or reloads',async t=>{
 const authorizeUrl='https://issuer.invalid/auth/v1/authorize?provider=github';
 for(const route of ['/login?mode=app&complete=1#','/login?mode=app&complete=1#error=access_denied&error_description=UNTRUSTED_DESCRIPTION','/auth/native/complete#error=access_denied']){
  const view={status:'authorized',authorizeUrl,providers:['github'],expiresAt:Date.now()+60000};
  const p=await page(t,view,false,{route});
  assert.equal(p.window.location.search,'?mode=app&complete=1');assert.equal(p.window.location.hash,'');
  assert.equal(p.document.querySelector('#providers').hidden,true);assert.equal(p.document.querySelector('#native-identity').hidden,true);assert.equal(p.document.querySelector('#cancel').hidden,false);
  assert.equal(p.document.querySelector('#status').textContent,'授权未返回有效结果。请取消本次登录，再回到 App 重试。');assert.doesNotMatch(p.document.body.textContent,/UNTRUSTED_DESCRIPTION/);
  for(let i=0;i<3;i++){await p.timers.shift()();assert.equal(p.document.querySelector('#cancel').hidden,false);}
  assert.deepEqual(p.calls.map(call=>call.path),Array(4).fill('/auth/native/browser'));assert.equal(p.navigationErrors.length,0);
  const reload=await page(t,view,'reload',{route:p.window.location.pathname+p.window.location.search});
  assert.match(reload.document.querySelector('#status').textContent,/授权未返回有效结果/);assert.equal(reload.navigationErrors.length,0);
  p.document.querySelector('#cancel').click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.calls.at(-1).path,'/auth/native/cancel');assert.equal(p.calls.at(-1).options.headers['X-Vonvon-Native-Tab'],'bound-tab');assert.deepEqual(JSON.parse(p.calls.at(-1).options.body),{});assert.match(p.document.querySelector('#status').textContent,/登录已取消/);
 }
});
test('a completion marker waits safely for ready identity and still permits explicit confirmation',async t=>{
 const p=await page(t,{status:'authorized',authorizeUrl:'https://issuer.invalid/authorize',expiresAt:Date.now()+60000},false,{route:'/login?mode=app&complete=1'});
 p.setView({status:'ready',expiresAt:Date.now()+60000});await p.timers.shift()();assert.match(p.document.querySelector('#status').textContent,/正在核对登录账号/);
 p.setView({status:'confirming',identity,expiresAt:Date.now()+60000});await p.timers.shift()();assert.equal(p.document.querySelector('#native-name').textContent,identity.displayName);
 assert.equal(p.calls.some(call=>call.path==='/auth/native/confirm'),false);p.document.querySelector('#native-confirm').click();await new Promise(resolve=>setImmediate(resolve));assert.equal(p.calls.at(-1).path,'/auth/native/confirm');assert.equal(p.navigationErrors.length,0);
});
test('incomplete authorization return still expires without another authorization request',async t=>{
 const p=await page(t,{status:'authorized',authorizeUrl:'https://issuer.invalid/authorize',expiresAt:Date.now()-1},false,{route:'/login?mode=app&complete=1'});
 await p.timers.shift()();assert.match(p.document.querySelector('#status').textContent,/登录已过期/);assert.equal(p.document.querySelector('#cancel').hidden,true);assert.equal(p.calls.length,1);assert.equal(p.navigationErrors.length,0);
});
