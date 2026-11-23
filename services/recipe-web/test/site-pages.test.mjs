import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {JSDOM} from 'jsdom';
import {createRecipeWeb} from '../server.mjs';

async function listen(t,server) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  return 'http://127.0.0.1:'+server.address().port;
}
const json=(res,value)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
const cookie=response=>response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');
const id='11111111-1111-4111-8111-111111111111';

test('login and account surfaces link the unified personal library with safe configured destinations',async t=>{
  const host=await listen(t,createRecipeWeb({RECIPE_COMMUNITY_ORIGIN:'https://community.example',RECIPE_CREATORS_ORIGIN:'https://creators.example'}));
  for(const route of ['/login?returnTo='+encodeURIComponent('/?q=作者')+'&auth=failed','/library','/auth/native']) {
    const response=await fetch(host+route);assert.equal(response.status,200);
    const html=await response.text();assert.doesNotMatch(html,/__[A-Z_]+__/);
    const dom=new JSDOM(html);t.after(()=>dom.window.close());const {document}=dom.window;
    assert.ok(document.querySelector('a[href="https://community.example/"]'));
    assert.equal(document.documentElement.dataset.libraryUrl,'https://community.example/library');
    assert.equal(document.querySelector('header nav a[href="https://community.example/library"]'),null);
    if(route==='/library')assert.equal(document.querySelector('header [data-create-site]').getAttribute('href'),'/create?from=%2Flibrary');
    else{assert.equal(document.querySelector('header [data-create-recipe]'),null);assert.equal(document.querySelectorAll('header a,header button').length,1);assert.equal(document.querySelector('header .brand').textContent,'Vonvon Bot');}
    assert.equal(document.querySelector('a[href="https://creators.example/"]'),null);
    if(route.startsWith('/login')){
      assert.equal(decodeURIComponent(document.documentElement.dataset.loginReturnTo),'/?q='+encodeURIComponent('作者'));
      assert.equal(document.documentElement.dataset.loginError,'failed');
      assert.equal(document.querySelector('dialog'),null);
    }
  }
  for(const [suffix,error] of [['','false'],['?auth=cancelled','cancelled'],['?auth=unknown','false']]) {
    const dom=new JSDOM(await fetch(host+'/login'+suffix).then(response=>response.text()));
    assert.equal(dom.window.document.documentElement.dataset.loginMode,'web');
    assert.equal(dom.window.document.documentElement.dataset.loginError,error);
    dom.window.close();
  }
  const invalid=await fetch(host+'/login?returnTo='+encodeURIComponent('https://other.example/path')).then(r=>r.text());
  assert.match(invalid,/data-login-return-to="%2F"/);
  for(const path of ['/login.mjs','/login.css'])assert.equal((await fetch(host+path)).status,200);
  for(const path of ['/creators','/publications']) {
    const legacy=await fetch(host+path,{redirect:'manual'});assert.equal(legacy.status,303);assert.equal(legacy.headers.get('location'),'https://community.example/library?state=published');
  }
  for(const path of ['/creators.mjs','/creators.css'])assert.equal((await fetch(host+path)).status,404);
});

test('separate site instances can render their own root without sharing an unbounded redirect or cookie domain',async t=>{
  for(const [kind,title] of [['community','社区'],['account','账号设置']]) {
    const host=await listen(t,createRecipeWeb({RECIPE_SITE_KIND:kind}));
    const html=await fetch(host+'/').then(r=>r.text());
    const dom=new JSDOM(html);t.after(()=>dom.window.close());assert.match(dom.window.document.title,new RegExp(title));
    assert.equal((await fetch(host+'/login')).status,200);
  }
  const legacyHost=await listen(t,createRecipeWeb({RECIPE_SITE_KIND:'creators'}));
  const legacy=await fetch(legacyHost+'/',{redirect:'manual'});assert.equal(legacy.status,303);assert.equal(legacy.headers.get('location'),'/library?state=published');
  assert.equal((await fetch(legacyHost+legacy.headers.get('location'),{redirect:'manual'})).status,200);
  for(const config of [{RECIPE_SITE_KIND:'other'},{RECIPE_CREATORS_ORIGIN:'https://user@other.example'},{RECIPE_ACCOUNT_ORIGIN:'https://other.example/path'},{RECIPE_COMMUNITY_ORIGIN:'javascript:alert(1)'}])assert.throws(()=>createRecipeWeb(config));
});

test('website keeps draft transport local and binds library reads to the displayed account',async t=>{
  const calls=[];
  const api=await listen(t,createServer((req,res)=>{
    calls.push({path:req.url,authorization:req.headers.authorization,browse:req.headers['x-vonvon-browse']});
    if(req.url.startsWith('/v2/me/recipe-groups')) return json(res,{items:[],nextCursor:null});
    if(req.url.endsWith('/preview')) {res.statusCode=404;return json(res,{error:{code:'not_found'}});}
    json(res,{items:['role-v1','rich-v2'].map(format=>({draftId:id,recipeId:null,revision:2,format,
      public:{name:format,summary:'简介',version:'1',access:'direct',overview:'PRIVATE OVERVIEW'},config:{role:'PRIVATE ROLE'},canonical:'PRIVATE PACKAGE',manifest:{secret:'PRIVATE MANIFEST'}}))});
  }));
  const issuer=await listen(t,createServer((req,res)=>json(res,{access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600, user: {id: id}})));
  const origin='https://community.example';
  const host=await listen(t,createRecipeWeb({RECIPE_WEB_ORIGIN:origin,RECIPE_API_ORIGIN:api,SUPABASE_URL:issuer,SUPABASE_PUBLISHABLE_KEY:'synthetic',RECIPE_WEB_PROVIDERS:'github'}));
  assert.equal((await fetch(host+'/api/v2/me/drafts')).status,404);
  const start=await fetch(host+'/auth/start',{method:'POST',redirect:'manual',headers:{origin},body:new URLSearchParams({provider:'github',returnTo:'/creators'})});
  const finish=await fetch(host+'/auth/callback?code=synthetic',{redirect:'manual',headers:{cookie:cookie(start)}});
  assert.equal(finish.headers.get('location'),'/creators#');
  const sessionCookie=cookie(finish),session=await fetch(host+'/auth/session',{headers:{cookie:sessionCookie}}).then(r=>r.json());
  assert.equal((await fetch(host+'/api/v2/me/drafts',{headers:{cookie:sessionCookie,'X-Vonvon-Session':session.displaySession}})).status,404);
  assert.deepEqual(calls.map(call=>call.path),['/v2/me/account-profile']);
  for(const path of ['/v2/me/recipe-groups?scope=all','/v2/me/recipe-groups/'+id+'/versions?scope=acquired']){
    const count=calls.length;
    assert.equal((await fetch(host+'/api'+path)).status,401);
    assert.equal((await fetch(host+'/api'+path,{headers:{cookie:sessionCookie,'X-Vonvon-Session':'old'}})).status,409);
    assert.equal(calls.length,count);
    const good=await fetch(host+'/api'+path,{headers:{cookie:sessionCookie,'X-Vonvon-Session':session.displaySession}});
    assert.equal(good.status,200);
    assert.deepEqual(calls.at(-1),{path,authorization:'Bearer synthetic-access',browse:undefined});
  }
  const path='/v2/recipes/'+id+'/versions/'+id+'/preview';
  const missing=await fetch(host+'/api'+path,{headers:{'X-Vonvon-Browse':'client-value'}});
  assert.equal(missing.status,404);
  assert.deepEqual(calls.at(-1),{path,authorization:undefined,browse:'public-v2'});
});
