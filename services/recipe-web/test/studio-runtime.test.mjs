import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

test('the shipped creator form keeps older notes read-only and never creates a separate setup', async t => {
  const html=await readFile(new URL('../public/studio.html',import.meta.url),'utf8');
  const source=(await readFile(new URL('../public/studio.mjs',import.meta.url),'utf8')).replace("import {credentialField} from '/credential-shapes.mjs';",'const credentialField=()=>undefined;');
  const dom=new JSDOM(html,{url:'https://recipes.example/studio',runScripts:'outside-only'});
  t.after(()=>dom.window.close());
  const {window}=dom, id='11111111-1111-4111-8111-111111111111', writes=[];
  const legacy={steps:[{kind:'tool',title:'旧说明',instructions:'LEGACY_PRIVATE_NOTES',check:'核对工具',required:true}]};
  const original={draftId:id,revision:1,public:{name:'旧配方',summary:'简介',overview:'作者介绍',version:'1.0',access:'coded'},config:{role:'原角色',setup:legacy}};
  window.fetch=async (path,options={})=>{
    if(path==='/auth/session')return Response.json({signedIn:true,displaySession:'test-session'});
    if(path==='/api/v1/me/drafts')return Response.json({items:[original]});
    if(path==='/api/v2/me/publications')return Response.json({items:[]});
    if(path==='/api/v1/drafts/'+id&&(!options.method||options.method==='GET'))return Response.json(original);
    if(path==='/api/v1/drafts/'+id||path==='/api/v1/drafts'){
      const body=JSON.parse(options.body);writes.push(body);return Response.json({draftId:id,revision:2,...body});
    }
    throw Error('Unexpected form request '+path);
  };
  const wait=async condition=>{for(let i=0;i<50&&!condition();i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(condition());};
  window.eval(source);
  await wait(()=>[...window.document.querySelectorAll('#drafts button')].some(button=>button.textContent==='打开'));
  const click=label=>[...window.document.querySelectorAll('button')].find(button=>button.textContent===label).click();
  click('打开');await wait(()=>!window.document.querySelector('#editor').hidden);
  assert.equal(window.document.querySelector('#add-setup'),null);
  assert.equal(window.document.querySelector('[data-field="instructions"]'),null);
  assert.match(window.document.querySelector('#additional-notes').textContent,/LEGACY_PRIVATE_NOTES/);
  const input=window.document.querySelector('input[name="name"]');input.value='改过的名称';input.dispatchEvent(new window.Event('input',{bubbles:true}));
  window.document.querySelector('#editor').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await wait(()=>writes.length===1);assert.deepEqual(writes[0].config,{role:'原角色',setup:legacy});
  await wait(()=>!window.document.querySelector('#new').disabled);window.document.querySelector('#new').click();
  assert.equal(window.document.querySelector('#additional-notes').hidden,true);
  window.document.querySelector('#editor').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await wait(()=>writes.length===2&&!window.document.querySelector('#new').disabled);assert.equal(Object.hasOwn(writes[1].config,'setup'),false);
});
