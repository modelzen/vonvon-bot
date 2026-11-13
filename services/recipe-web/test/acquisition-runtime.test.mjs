import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {JSDOM} from 'jsdom';

const recipe={recipeId:'11111111-1111-4111-8111-111111111111',versionId:'22222222-2222-4222-8222-222222222222',revision:1,
  public:{name:'合成配方',summary:'summary',overview:'',version:'1',access:'coded'},owned:false,acquired:false};
const route='/recipes/'+recipe.recipeId+'/versions/'+recipe.versionId;
const source=(await readFile(new URL('../public/app.mjs',import.meta.url),'utf8')).replace("import {setupList} from './setup.mjs';", "const setupList=()=>document.createElement('div');");
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function runtime(t,respond) {
  const dom=new JSDOM('<main id="main"></main><dialog id="modal"></dialog><button id="account"></button><div id="feedback"></div>',{url:'https://recipes.example'+route});
  const {window}=dom;
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const calls=[];
  const fetch=async (path,options={})=>{
    calls.push({path,options});
    if(path==='/auth/session')return Response.json({signedIn:true,displaySession:'session-a',providers:[]});
    return respond(path,options,calls);
  };
  const run=new AsyncFunction('document','window','location','history','navigator','crypto','fetch','BroadcastChannel','setTimeout','clearTimeout','setup',source+'\nreturn {detail,claim,setSession:value=>{session=value;}};');
  const api=await run(window.document,window,window.location,window.history,window.navigator,webcrypto,fetch,undefined,
    (fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout);
  t.after(()=>window.close());
  const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();await new Promise(setImmediate);};
  async function open() {
    const button=[...window.document.querySelectorAll('button')].find(b=>b.textContent==='获取配方');
    assert.ok(button);button.click();await settle();
    return window.document.querySelector('form');
  }
  async function submit(form,raw='AB-CD') {
    form.querySelector('input').value=raw;
    form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
  }
  return {dom,api,calls,open,submit,settle,document:window.document};
}
test('actual Web runtime retains raw/key after committed response loss and confirms exact-session entitlement',async t=>{
  let acquired=false,attempts=0;
  const h=await runtime(t,async(path,options)=>{
    if(options.method==='POST'){acquired=true;if(++attempts===1)throw new Error('lost after commit');return Response.json({});}
    return Response.json({...recipe,acquired});
  });
  const form=await h.open();await h.submit(form);
  assert.match(form.textContent,/暂未确认/);
  await h.submit(form);
  const posts=h.calls.filter(c=>c.options.method==='POST');
  assert.equal(posts.length,2);assert.equal(posts[0].options.headers['Idempotency-Key'],posts[1].options.headers['Idempotency-Key']);
  assert.match(posts[0].options.headers['Idempotency-Key'],/^a2\./);
  assert.equal(posts[0].options.body,'{"code":"AB-CD"}');
  assert.equal(h.document.querySelector('dialog').open,false);
  const reads=h.calls.filter(c=>c.path.startsWith('/api/v1/recipes/'));
  assert.ok(reads.every(c=>c.options.headers['X-Vonvon-Session']==='session-a'));
});
for(const failure of ['operation_expired','request_upgrade_required']) test(`actual Web runtime reconciles ${failure}, keeps offline input, and requires another explicit submit before changing keys`,async t=>{
  let reads=0,offline=true;
  const h=await runtime(t,async(_path,options)=>{
    if(options.method==='POST')return Response.json({error:{code:failure}},{status:failure==='operation_expired'?410:409});
    if(++reads>1 && offline)throw new Error('offline detail');
    return Response.json(recipe);
  });
  const form=await h.open();await h.submit(form);
  assert.match(form.textContent,/暂未确认/);assert.equal(form.querySelector('input').value,'AB-CD');
  const first=h.calls.find(c=>c.options.method==='POST').options.headers['Idempotency-Key'];
  offline=false;await h.submit(form);
  assert.match(form.textContent,/再次点击/);
  let posts=h.calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,2);assert.equal(posts[1].options.headers['Idempotency-Key'],first);
  await h.submit(form);posts=h.calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,3);assert.notEqual(posts[2].options.headers['Idempotency-Key'],first);
});
test('actual Web runtime never maps clock/quota failures to code-invalid and does not loop',async t=>{
  let code='operation_clock_skew';
  const h=await runtime(t,async(_path,options)=>options.method==='POST'?Response.json({error:{code}},{status:code==='acquire_rate_limited'?429:422,headers:{'Retry-After':'60'}}):Response.json(recipe));
  const form=await h.open();await h.submit(form);assert.match(form.textContent,/校准设备时间/);
  code='acquire_rate_limited';await h.submit(form);assert.match(form.textContent,/60 秒/);
  assert.doesNotMatch(form.textContent,/无法兑换/);assert.equal(form.querySelector('input').value,'AB-CD');
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,2);
});
test('actual Web runtime ignores late route A-B-A results and leaves a newly opened dialog intact',async t=>{
  let finish;
  const h=await runtime(t,async(_path,options)=>options.method==='POST'?new Promise(resolve=>{finish=resolve;}):Response.json(recipe));
  const form=await h.open();await h.submit(form);
  h.dom.reconfigure({url:'https://recipes.example'+route.replace(recipe.versionId,'33333333-3333-4333-8333-333333333333')});await h.api.detail();
  h.dom.reconfigure({url:'https://recipes.example'+route});await h.api.detail();
  const newer=await h.open();newer.querySelector('input').value='NEW-INPUT';
  finish(Response.json({}));await h.settle();
  assert.equal(h.document.querySelector('dialog').open,true);assert.equal(newer.querySelector('input').value,'NEW-INPUT');
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
});

