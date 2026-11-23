import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {recipeCreationUrl} from '../public/create.mjs';
import {recipeDraftsUrl,recipeHandoffUrl} from '../public/app-links.mjs';
import {createRecipeWeb} from '../server.mjs';
const source=(await readFile(new URL('../public/create.mjs',import.meta.url),'utf8')).replace(/^import .*\n/m,'').replace('export {recipeCreationUrl};','');
async function listen(t,channel){const server=createRecipeWeb({RECIPE_DESKTOP_CHANNEL:channel});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});return 'http://127.0.0.1:'+server.address().port;}

test('creation links use only the server-selected exact desktop channel',()=>{
 assert.equal(recipeCreationUrl('preview'),'vonvon-preview://recipes/create');assert.equal(recipeCreationUrl('stable'),'vonvon://recipes/create');
 for(const channel of ['','evil','preview?next=other',null,undefined])assert.equal(recipeCreationUrl(channel),undefined);
});

test('community and creation guide share navigation and the trusted App link',async t=>{
 for(const channel of ['preview','stable']){
  const host=await listen(t,channel);let common;
  for(const path of ['/?channel=evil','/studio']){
   const response=await fetch(host+path);assert.equal(response.status,200);const html=await response.text();
   assert.ok(!html.includes('__DESKTOP_CHANNEL__'));assert.ok(!html.includes('__RECIPE_CREATE_URL__'));
   const dom=new JSDOM(html);t.after(()=>dom.window.close());const {document}=dom.window;
   assert.equal(document.documentElement.dataset.recipeCreateUrl,recipeCreationUrl(channel));
   const links=[...document.querySelectorAll('header nav a')].filter(a=>a.getAttribute('href')!=='/account').map(a=>[a.textContent,new URL(a.getAttribute('href'),host).pathname]);
   if(common)assert.deepEqual(links,common);else common=links;
   assert.equal(document.querySelector('header nav a[href="/studio"]'),null);
   const action = document.querySelector('[data-create-site]');
   const redirect = await fetch(host + action.getAttribute('href'), {redirect:'manual'});
   assert.equal(redirect.status,303);
   const signIn = new URL(redirect.headers.get('location'),host);
   assert.equal(signIn.pathname,'/login');
   assert.equal(signIn.searchParams.get('returnTo'),'/create');
   assert.equal(signIn.searchParams.get('backTo'),path.startsWith('/?') ? '/' : path);
  }
  assert.equal((await fetch(host+'/create.mjs')).status,200);
 }
});

test('account settings provide a link back to the community and omit recipe creator controls',async t=>{
 const host=await listen(t,'preview');
 const response=await fetch(host+'/account');
 assert.equal(response.status,200);
 const dom=new JSDOM(await response.text());t.after(()=>dom.window.close());
 const {document}=dom.window;
 assert.equal(document.querySelector('.account-mast .brand').getAttribute('href'),'/');
 assert.equal(document.querySelector('[data-create-site]'),null);
});

test('opening creation is user-driven and offers a download fallback without website authoring or writes',t=>{
 const dom=new JSDOM('<html data-desktop-channel="preview"><body><a data-create-recipe href="vonvon-preview://recipes/create">分享我的配方</a></body></html>',{url:'https://recipes.example',runScripts:'outside-only'});t.after(()=>dom.window.close());
 const {window}=dom;let writes=0;window.fetch=()=>{writes++;throw Error('no network expected');};
 window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 Object.assign(window,{recipeCreationUrl,recipeDraftsUrl,recipeHandoffUrl});window.eval(source);assert.equal(window.document.querySelector('dialog'),null);
 window.document.addEventListener('click',e=>e.preventDefault());window.document.querySelector('a').click();
 const dialog=window.document.querySelector('dialog');assert.equal(dialog.open,true);assert.match(dialog.textContent,/选择已有 Bot 和群聊/);
 assert.match(dialog.textContent,/需要使用本轮验收的 Vonvon Bot Preview/);
 assert.equal(dialog.querySelector('a[href="https://vonvon.cc/get/"]').textContent,'了解正式版');
 assert.equal(dialog.querySelector('a[href="vonvon-preview://recipes/create"]').textContent,'重新打开 Preview');
 assert.equal(dialog.querySelector('form,input,textarea'),null);assert.equal(writes,0);
});
