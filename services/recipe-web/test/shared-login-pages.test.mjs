import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {createRecipeWeb} from '../server.mjs';
async function fixture(t){
 const server=createRecipeWeb();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const origin='http://127.0.0.1:'+server.address().port;
 const page=async path=>{const response=await fetch(origin+path);assert.equal(response.status,200);const text=await response.text();const dom=new JSDOM(text);t.after(()=>dom.window.close());return {response,text,document:dom.window.document};};
 return {origin,page};
}
test('ordinary and App login plus legacy aliases serve one real two-panel template and product previews',async t=>{
 const f=await fixture(t);let body;
 for(const [path,mode,referrer] of [['/login','web','same-origin'],['/login?mode=app','app','no-referrer'],['/auth/native','app','no-referrer'],['/auth/native/complete','app','no-referrer']]){
  const p=await f.page(path);
  assert.equal(p.document.documentElement.dataset.loginMode,mode);assert.equal(p.document.querySelector('meta[name=referrer]').content,referrer);assert.equal(p.response.headers.get('referrer-policy'),referrer);
  assert.doesNotMatch(p.document.querySelector('#login-help').textContent,/Apple/);assert.equal(p.document.querySelectorAll('#web-login-panel').length,1);assert.equal(p.document.querySelectorAll('#native-login-panel').length,1);
  assert.equal(p.document.querySelector('#native-login-panel h1').textContent,'登录 Vonvon Bot App');assert.equal(p.document.querySelector('#web-login-panel h1').textContent,'登录 Vonvon');
  assert.deepEqual([...p.document.querySelectorAll('.auth-promo figure img')].map(img=>img.getAttribute('src')),['/login-join.webp','/login-provider.webp','/login-product.webp']);assert.equal(p.document.querySelector('.brand img').getAttribute('src'),'/community-logo.webp');
  assert.equal(p.document.querySelector('.auth-mast .brand').textContent,'Vonvon Bot');assert.equal(p.document.querySelectorAll('header a,header button').length,1);assert.equal(p.document.querySelector('header [data-create-recipe]'),null);assert.equal(p.document.querySelector('#site-account'),null);
  for(const script of ['/login.mjs','/native.mjs'])assert.ok(p.document.querySelector('script[src="'+script+'"]'));
  if(body)assert.equal(p.document.body.innerHTML,body,'mode selects visibility without duplicating the login page template');else body=p.document.body.innerHTML;
  const csp=p.response.headers.get('content-security-policy');assert.match(csp,/script-src 'self'/);assert.match(csp,/object-src 'none'/);assert.match(csp,/frame-ancestors 'none'/);assert.doesNotMatch(csp,/unsafe-inline/);assert.equal(p.response.headers.get('cache-control'),'no-store');
 }
 const css=await fetch(f.origin+'/login.css').then(r=>r.text());assert.match(css,/html\[data-login-mode=app\] #web-login-panel/);assert.match(css,/#native-login-panel/);
 for(const name of ['login-join.webp','login-provider.webp','login-product.webp','community-logo.webp']){
  const response=await fetch(f.origin+'/'+name);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/webp');
  const actual=Buffer.from(await response.arrayBuffer()),expected=await readFile(new URL('../public/'+name,import.meta.url));
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex');assert.equal(sha(actual),sha(expected));assert.ok(actual.length>100);
 }
});
test('shared login keeps return paths strict and never reflects upstream error descriptions',async t=>{
 const f=await fixture(t);
 for(const returnTo of ['https://evil.example','//evil.example','/auth/native','/login','/library?state=unknown','/library?state=all&state=published','/account?expected=private']){
  const p=await f.page('/login?'+new URLSearchParams({returnTo,auth:'failed',error_description:'ATTACKER_DESCRIPTION'}));assert.equal(decodeURIComponent(p.document.documentElement.dataset.loginReturnTo),'/');assert.equal(p.document.documentElement.dataset.loginError,'failed');assert.ok(!p.text.includes('ATTACKER_DESCRIPTION'));
 }
 for(const state of ['all','acquired','drafts','published']){
  const returnTo='/library?state='+state,p=await f.page('/login?'+new URLSearchParams({returnTo,auth:'cancelled'}));assert.equal(decodeURIComponent(p.document.documentElement.dataset.loginReturnTo),returnTo);assert.equal(p.document.documentElement.dataset.loginError,'cancelled');
 }
});