test('actual Web runtime ignores an old account response after a new account opens the same version',async t=>{
  let finish;
  const h=await runtime(t,async(_path,options)=>options.method==='POST'?new Promise(resolve=>{finish=resolve;}):Response.json(recipe));
  const old=await h.open();await h.submit(old);
  h.api.setSession({signedIn:true,displaySession:'session-b',providers:[]});await h.api.detail();
  const newer=await h.open();newer.querySelector('input').value='ACCOUNT-B-CODE';
  finish(Response.json({}));await h.settle();
  assert.equal(h.document.querySelector('dialog').open,true);assert.equal(newer.querySelector('input').value,'ACCOUNT-B-CODE');
  const lastRead=h.calls.filter(c=>c.path.startsWith('/api/v1/recipes/')).at(-1);
  assert.equal(lastRead.options.headers['X-Vonvon-Session'],'session-b');
});

for (const dismiss of ['cancel','escape']) for (const late of ['success','error']) {
  test(`actual Web runtime releases a ${dismiss} claim button and ignores late ${late} after reopening`,async t=>{
    const pending=[];
    const h=await runtime(t,async(_path,options)=>options.method==='POST'?new Promise(resolve=>pending.push(resolve)):Response.json(recipe));
    const old=await h.open(), trigger=h.document.querySelector('main .actions button:last-child');
    await h.submit(old,'Original-Code');
    assert.equal(trigger.disabled,true);
    if(dismiss==='cancel') [...old.querySelectorAll('button')].find(b=>b.textContent==='取消').click();
    else h.document.querySelector('dialog').dispatchEvent(new h.dom.window.Event('cancel',{cancelable:true}));
    await h.settle();
    assert.equal(trigger.disabled,false,'dismissing a pending claim releases the route button immediately');
    assert.equal(h.document.querySelector('dialog').open,false);
    const newer=await h.open();
    assert.equal(newer.querySelector('input').value,'Original-Code');
    await h.submit(newer,'Original-Code');
    assert.equal(trigger.disabled,true);
    pending[0](late==='success'?Response.json({}):Response.json({error:{code:'invalid_code'}},{status:422}));
    await h.settle();
    assert.equal(trigger.disabled,true,'an old finalizer cannot release a new pending claim');
    assert.equal(newer.querySelector('button.button').disabled,true);
    assert.equal(newer.querySelector('input').value,'Original-Code');
    assert.equal(newer.querySelector('.error').textContent,'');
    assert.equal(h.document.querySelector('dialog').open,true);
    const posts=h.calls.filter(c=>c.options.method==='POST');
    assert.equal(posts.length,2);assert.equal(posts[0].options.headers['Idempotency-Key'],posts[1].options.headers['Idempotency-Key']);
    pending[1](Response.json({error:{code:'rate_limited'}},{status:429}));await h.settle();
    assert.equal(trigger.disabled,false);
  });
}

test('actual Web runtime recovers after correcting the clock with a checked explicit retry',async t=>{
  const now=Date.now();const original=Date.now;let clock=now+86400000,acquired=false;
  Date.now=()=>clock;t.after(()=>{Date.now=original;});
  const h=await runtime(t,async(_path,options)=>{
    if(options.method!=='POST')return Response.json({...recipe,acquired});
    const born=parseInt(options.headers['Idempotency-Key'].slice(3).replaceAll('-','').slice(0,12),16);
    if(born>now+120000)return Response.json({error:{code:'operation_clock_skew'}},{status:422});
    acquired=true;return Response.json({});
  });
  const form=await h.open();await h.submit(form,'Ab-CD');
  assert.match(form.textContent,/校准设备时间/);assert.match(form.textContent,/再次点击/);
  assert.equal(h.calls.filter(c=>c.path.startsWith('/api/v1/recipes/')).length,2);
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
  form.querySelector('button.secondary').click();
  const reopened=await h.open();
  assert.equal(reopened.querySelector('input').value,'Ab-CD');
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
  clock=now;await h.submit(reopened,reopened.querySelector('input').value);
  const posts=h.calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,2);
  assert.notEqual(posts[0].options.headers['Idempotency-Key'],posts[1].options.headers['Idempotency-Key']);
  assert.equal(posts[1].options.body,'{"code":"Ab-CD"}');assert.equal(h.document.querySelector('dialog').open,false);
});

