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
  const dom = new JSDOM(html.replaceAll('__RECIPE_CREATE_URL__','vonvon-preview://recipes/create').replaceAll('__DESKTOP_CHANNEL__','preview').replaceAll('__RECIPE_DRAFTS_URL__','vonvon-preview://recipes/drafts'), {url:'https://recipes.example'+route}); t.after(()=>dom.window.close());
  const {window}=dom,calls=[];
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const fetch=async(url,options={})=>{
    calls.push({url,options});
    if(url==='/auth/session')return Response.json({signedIn,displaySession:signedIn?'account-A':undefined,providers:['github']});
    if(url==='/api/v2/me/account-profile')return Response.json({authorId,displayName:'当前账号',revision:1});
    if(url==='/api/v2/community/recipes?')return Response.json({hero:null,items:[item],nextCursor:null});
    if(url.startsWith('/api/v2/me/recipe-groups?')){
      assert.equal(options.headers['X-Vonvon-Session'],'account-A');
      const query=new URL(url,'https://recipes.example').searchParams;
      if(query.has('cursor'))return Response.json({error:{code:'login_required'}},{status:401});
      return Response.json({items:[{recipeId:item.recipeId,versionId:item.versionId,revision:item.revision,creator:item.creator,public:item.public,owned:true,acquired:true,state:'listed',versionCount:2}],nextCursor:expireOnMore?'ab.'+'f'.repeat(64):null});
    }
    if(url==='/api/v2/authors/'+authorId+'/recipes')return Response.json({creator:item.creator,items:[item],nextCursor:null});
    if(url==='/api/v1'+detail || url==='/api/v2'+detail+'/preview')return Response.json(item);
    throw Error('Unexpected '+url);
  };
  const run=new AsyncFunction('document','window','location','history','fetch','BroadcastChannel','scrollY',source);
  const location = {get pathname(){return window.location.pathname;}, get search(){return window.location.search;}, get href(){return window.location.href;}, get origin(){return window.location.origin;}, assigned:[], reloads:0, reload(){this.reloads++;}, assign(path){this.assigned.push(path);}};
  await run(window.document,window,location,window.history,fetch,undefined,0);
  for(let i=0;i<10;i++)await Promise.resolve();await new Promise(setImmediate);
  return {document:window.document,calls,window,location};
}

test('My recipes appears only in the signed-in account menu',async t=>{
  for(const signedIn of [true,false]){
    const h=await runtime(t,'/',signedIn);
    if(signedIn){assert.equal(h.document.querySelector('.account-menu summary').textContent.includes('当前账号'),true);assert.ok(h.document.querySelector('.account-menu a[href="/library"]'));}
    else assert.equal(h.document.querySelector('#account').textContent,'登录');
    assert.equal(h.document.querySelector('main a[href="/library"]'),null);
    assert.equal(h.document.querySelectorAll('a[href="/library"]').length,signedIn?1:0);
    assert.equal(h.document.querySelector('a a'),null);
    assert.equal(h.document.querySelector('.author-link').getAttribute('href'),'/?q='+encodeURIComponent(item.creator.displayName));
  }
});

test('my recipes combines personal states and keeps the same displayed-account guard',async t=>{
    const h=await runtime(t,'/library');
    assert.equal(h.document.querySelector('h1').textContent,'我的配方');
    assert.deepEqual([...h.document.querySelectorAll('.library-filters button')].map(a=>a.textContent),['全部','已获取','创作中','我发布的']);
    const read=h.calls.find(c=>c.url.startsWith('/api/v2/me/'));
    assert.equal(read.options.headers['X-Vonvon-Session'],'account-A');
    assert.equal(h.document.querySelectorAll('.card').length,1);
    assert.equal(h.document.querySelector('.library-version-toggle').textContent,'选择版本（2）');
    assert.ok(h.calls.some(c=>c.url==='/api/v2/me/recipe-groups?scope=all'));
    assert.equal(h.document.querySelector('a[data-create-site]').getAttribute('href'),'__GUARDED_CREATE_URL__');
    const before=h.calls.length;
    h.document.querySelector('[data-state="drafts"]').click();
    await new Promise(setImmediate);
    assert.equal(h.document.querySelector('[data-app-drafts]').getAttribute('href'),'vonvon-preview://recipes/drafts');
    assert.match(h.document.querySelector('.library-content').textContent,/保存在本地/);
    assert.deepEqual(h.calls.slice(before).map(call=>call.url),['/auth/session']);
    const legacy=await runtime(t,'/publications');
    assert.equal(legacy.location.assigned.at(-1),'/library?state=published');
    assert.equal(legacy.calls.some(c=>c.url==='/api/v2/me/publications'),false);
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
  const h=await runtime(t,'/library',false);
  assert.equal(h.calls.some(c=>c.url.includes('/me/')),false);
  assert.match(h.document.querySelector('main').textContent,/登录后查看我的配方/);
  const login = [...h.document.querySelectorAll('.library-content button')].find(button => button.textContent === '登录');
  assert.ok(login, 'anonymous visitors can log in from the personal library');
  login.click();
  assert.equal(h.location.assigned.at(-1),'/login?returnTo=%2Flibrary');
  assert.equal(h.document.querySelector('#modal form'),null);
});

test('an expired paginated private list clears old cards before asking to log in again',async t=>{
  const h=await runtime(t,'/library?state=acquired',true,true);
  assert.equal(h.document.querySelectorAll('.card').length,1);
  [...h.document.querySelectorAll('button')].find(b=>b.textContent==='加载更多').click();
  for(let i=0;i<10;i++)await new Promise(setImmediate);
  assert.equal(h.location.reloads,1);
  assert.equal(h.document.querySelectorAll('.card').length,0);
});
