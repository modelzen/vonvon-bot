import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=(await readFile(new URL('../public/index.html',import.meta.url),'utf8')).replaceAll('__DESKTOP_CHANNEL__','preview').replaceAll('__RECIPE_CREATE_URL__','vonvon-preview://recipes/create');
const source=await readFile(new URL('../public/app.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const recipe={recipeId:'11111111-1111-4111-8111-111111111111',versionId:'22222222-2222-4222-8222-222222222222',revision:1,public:{name:'工作助手',summary:'整理日常工作',version:'1',access:'direct'}};
const page=items=>({hero:null,items,nextCursor:null});
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(setImmediate);};
async function runtime(t,respond=()=>page([recipe]),route='/'){
 const dom=new JSDOM(html,{url:'https://recipes.example'+route});t.after(()=>dom.window.close());
 const {window}=dom,queries=[],timers=new Map();let nextId=0;
 window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const fetch=async path=>{
  if(path==='/auth/session')return Response.json({signedIn:false,providers:['github']});
  const url=new URL(path,window.location.origin),q=url.searchParams.get('q')||'';queries.push(q);return Response.json(await respond(q,url.searchParams.get('cursor')));
 };
 const run=new AsyncFunction('document','window','location','history','fetch','BroadcastChannel','scrollY','setTimeout','clearTimeout',source);
 await run(window.document,window,window.location,window.history,fetch,undefined,0,(fn)=>{const id=++nextId;timers.set(id,fn);return id;},id=>timers.delete(id));
 const input=window.document.querySelector('input[type=search]'),form=input.form;
 const type=value=>{input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}));};
 const submit=async()=>{form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();};
 const flush=async()=>{const pending=[...timers.values()];timers.clear();for(const fn of pending)await fn();await settle();};
 return {document:window.document,window,input,form,queries,type,submit,flush};
}

test('search is the prominent hero control and My recipes remains discoverable before login',async t=>{
 const h=await runtime(t);
 assert.ok(h.document.querySelector('.catalog-welcome + .catalog-search-dock form[role=search]'));
 assert.ok(h.form.querySelector('svg[aria-hidden=true]'));
 assert.equal(h.form.querySelector('[type=submit]').textContent,'搜索');
 assert.match(h.input.placeholder,/名称.*用途.*作者/);
 assert.ok(h.document.querySelector('.community-nav a[href="/library"]'));
 assert.equal(h.document.querySelector('.community-nav [data-create-recipe]').getAttribute('href'),'vonvon-preview://recipes/create');
 assert.equal(h.document.querySelector('.catalog-tools'),null);
});

test('submit searches the entered text and clearing restores all recipes and keyboard focus',async t=>{
 const h=await runtime(t);
 h.type('工作助手');await h.submit();
 assert.deepEqual(h.queries,['','工作助手']);
 assert.equal(new URL(h.window.location.href).searchParams.get('q'),'工作助手');
 assert.match(h.document.querySelector('.catalog-results-heading').textContent,/工作助手/);
 h.form.querySelector('[aria-label="清除搜索"]').click();await settle();
 assert.deepEqual(h.queries,['','工作助手','']);assert.equal(h.input.value,'');
 assert.equal(h.document.activeElement,h.input);assert.equal(new URL(h.window.location.href).searchParams.has('q'),false);
});

test('Chinese input composition does not issue incomplete search requests',async t=>{
 const h=await runtime(t);
 h.input.dispatchEvent(new h.window.Event('compositionstart',{bubbles:true}));
 h.type('pei');await h.flush();await h.submit();assert.deepEqual(h.queries,['']);
 h.input.value='配方';h.input.dispatchEvent(new h.window.Event('compositionend',{bubbles:true}));await h.flush();
 assert.deepEqual(h.queries,['','配方']);
});

test('a late search response never replaces newer results',async t=>{
 let release;
 const h=await runtime(t,q=>q==='旧'?new Promise(resolve=>{release=resolve;}):page([{...recipe,public:{...recipe.public,name:q||recipe.public.name}}]));
 h.type('旧');void h.submit();await settle();
 h.type('新');await h.submit();assert.match(h.document.querySelector('.card h3').textContent,/新/);
 release(page([{...recipe,public:{...recipe.public,name:'旧'}}]));await settle();
 assert.equal(h.document.querySelector('.card h3').textContent,'新');
 assert.equal(h.document.querySelector('[aria-label="配方目录"]').getAttribute('aria-busy'),'false');
});

test('empty results retain the search and offer one clear route back to the catalog',async t=>{
 const h=await runtime(t,q=>page(q?[]:[recipe]));h.type('不存在');await h.submit();
 assert.ok(h.document.querySelector('.catalog-search-dock input[type=search]'));
 assert.match(h.document.querySelector('.empty').textContent,/没有找到匹配/);
 const reset=[...h.document.querySelectorAll('button')].filter(b=>b.textContent==='查看全部配方');assert.equal(reset.length,1);
 reset[0].click();await settle();assert.equal(h.input.value,'');assert.ok(h.document.querySelector('.card'));
});

test('an author search link restores its name in the same search and keeps it on later pages',async t=>{
 const author='公开作者',creator={authorId:'33333333-3333-4333-8333-333333333333',displayName:author},requests=[];
 const h=await runtime(t,(q,cursor)=>{
  requests.push({q,cursor});return {hero:null,items:[{...recipe,creator,recipeId:cursor?'44444444-4444-4444-8444-444444444444':recipe.recipeId}],nextCursor:cursor?null:'next-page'};
 },'/?q='+encodeURIComponent(author));
 assert.equal(h.input.value,author);
 assert.equal(h.document.querySelector('.author-link').getAttribute('href'),'/?q='+encodeURIComponent(author));
 [...h.document.querySelectorAll('button')].find(b=>b.textContent==='加载更多').click();await settle();
 assert.deepEqual(requests,[{q:author,cursor:null},{q:author,cursor:'next-page'}]);
 assert.equal(h.document.querySelectorAll('.card').length,2);
 assert.equal(h.document.querySelectorAll('form[role=search]').length,1);
});
