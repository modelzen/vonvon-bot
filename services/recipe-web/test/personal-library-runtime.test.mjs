import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {JSDOM} from 'jsdom';
const source=await readFile(new URL('../public/app.mjs',import.meta.url),'utf8');
const html=(await readFile(new URL('../public/index.html',import.meta.url),'utf8')).replaceAll('__DESKTOP_CHANNEL__','preview').replaceAll('__RECIPE_CREATE_URL__','vonvon-preview://recipes/create').replaceAll('__RECIPE_DRAFTS_URL__','vonvon-preview://recipes/drafts').replaceAll('__COMMUNITY_URL__','/').replaceAll('__LIBRARY_URL__','/library').replaceAll('__ACCOUNT_URL__','/account');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const id=n=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
const token=n=>n.toString(16)+'.'+'a'.repeat(64);
const summary=(recipe=1,revision=3)=>({recipeId:id(recipe),versionId:id(recipe*100+revision),revision,creator:{authorId:id(900),displayName:'当前作者'},public:{name:'同名配方',summary:'公开元数据',version:'v'+revision,access:'coded'},format:'rich-v2',hasDisplayLogo:false,state:'listed',owned:true,acquired:false});
const group=(recipe=1,revision=3)=>({...summary(recipe,revision),versionCount:52});
const page=(items,nextCursor=null)=>({items,nextCursor});
const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve();await new Promise(setImmediate);};
async function runtime(t,{route='/library',signedIn=true,respond}={}){
 const dom=new JSDOM(html,{url:'https://recipes.example'+route,pretendToBeVisual:true});t.after(()=>dom.window.close());const {window}=dom,calls=[],sessionState={signedIn,displaySession:signedIn?'session-A':undefined};
 window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const location={get pathname(){return window.location.pathname;},get search(){return window.location.search;},get href(){return window.location.href;},get origin(){return window.location.origin;},assigned:[],reloads:0,assign(value){this.assigned.push(value);},reload(){this.reloads++;}};
 const fetch=async(url,options={})=>{
  calls.push({url,options});if(url==='/auth/session'){if(sessionState.pending?.length)return sessionState.pending.shift();return Response.json({...sessionState,providers:['github']});}
  assert.equal(options.headers['X-Vonvon-Session'],'session-A');assert.equal(options.method,undefined);assert.equal(options.body,undefined);
  if(url==='/api/v2/me/account-profile')return Response.json({authorId:id(900),displayName:'当前账号',revision:1});
  const parsed=new URL(url,window.location.origin),match=/^\/api\/v2\/me\/recipe-groups(?:\/([^/]+)\/versions)?$/.exec(parsed.pathname);
  assert.ok(match,'metadata-only group/version endpoint required: '+url);
  const request={url,scope:parsed.searchParams.get('scope'),cursor:parsed.searchParams.get('cursor'),recipeId:match[1]??null,options};
  return respond?respond(request):Response.json(page(match[1]?[summary(Number(match[1].slice(-12)),3),summary(Number(match[1].slice(-12)),2)]:[group()]));
 };
 await new AsyncFunction('document','window','location','history','navigator','crypto','fetch','BroadcastChannel','scrollY','setTimeout','clearTimeout',source)(window.document,window,location,window.history,window.navigator,webcrypto,fetch,undefined,0,(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout);await settle();
 const filter=async value=>{window.document.querySelector('[data-state='+value+']').click();await settle();};
 const click=async text=>{const target=[...window.document.querySelectorAll('main button')].find(button=>button.textContent===text);assert.ok(target,text);target.click();await settle();};
 const openVersions=async recipe=>{window.document.querySelector('[data-recipe-id="'+id(recipe)+'"] .library-version-toggle').click();await settle();};
 return {window,document:window.document,location,calls,filter,click,openVersions,sessionState};
}
test('default all uses authoritative groups, separate same-name IDs and exact fixed version links without cloud drafts or badges',async t=>{
 const h=await runtime(t,{respond:({recipeId})=>Response.json(page(recipeId?[summary()]:[group(1,3),group(2,1)]))});
 assert.deepEqual([...h.document.querySelectorAll('.library-filter')].map(x=>[x.textContent,x.dataset.state]),[['全部','all'],['已获取','acquired'],['创作中','drafts'],['我发布的','published']]);
 assert.equal(h.document.querySelectorAll('.library-cards>.card').length,2);assert.equal(h.calls.filter(x=>x.url.includes('recipe-groups')).length,1);
 assert.equal(h.document.querySelector('.card-main').getAttribute('href'),'/recipes/'+id(1)+'/versions/'+id(103)+'?from=library-all');
 assert.equal(h.document.querySelector('[data-create-site]').getAttribute('href'),'__GUARDED_CREATE_URL__');
 assert.equal(h.document.querySelector('.library-state'),null);assert.equal(h.calls.some(x=>x.url.includes('/drafts')),false);assert.equal(h.calls.some(x=>x.url.includes('/versions?')),false);
 assert.match(h.document.querySelector('.library-version-toggle').textContent,/52/);
});
test('draft filter is local-only with exact channel URI and no cloud draft or group reads',async t=>{
 const h=await runtime(t,{route:'/library?state=drafts'});
 assert.match(h.document.querySelector('main').textContent,/创作中的配方保存在本地，发布后才会同步到社区/);
 assert.equal(h.document.querySelector('[data-app-drafts]').getAttribute('href'),'vonvon-preview://recipes/drafts');
 assert.equal(h.calls.some(x=>x.url.includes('recipe-groups')||x.url.includes('/drafts')),false);
});
test('anonymous filters read no private API and preserve the exact enumerated login return path',async t=>{
 const h=await runtime(t,{signedIn:false});
 for(const scope of ['all','acquired','drafts','published']){await h.filter(scope);await h.click('登录');const next=new URL(h.location.assigned.at(-1),'https://recipes.example');assert.equal(next.pathname,'/login');assert.equal(next.searchParams.get('returnTo'),scope==='all'?'/library':'/library?state='+scope);}
 assert.deepEqual(h.calls.map(x=>x.url),['/auth/session']);
});
test('group pagination appends IDs without client aggregation and keeps all 51 entries',async t=>{
 const h=await runtime(t,{respond:({cursor,recipeId})=>Response.json(page(recipeId?[]:cursor?[group(50),group(51)]:Array.from({length:50},(_,i)=>group(i+1)),cursor?null:token(1)))});
 assert.equal(h.document.querySelectorAll('.library-cards>.card').length,50);await h.click('加载更多');assert.equal(h.document.querySelectorAll('.library-cards>.card').length,51);
 assert.ok(h.calls.some(x=>x.url==='/api/v2/me/recipe-groups?scope=all&cursor='+encodeURIComponent(token(1))));
});
test('version picker lazily reads all 50-version pages and selects only returned exact IDs',async t=>{
 const h=await runtime(t,{respond:({recipeId,cursor})=>Response.json(recipeId?page(cursor?[summary(1,51),summary(1,52)]:Array.from({length:50},(_,i)=>summary(1,i+1)),cursor?null:token(2)):page([group(1,52)]))});
 assert.equal(h.calls.some(x=>x.url.includes('/versions?')),false);await h.openVersions(1);assert.equal(h.document.querySelectorAll('.library-version-option').length,50);await h.click('加载更多版本');assert.equal(h.document.querySelectorAll('.library-version-option').length,52);
 await h.click('版本 v51');assert.equal(h.document.querySelector('.card-main').getAttribute('href'),'/recipes/'+id(1)+'/versions/'+id(151)+'?from=library-all');
 assert.equal(h.calls.some(x=>/\/api\/v[12]\/recipes\//.test(x.url)),false);
});
test('scope-keyed selection does not leak into another scope and cache hits still validate the displayed session',async t=>{
 const h=await runtime(t,{respond:({recipeId,scope})=>Response.json(page(recipeId?[summary(1,1),summary(1,2)]:[group(1,scope==='acquired'?1:3)]))});
 await h.openVersions(1);await h.click('版本 v2');await h.filter('acquired');assert.ok(h.document.querySelector('.card-main').href.includes('/'+id(101)+'?from=library'));
 await h.filter('all');assert.ok(h.document.querySelector('.card-main').href.includes('/'+id(102)+'?from=library-all'));
 h.sessionState.displaySession='session-B';await h.filter('acquired');assert.equal(h.location.reloads,1);assert.equal(h.document.querySelector('.library-content').textContent,'');
});
test('late scope/version results cannot replace the current group or be selected after account changes',async t=>{
 let release;
 const h=await runtime(t,{respond:({recipeId,scope})=>recipeId?new Promise(resolve=>{release=resolve;}):Response.json(page([group(1,scope==='published'?4:3)]))});
 await h.openVersions(1);await h.filter('published');release(Response.json(page([summary(1,1)])));await settle();assert.equal(h.document.querySelector('.library-version-option'),null);assert.ok(h.document.querySelector('.card-main').href.includes('/'+id(104)+'?from=published'));
});
for(const code of [401,409])test('private group/version '+code+' clears every private cache and DOM',async t=>{
 let fail=false;
 const h=await runtime(t,{respond:({recipeId})=>recipeId&&fail?Response.json({error:{code:code===401?'auth_required':'session_changed'}},{status:code}):Response.json(page(recipeId?[summary(1,2)]:[group()]))});
 fail=true;await h.openVersions(1);assert.equal(h.location.reloads,1);assert.equal(h.document.querySelector('.library-content').textContent,'');
});
test('version retry recovers without reading bodies, and foreign recipe IDs cannot become selection options',async t=>{
 let attempt=0;
 const h=await runtime(t,{respond:({recipeId})=>!recipeId?Response.json(page([group()])):++attempt===1?Response.json({error:{code:'unavailable'}},{status:503}):Response.json(page([summary(2,1)]))});
 await h.openVersions(1);await h.click('重新读取版本');assert.equal(h.document.querySelector('.library-version-option'),null);assert.ok(h.document.querySelector('.card-main').href.includes('/'+id(103)+'?from=library-all'));
});
test('cached version click rechecks the website session and cannot apply an old account choice',async t=>{
 const h=await runtime(t);await h.openVersions(1);h.sessionState.signedIn=false;await h.click('版本 v2');assert.equal(h.location.reloads,1);assert.equal(h.document.querySelector('.library-content').textContent,'');
});

test('a slower earlier version selection cannot overwrite the latest explicit selection',async t=>{
 const h=await runtime(t);await h.openVersions(1);let first,second;
 h.sessionState.pending=[new Promise(resolve=>{first=resolve;}),new Promise(resolve=>{second=resolve;})];
 h.document.querySelector('[data-version-id="'+id(103)+'"]').click();await settle();
 h.document.querySelector('[data-version-id="'+id(102)+'"]').click();await settle();
 second(Response.json({signedIn:true,displaySession:'session-A'}));await settle();
 assert.ok(h.document.querySelector('.card-main').href.includes('/'+id(102)+'?from=library-all'));
 first(Response.json({signedIn:true,displaySession:'session-A'}));await settle();
 assert.ok(h.document.querySelector('.card-main').href.includes('/'+id(102)+'?from=library-all'));
});
