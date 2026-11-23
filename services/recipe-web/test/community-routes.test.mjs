import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const authorId = '33333333-3333-4333-8333-333333333333';
const item = {recipeId:'11111111-1111-4111-8111-111111111111',versionId:'22222222-2222-4222-8222-222222222222',revision:1,
  creator:{authorId,displayName:'公开作者'},public:{name:'作者的配方',summary:'公开介绍',overview:'配方正文',version:'1.0',access:'direct'},owned:false,acquired:false,config:{role:'角色'}};
const detail = '/recipes/' + item.recipeId + '/versions/' + item.versionId;
async function runtime(t, route, signedIn = true, expireOnMore = false) {
  const dom = new JSDOM(html, {url:'https://recipes.example'+route}); t.after(()=>dom.window.close());
  const {window}=dom,calls=[];
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const fetch=async(url,options={})=>{
    calls.push({url,options});
    if(url==='/auth/session')return Response.json({signedIn,displaySession:signedIn?'account-A':undefined,providers:['github']});
    if(url==='/api/v2/community/recipes?')return Response.json({hero:null,items:[item],nextCursor:null});
    if(url==='/api/v2/me/recipes')return Response.json({items:[item],nextCursor:expireOnMore?item.versionId:null});
    if(url.startsWith('/api/v2/me/recipes?'))return Response.json({error:{code:'login_required'}},{status:401});
    if(url==='/api/v2/me/publications')return Response.json({items:[item,{...item,versionId:'44444444-4444-4444-8444-444444444444',revision:2}],nextCursor:null});
    if(url==='/api/v2/authors/'+authorId+'/recipes')return Response.json({creator:item.creator,items:[item],nextCursor:null});
    if(url==='/api/v1'+detail || url==='/api/v2'+detail+'/preview')return Response.json(item);
    throw Error('Unexpected '+url);
  };
  const run=new AsyncFunction('document','window','location','history','fetch','BroadcastChannel','scrollY',source);
  const location={pathname:window.location.pathname,search:window.location.search,href:window.location.href,reloads:0,reload(){this.reloads++;}};
  await run(window.document,window,location,window.history,fetch,undefined,0);
  return {document:window.document,calls,window,location};
}

test('personal recipe navigation stays visible inside the community before login',async t=>{
  for(const signedIn of [true,false]){
    const h=await runtime(t,'/',signedIn);
    assert.equal(h.document.querySelector('header a[href="/library"]'),null);
    assert.ok(h.document.querySelector('main nav a[href="/library"]'));
    assert.equal(h.document.querySelector('a a'),null);
    assert.equal(h.document.querySelector('.author-link').getAttribute('href'),'/?q='+encodeURIComponent(item.creator.displayName));
  }
});

test('my recipes separates acquired and all own publication versions and binds both to the displayed account',async t=>{
  for(const route of ['/library','/publications']){
    const h=await runtime(t,route);
    assert.equal(h.document.querySelector('h1').textContent,'我的配方');
    assert.deepEqual([...h.document.querySelectorAll('.community-tabs a')].map(a=>a.textContent),['已获取','我发布的']);
    const read=h.calls.find(c=>c.url.startsWith('/api/v2/me/'));
    assert.equal(read.options.headers['X-Vonvon-Session'],'account-A');
    assert.equal(h.document.querySelectorAll('.card').length,route==='/library'?1:2);
  }
});

test('public author pages fetch only that author publications and preserve detail return origin',async t=>{
  const h=await runtime(t,'/authors/'+authorId,false);
  assert.equal(h.document.querySelector('h1').textContent,'公开作者');
  assert.equal(h.calls.some(c=>c.url.includes('/me/')),false);
  assert.equal(h.document.querySelector('.card-main').getAttribute('href'),detail+'?from=author&author='+authorId);
  const page=await runtime(t,detail+'?from=author&author='+authorId,false);
  assert.equal(page.document.querySelector('a[aria-label="返回作者的配方"]').getAttribute('href'),'/authors/'+authorId);
  assert.ok(page.document.querySelector('.metric .author-link'), page.document.querySelector('main').innerHTML);
  assert.equal(page.document.querySelector('.metric .author-link').getAttribute('href'),'/?q='+encodeURIComponent(item.creator.displayName));
});

test('anonymous personal pages require login before any private recipe read',async t=>{
  const h=await runtime(t,'/publications',false);
  assert.equal(h.calls.some(c=>c.url.includes('/me/')),false);
  assert.match(h.document.querySelector('main').textContent,/登录后查看我的配方/);
  h.document.querySelector('main button').click();
  assert.equal(h.document.querySelector('form input[name="returnTo"]').value,'/publications');
});

test('an expired paginated private list clears old cards before asking to log in again',async t=>{
  const h=await runtime(t,'/library',true,true);
  assert.equal(h.document.querySelectorAll('.card').length,1);
  [...h.document.querySelectorAll('button')].find(b=>b.textContent==='加载更多').click();
  for(let i=0;i<10;i++)await new Promise(setImmediate);
  assert.equal(h.location.reloads,1);
  assert.equal(h.document.querySelectorAll('.card').length,0);
});
