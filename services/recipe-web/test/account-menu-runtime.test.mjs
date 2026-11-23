import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=(await readFile(new URL('../public/index.html',import.meta.url),'utf8')).replaceAll('__ACCOUNT_URL__','https://account.example/account');
const source=await readFile(new URL('../public/app.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const accountId='11111111-1111-4111-8111-111111111111';
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(setImmediate);};
async function runtime(t,profileResponse,{catalogResponse=Response.json({hero:null,items:[],nextCursor:null}),wait=true}={}){
  const dom=new JSDOM(html,{url:'https://community.example/'});t.after(()=>dom.window.close());
  const {window}=dom;
  window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const fetch=async(path,options={})=>{
    if(path==='/auth/session')return Response.json({signedIn:true,displaySession:'session-A',providers:['github']});
    if(path==='/api/v2/community/recipes?')return catalogResponse;
    if(path==='/api/v2/me/account-profile'){assert.equal(options.headers['X-Vonvon-Session'],'session-A');return profileResponse;}
    throw Error('Unexpected '+path);
  };
  const run=new AsyncFunction('document','window','location','history','fetch','BroadcastChannel','scrollY',source);
  const ready=run(window.document,window,window.location,window.history,fetch,undefined,0);
  if(wait)await ready;
  return {document:window.document,ready};
}
test('account settings stay inactive until the displayed profile binds the account site destination',async t=>{
  let release;const {document}=await runtime(t,new Promise(resolve=>{release=resolve;}));
  const setting=[...document.querySelectorAll('.account-menu nav a')].find(a=>a.textContent==='账号设置');
  assert.equal(setting.hasAttribute('href'),false);assert.equal(setting.getAttribute('aria-disabled'),'true');
  release(Response.json({authorId:accountId,displayName:'当前账号'}));await settle();
  assert.equal(setting.getAttribute('href'),'https://account.example/account#account='+accountId);
  assert.equal(setting.hasAttribute('aria-disabled'),false);
  assert.match(document.querySelector('.account-menu summary').textContent,/当前账号/);
});
test('an unavailable profile never exposes an unbound account-site link',async t=>{
  const {document}=await runtime(t,Response.json({error:{code:'unavailable'}},{status:503}));await settle();
  assert.equal(document.querySelector('.account-menu a[href^="https://account.example"]'),null);
  assert.equal(document.querySelector('.account-menu a[aria-disabled=true]').textContent,'账号设置暂不可用');
});

test('a signed-in startup never exposes the old unbound account button while page data is pending or failed',async t=>{
  let releaseCatalog,releaseProfile;
  const {document,ready}=await runtime(t,new Promise(resolve=>{releaseProfile=resolve;}),{catalogResponse:new Promise(resolve=>{releaseCatalog=resolve;}),wait:false});
  await settle();
  assert.equal(document.querySelector('#account').hidden,true);
  assert.ok(document.querySelector('.account-menu'));
  assert.equal(document.querySelector('.account-menu a[aria-disabled=true]').hasAttribute('href'),false);
  document.querySelector('#account').click();
  assert.equal(document.querySelector('.account-menu').open,true);
  releaseCatalog(Response.json({error:{code:'unavailable'}},{status:503}));await ready;
  releaseProfile(Response.json({error:{code:'unavailable'}},{status:503}));await settle();
  assert.equal(document.querySelector('#account').hidden,true);
  assert.equal(document.querySelector('.account-menu a[href^="https://account.example"]'),null);
});
