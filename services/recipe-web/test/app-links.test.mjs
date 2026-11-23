import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {recipeCreationUrl,recipeDraftsUrl,recipeHandoffUrl} from '../public/app-links.mjs';
const recipe='abcdef12-1234-4234-8234-abcdef123456',version='11111111-1111-4111-8111-111111111111';
const source=(await readFile(new URL('../public/create.mjs',import.meta.url),'utf8')).replace(/^import .*\n/m,'').replace('export {recipeCreationUrl};','');
function runtime(t,channel='preview'){
 const dom=new JSDOM('<html><body></body></html>',{url:'https://recipes.example',runScripts:'outside-only'});t.after(()=>dom.window.close());const {window}=dom;window.document.documentElement.dataset.desktopChannel=channel;
 window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 let prevented,writes=0;window.fetch=()=>{writes++;throw Error('No network allowed');};Object.assign(window,{recipeCreationUrl,recipeDraftsUrl,recipeHandoffUrl});window.eval(source);
 window.document.addEventListener('click',event=>{prevented=event.defaultPrevented;event.preventDefault();});
 const click=(attribute,href,ids={recipeId:recipe,versionId:version})=>{const anchor=window.document.createElement('a');anchor.setAttribute(attribute,'');anchor.setAttribute('href',href);Object.assign(anchor.dataset,ids);const child=window.document.createElement('span');child.textContent='打开 App';anchor.append(child);window.document.body.append(anchor);child.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true}));return {anchor,prevented,dialog:window.document.querySelector('dialog')};};
 return {window,document:window.document,click,writes:()=>writes,wasPrevented:()=>prevented};
}
test('shared helpers emit exact channel URIs with canonical UUIDs and no query or hash',()=>{
 for(const [channel,scheme] of [['stable','vonvon'],['preview','vonvon-preview']]){
  assert.equal(recipeCreationUrl(channel),scheme+'://recipes/create');assert.equal(recipeDraftsUrl(channel),scheme+'://recipes/drafts');
  assert.equal(recipeHandoffUrl(channel,recipe.toUpperCase(),version),scheme+'://recipes/'+recipe+'/versions/'+version+'/handoff');
 }
 for(const channel of [null,undefined,'','production','preview?x=1','stable#hash'])for(const helper of [recipeCreationUrl,recipeDraftsUrl,recipeHandoffUrl])assert.equal(helper(channel,recipe,version),undefined);
 for(const invalid of [null,undefined,'x',recipe+'?x=1',recipe+'#x','/'+recipe,recipe+'/',recipe.replace('-4234-','-0234-'),recipe.replace('-8234-','-1234-')]){
  assert.equal(recipeHandoffUrl('preview',invalid,version),undefined);assert.equal(recipeHandoffUrl('preview',recipe,invalid),undefined);
 }
});
test('all three valid explicit actions retain default system opening and explain truthful fallback without writes',t=>{
 for(const channel of ['preview','stable']){
  const h=runtime(t,channel);assert.equal(h.document.querySelector('dialog'),null);
  for(const [kind,url,copy] of [['data-create-recipe',recipeCreationUrl(channel),/本地整理和预览，确认发布后才上传/],['data-app-drafts',recipeDraftsUrl(channel),/本地「创作中」/],['data-handoff-recipe',recipeHandoffUrl(channel,recipe,version),/指定版本.*选择 Bot.*不会自动获取、发送或安装/s]]){
   const result=h.click(kind,url);assert.equal(result.prevented,false);assert.equal(result.dialog.open,true);assert.match(result.dialog.textContent,copy);
   assert.equal(result.dialog.querySelector('a.button').getAttribute('href'),url);assert.equal(result.dialog.querySelector('a.secondary').href,'https://vonvon.cc/get/');
   assert.equal(result.dialog.querySelector('form,input,textarea'),null);assert.doesNotMatch(result.dialog.textContent,/检测到.*已安装|已自动安装|已自动发送/);
   result.dialog.querySelector('button').click();assert.equal(result.dialog.open,false);assert.equal(h.writes(),0);
  }
  assert.equal(h.document.querySelectorAll('dialog').length,1);
 }
});
test('wrong channel, tampered queries/fragments, malformed IDs and ambiguous action markers are prevented',t=>{
 const h=runtime(t);
 for(const [kind,url,ids] of [
  ['data-create-recipe','vonvon://recipes/create'],['data-create-recipe','vonvon-preview://recipes/create?from=web'],
  ['data-app-drafts','vonvon://recipes/drafts'],['data-app-drafts','vonvon-preview://recipes/drafts#x'],
  ['data-handoff-recipe',recipeHandoffUrl('preview',recipe,version)+'?x=1'],['data-handoff-recipe',recipeHandoffUrl('preview',recipe,version)+'#x'],
  ['data-handoff-recipe',recipeHandoffUrl('stable',recipe,version)],['data-handoff-recipe',recipeHandoffUrl('preview',recipe,version),{recipeId:recipe,versionId:'invalid'}],
  ['data-handoff-recipe',recipeHandoffUrl('preview',recipe,version),{}],
 ]){const result=h.click(kind,url,ids);assert.equal(result.prevented,true);assert.equal(result.dialog,null);}
 const valid=h.click('data-create-recipe',recipeCreationUrl('preview'));valid.anchor.setAttribute('data-app-drafts','');valid.anchor.dispatchEvent(new h.window.MouseEvent('click',{bubbles:true,cancelable:true}));
 assert.equal(h.wasPrevented(),true);assert.equal(h.writes(),0);assert.equal(h.document.querySelectorAll('dialog').length,1);
});
test('unknown desktop channel cannot open any App action',t=>{
 const h=runtime(t,'unknown');for(const attribute of ['data-create-recipe','data-app-drafts','data-handoff-recipe'])assert.equal(h.click(attribute,'vonvon-preview://recipes/create').prevented,true);
 assert.equal(h.document.querySelector('dialog'),null);
});