test('actual Web runtime retains a clock-rejected raw/key while reconciliation is offline and accepts an existing entitlement',async t=>{
  let offline=true,acquired=false,reads=0;
  const h=await runtime(t,async(_path,options)=>{
    if(options.method==='POST')return Response.json({error:{code:'operation_clock_skew'}},{status:422});
    if(++reads>1&&offline)throw new Error('offline');return Response.json({...recipe,acquired});
  });
  const form=await h.open();await h.submit(form,'Ab-CD');
  assert.match(form.textContent,/暂未确认/);assert.equal(form.querySelector('input').value,'Ab-CD');
  offline=false;acquired=true;await h.submit(form,'Ab-CD');
  const posts=h.calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,2);
  assert.equal(posts[0].options.headers['Idempotency-Key'],posts[1].options.headers['Idempotency-Key']);
  assert.equal(h.document.querySelector('dialog').open,false);assert.match(h.document.querySelector('main').textContent,/已获取/);
});

for(const transition of ['route','account']) test(`actual Web runtime ignores a late clock reconciliation after ${transition} changes`,async t=>{
  let finish,reads=0;
  const h=await runtime(t,async(_path,options)=>{
    if(options.method==='POST')return Response.json({error:{code:'operation_clock_skew'}},{status:422});
    if(++reads===2)return new Promise(resolve=>{finish=resolve;});return Response.json(recipe);
  });
  const old=await h.open();await h.submit(old,'OLD-CODE');assert.equal(typeof finish,'function');
  if(transition==='account')h.api.setSession({signedIn:true,displaySession:'session-b',providers:[]});
  else {h.dom.reconfigure({url:'https://recipes.example'+route.replace(recipe.versionId,'33333333-3333-4333-8333-333333333333')});await h.api.detail();h.dom.reconfigure({url:'https://recipes.example'+route});}
  await h.api.detail();const newer=await h.open();newer.querySelector('input').value='NEW-CODE';
  finish(Response.json({...recipe,acquired:true}));await h.settle();
  assert.equal(h.document.querySelector('dialog').open,true);assert.equal(newer.querySelector('input').value,'NEW-CODE');
  assert.doesNotMatch(h.document.querySelector('main').textContent,/已获取/);
});

test('actual Web runtime keeps the rejected clock key when a detail response names another version',async t=>{
  let reads=0;
  const h=await runtime(t,async(_path,options)=>options.method==='POST'?Response.json({error:{code:'operation_clock_skew'}},{status:422}):Response.json(++reads>1?{...recipe,versionId:'33333333-3333-4333-8333-333333333333'}:recipe));
  const form=await h.open();await h.submit(form,'Ab-CD');await h.submit(form,'Ab-CD');
  assert.match(form.textContent,/暂未确认/);assert.equal(form.querySelector('input').value,'Ab-CD');
  const posts=h.calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,2);
  assert.equal(posts[0].options.headers['Idempotency-Key'],posts[1].options.headers['Idempotency-Key']);
});

test('a confirmed grant retires the old claim action even if a later detail fetch stalls',async t=>{
  let reads=0;
  const h=await runtime(t,async(_path,options)=>{
    if(options.method==='POST')return Response.json({});
    if(++reads>2)return new Promise(()=>{});
    return Response.json({...recipe,acquired:reads===2});
  });
  const trigger=h.document.querySelector('main .actions button:last-child');
  const form=await h.open();await h.submit(form,'Ab-CD');
  trigger.click();await h.settle();
  assert.equal(h.document.querySelector('dialog').open,false);
  assert.match(h.document.querySelector('main').textContent,/已获取/);
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
});

test('a claimed detail from a previous account cannot open a dialog for the current session',async t=>{
  const h=await runtime(t,async()=>Response.json(recipe));
  const trigger=h.document.querySelector('main .actions button:last-child');
  h.api.setSession({signedIn:true,displaySession:'session-b',providers:[]});
  trigger.click();await h.settle();
  assert.equal(h.document.querySelector('dialog').open,false);
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);
});
