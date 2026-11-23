import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=await readFile(new URL('../public/login.html',import.meta.url),'utf8');
const source=await readFile(new URL('../public/login.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const id='11111111-1111-4111-8111-111111111111',path='/recipes/'+id+'/versions/'+id;
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();await new Promise(setImmediate);};
async function runtime(t,{signedIn=false,providers=['github','google'],returnTo='/creators',pending,error=false,profileError,mode='web',route='/login'}={}){
  const markup=html.replaceAll('__LOGIN_RETURN_TO__',encodeURIComponent(returnTo)).replaceAll('__LOGIN_ERROR__',String(error)).replaceAll('__COMMUNITY_URL__','/').replaceAll('__LIBRARY_URL__','/library').replaceAll('__ACCOUNT_URL__','/account');
  const dom=new JSDOM(markup,{url:'https://community.example'+route,pretendToBeVisual:true});t.after(()=>dom.window.close());const {window}=dom;window.document.documentElement.dataset.loginMode=mode;
  if(pending)window.sessionStorage.setItem('vv-recipe-login-continuation',JSON.stringify(pending));
  window.sessionStorage.setItem('vv-account-login-expected','preserve-account-match');
  const calls=[],state={signedIn,providers,displaySession:'session-A',profile:{authorId:id,displayName:'真实昵称',revision:1,avatarDataUrl:'data:image/webp;base64,YWJj'},profileError};
  const fetch=async(url,options={})=>{
    calls.push({url,options});
    if(url==='/auth/session')return Response.json({signedIn:state.signedIn,displaySession:state.displaySession,providers:state.providers});
    if(url==='/api/v2/me/account-profile'){
      if(options.headers['X-Vonvon-Session']!==state.displaySession)return Response.json({error:{code:'session_changed'}},{status:409});
      if(state.pending)return state.pending;
      if(state.profileError)return Response.json({error:{code:'session_changed'}},{status:state.profileError});
      return Response.json(state.profile);
    }
    throw Error('Unexpected request '+url);
  };
  const location={origin:window.location.origin,assigned:[],assign(value){this.assigned.push(value);}};
  await new AsyncFunction('document','window','location','sessionStorage','fetch','BroadcastChannel','AbortSignal',source)(window.document,window,location,window.sessionStorage,fetch,undefined,AbortSignal);await settle();
  return {window,document:window.document,calls,state,location};
}
test('independent login offers only enabled recognized providers and no signup fields or identity invention',async t=>{
  const h=await runtime(t,{providers:['github','unknown','github','apple'],error:true});
  const forms=[...h.document.querySelectorAll('#login-providers form')];assert.equal(forms.length,1);
  for(const [index,provider] of ['github'].entries()){
    const form=forms[index];assert.equal(form.method,'post');assert.equal(form.getAttribute('action'),'/auth/start');assert.equal(form.querySelector('[name=provider]').value,provider);assert.equal(form.querySelector('[name=returnTo]').value,'/creators');assert.match(form.querySelector('button').textContent,/^使用 .+ 登录$/);
  }
  assert.equal(h.document.querySelector('#login-error').hidden,false);assert.equal(h.document.querySelector('#login-current').hidden,true);assert.equal(h.document.querySelectorAll('input:not([type=hidden])').length,0);assert.deepEqual(h.calls.map(x=>x.url),['/auth/session']);
  assert.equal(h.window.sessionStorage.getItem('vv-account-login-expected'),'preserve-account-match');
});
test('real signed-in profile offers local continue and account switch without logout or native reuse',async t=>{
  const h=await runtime(t,{signedIn:true,returnTo:'/?q=Alice%20Bob'});
  assert.equal(h.document.querySelector('#login-name').textContent,'真实昵称');assert.equal(h.document.querySelector('#login-avatar').getAttribute('src'),'data:image/webp;base64,YWJj');assert.equal(h.document.querySelector('#login-providers').hidden,false);
  assert.equal(h.document.querySelector('#login-continue').getAttribute('href'),'/?q=Alice+Bob');
  h.document.querySelector('#login-switch').click();assert.equal(h.document.querySelectorAll('#login-providers form').length,2);assert.equal(h.document.querySelector('#login-current').hidden,false);assert.equal(h.calls.length,2);assert.equal(h.document.querySelector('#login-switch-hint').hidden,false);
});
test('exact version continuation preserves allowed query context and cancel clears only matched intent',async t=>{
  const pending={path,nonce:'a'.repeat(64)},h=await runtime(t,{returnTo:path,pending});
  for(const form of h.document.querySelectorAll('#login-providers form')){assert.equal(form.querySelector('[name=continuation]').value,'acquire');assert.equal(form.querySelector('[name=continuationNonce]').value,pending.nonce);assert.equal(new URL(form.action).search,'');}
  assert.equal(h.document.querySelector('#login-cancel').getAttribute('href'),path);
  h.document.querySelector('#login-cancel').dispatchEvent(new h.window.Event('click'));assert.equal(h.window.sessionStorage.getItem('vv-recipe-login-continuation'),null);assert.equal(h.window.sessionStorage.getItem('vv-account-login-expected'),'preserve-account-match');
  const contextual=await runtime(t,{returnTo:path+'?from=library-all',pending});
  assert.equal(contextual.document.querySelector('[name=returnTo]').value,path+'?from=library-all');
  assert.equal(contextual.document.querySelector('[name=continuationNonce]').value,pending.nonce);
  for(const [returnTo,value] of [['/creators',pending],[path,{path,nonce:'invalid'}],[path,{path:path.replace('11111111','33333333'),nonce:pending.nonce}]]){
    const mismatch=await runtime(t,{returnTo,pending:value});assert.equal(mismatch.document.querySelector('[name=continuation]'),null);mismatch.document.querySelector('#login-cancel').dispatchEvent(new mismatch.window.Event('click'));assert.ok(mismatch.window.sessionStorage.getItem('vv-recipe-login-continuation'));
  }
});
test('untrusted or malformed injected return destinations cannot redirect or enter native/login flow',async t=>{
  for(const returnTo of ['https://evil.example','//evil.example','/\\evil','/login','/auth/native','/account?account=secret','/creators#fragment','/recipes/invalid','/?q=x&q=y','/%61ccount','/account\n',path+'?from=creator&author='+id]){
    const h=await runtime(t,{returnTo});assert.equal(h.document.querySelector('[name=returnTo]').value,'/',returnTo);assert.equal(h.document.querySelector('#login-cancel').getAttribute('href'),'/');
  }
});
test('login preserves only the four enumerated personal-library states',async t=>{
  for(const state of ['all','acquired','drafts','published']) {
    const path='/library?state='+state,h=await runtime(t,{returnTo:path});
    assert.equal(h.document.querySelector('[name=returnTo]').value,path);
    assert.equal(h.document.querySelector('#login-cancel').getAttribute('href'),path);
  }
  for(const returnTo of ['/library?state=other','/library?state=published&state=drafts','/library?state=published&next=https://evil.example']) {
    const h=await runtime(t,{returnTo});assert.equal(h.document.querySelector('[name=returnTo]').value,'/');
  }
});
for(const code of [401,409,503])test('profile '+code+' never invents a signed-in identity',async t=>{
  const h=await runtime(t,{signedIn:true,profileError:code});assert.equal(h.document.querySelector('#login-current').hidden,true);assert.equal(h.document.querySelector('#login-name').textContent,'');assert.equal(h.document.querySelector('#login-session-actions').hidden,true);
  assert.equal(h.document.querySelector('#login-providers').hidden,false);assert.equal(h.document.querySelectorAll('#login-providers button').length,2);
});
test('account refresh clears identity immediately and late profile cannot overwrite another session',async t=>{
  const h=await runtime(t,{signedIn:true});let release;h.state.pending=new Promise(resolve=>{release=resolve;});h.window.dispatchEvent(new h.window.Event('focus'));await settle();assert.equal(h.document.querySelector('#login-name').textContent,'');
  h.state.pending=null;h.state.displaySession='session-B';h.state.profile={authorId:id,displayName:'新网页账号'};h.window.dispatchEvent(new h.window.Event('focus'));await settle();release(Response.json({authorId:id,displayName:'迟到的旧账号'}));await settle();assert.equal(h.document.querySelector('#login-name').textContent,'新网页账号');assert.equal(h.document.querySelector('#login-avatar').hasAttribute('src'),false);
});

test('Continue revalidates the displayed account before navigating and clears stale identity',async t=>{
  const h=await runtime(t,{signedIn:true,returnTo:path+'?from=creator'});
  const click=()=>h.document.querySelector('#login-continue').dispatchEvent(new h.window.Event('click',{cancelable:true}));
  click();await settle();assert.deepEqual(h.location.assigned,[path+'?from=creator']);
  h.state.displaySession='session-B';h.state.profile={authorId:'33333333-3333-4333-8333-333333333333',displayName:'另一个账号'};
  click();await settle();assert.equal(h.location.assigned.length,1);assert.equal(h.document.querySelector('#login-name').textContent,'另一个账号');
  assert.equal(h.window.sessionStorage.getItem('vv-account-login-expected'),'preserve-account-match');
  assert.equal(h.calls.some(call=>call.url.includes('native')),false);
});

test('App mode performs no ordinary session/provider/profile work and preserves native fragment and tab intent',async t=>{
  const h=await runtime(t,{mode:'app',returnTo:path,pending:{path,nonce:'a'.repeat(64)},route:'/auth/native#ticket=synthetic-ticket'});
  assert.deepEqual(h.calls,[]);assert.equal(h.window.location.hash,'#ticket=synthetic-ticket');assert.equal(h.document.querySelectorAll('#login-providers form').length,0);
  assert.ok(h.window.sessionStorage.getItem('vv-recipe-login-continuation'));assert.equal(h.window.sessionStorage.getItem('vv-account-login-expected'),'preserve-account-match');
  h.window.dispatchEvent(new h.window.Event('focus'));await settle();assert.deepEqual(h.calls,[]);
});
test('both supported providers remain visible while unavailable providers are disabled and cannot submit',async t=>{
  for(const providers of [[],['github'],['github','google'],['github','google','apple']]){
    const h=await runtime(t,{providers});const buttons=[...h.document.querySelectorAll('#login-providers button')];assert.equal(buttons.length,2);
    assert.deepEqual(buttons.map(button=>button.textContent.replace(/ · 暂不可用$/,'')),['使用 GitHub 登录','使用 Google 登录']);
    for(const button of buttons){const enabled=providers.some(provider=>button.textContent.includes({github:'GitHub',google:'Google',apple:'Apple'}[provider]));assert.equal(button.disabled,!enabled);assert.equal(button.type,enabled?'submit':'button');assert.equal(Boolean(button.closest('form')),enabled);if(!enabled)assert.match(button.textContent,/暂不可用/);}
    assert.equal(h.document.querySelectorAll('#login-providers form').length,providers.filter(provider=>['github','google'].includes(provider)).length);assert.doesNotMatch(h.document.querySelector('#login-providers').textContent,/Apple/);assert.equal(h.document.querySelector('input[name=provider][value=apple]'),null);
  }
});
test('cancelled and failed login notices are distinct and never echo upstream descriptions',async t=>{
  const cancelled=await runtime(t,{error:'cancelled'});assert.equal(cancelled.document.querySelector('#login-error').hidden,false);assert.match(cancelled.document.querySelector('#login-error').textContent,/你已取消登录/);
  for(const error of ['failed',true]){const h=await runtime(t,{error});assert.match(h.document.querySelector('#login-error').textContent,/登录没有完成/);assert.doesNotMatch(h.document.querySelector('#login-error').textContent,/你已取消/);}
});
