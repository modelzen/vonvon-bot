import {credentialField} from '/credential-shapes.mjs';
const $ = id => document.getElementById(id);
const editor=$('editor'), fields=editor.elements, confirmDialog=$('confirm');
let generation=null;
let model=null, reviewing=null, managing=null, cursor=null, loading=false, changed=false, notesRemoved=false;
const keys=new Map();
const text=(id,v)=>$(id).textContent=v;
const show=(id,on)=>$(id).hidden=!on;
const errorMessages={login_required:'请先登录。',conflict:'草稿已在其他地方变更。你的输入仍在这里；请先重新打开最新草稿，再决定如何修改。',quota_exceeded:'已达到账号或版本的限额，请检查草稿或稍后再试。',rate_limited:'操作过于频繁，请稍后再试。',auth_required:'登录已过期，请重新登录。',invalid_input:'请检查输入长度、版本和获取方式。',incomplete_setup:'这份旧草稿的补充说明尚未完整。请核对并移除旧补充说明，保存后再发布。',forbidden:'当前账号不能进行这项操作。',not_found:'没有找到这份草稿或版本。'};
async function api(path,{method='GET',body,rev,logical,version=1}={}){
  const headers={};if(method!=='GET'){
    headers['content-type']='application/json';
    headers['x-vonvon-session']=generation??'';
    if(!keys.has(logical))keys.set(logical,crypto.randomUUID());
    headers['idempotency-key']=keys.get(logical);
    if(rev!==undefined)headers['if-match']='"'+rev+'"';
  }
  const resp=await fetch('/api/v'+version+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});
  const data=await resp.json();
  if(!resp.ok){const code=data.error?.code;if(code==='credential_detected')throw new Error(credentialMessage(data.error.field));if(code==='session_changed'){forget();location.replace('/studio');throw new Error('账号已切换。');}if(resp.status===401)show('login',true);throw new Error(errorMessages[code]||'请求未完成。请重试同一操作。');}
  if(method!=='GET')keys.delete(logical);
  return data;
}
function button(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>run(fn);return b;}
function row(id,label,...buttons){const li=document.createElement('li'),s=document.createElement('span');s.textContent=label;li.append(s,...buttons);$(id).append(li);}
async function run(fn){
  if(loading)return;
  loading=true;
  const controls=[...document.querySelectorAll('#workspace button:not(:disabled),dialog button:not(:disabled),#editor input,#editor textarea,#editor select')];
  controls.forEach(b=>b.disabled=true);
  let focus;
  try{await fn();}catch(e){text('notice',e.message||'无法完成请求，请重试。');focus=e.control;}
  finally{controls.forEach(b=>b.disabled=false);loading=false;focus?.focus();}
}
const metaLabels={'public.name':'名称','public.summary':'简介','public.overview':'公开概览','public.version':'版本','config.role':'角色说明'};
function setupMatch(path){return /^config\.setup\.steps\.(\d+)\.(title|instructions|check)$/.exec(path);}
function credentialMessage(field){
  const match=setupMatch(field);
  const label=match?'补充说明 '+(Number(match[1])+1):metaLabels[field]||'配方文字';
  return label+'中似乎有密钥或令牌。请移除后再保存。';
}
function renderNotes(host,notes=[]){
  host.replaceChildren();
  for(const note of notes){
    const title=document.createElement('h3'),body=document.createElement('p');
    title.textContent=note.title||'说明';body.textContent=note.instructions;host.append(title,body);
    if(note.check){const check=document.createElement('p');check.textContent='核对方式：'+note.check;host.append(check);}
  }
}
function contents(){
  const config={...model.config,role:fields.role.value};if(notesRemoved)delete config.setup;
  return {public:{name:fields.name.value,summary:fields.summary.value,overview:fields.overview.value,version:fields.version.value,access:fields.access.value},config};
}
function scopeLabel(){text('scope-label',fields.access.value==='coded'?'配方配置仅自己和已获取此版本的人可见。':'配方配置在社区公开展示。');}
fields.access.addEventListener('change',scopeLabel);
function fill(d){
  notesRemoved=false;
  model=d??{draftId:null,revision:0,recipeId:null,public:{name:'',summary:'',overview:'',version:'1.0',access:'direct'},config:{role:''}};
  for(const [k,v] of Object.entries(model.public))if(fields[k])fields[k].value=v;
  fields.role.value=model.config?.role||'';renderNotes($('additional-notes-body'),model.config?.setup?.steps);show('additional-notes',Boolean(model.config?.setup?.steps.length));scopeLabel();changed=false;show('editor',true);show('result',false);text('notice','');
}
function discardOK(){return !changed||window.confirm('离开会放弃尚未保存的修改。继续吗？');}
async function loadDrafts(){
  const d=await api('/me/drafts');$('drafts').replaceChildren();
  if(!d.items.length)row('drafts','还没有私人草稿。');
  for(const v of d.items){
    row('drafts',v.public?.name||'未命名草稿',button('打开',async()=>{if(discardOK())fill(await api('/drafts/'+v.draftId));}),
      button('删除',async()=>{if(!window.confirm('删除这份私人草稿？此操作无法撤销。'))return;
        await api('/drafts/'+v.draftId,{method:'DELETE',body:{},rev:v.revision,logical:'delete:'+v.draftId+':'+v.revision});
        if(model?.draftId===v.draftId){model=null;changed=false;show('editor',false);}await loadDrafts();text('notice','草稿已删除。');
      }));
  }
}
async function save(){
  if(model.draftId&&!changed)return model;
  const body=contents();const suspicious=credentialField(body);if(suspicious){
    const error=new Error(credentialMessage(suspicious)),match=setupMatch(suspicious);
    error.control=match?$('additional-notes'):fields[suspicious.split('.')[1]];
    throw error;
  }if(!model.draftId&&model.recipeId){body.recipeId=model.recipeId;body.sourceVersionId=model.versionId;}
  const tag='save:'+model.draftId+':'+model.revision+':'+JSON.stringify(body);
  const res=await api('/drafts'+(model.draftId?'/'+model.draftId:''),{method:model.draftId?'PATCH':'POST',body,rev:model.draftId?model.revision:undefined,logical:tag});
  model=res;changed=false;notesRemoved=false;await loadDrafts();return res;
}
async function history(){
  const result=await api('/me/publications',{version:2});$('history').replaceChildren();
  text('record-note',result.items.length?'':'发布后，你可以在这里查看版本和管理分享码。');
  const latest=new Map();for(const v of result.items)latest.set(v.recipeId,Math.max(latest.get(v.recipeId)||0,v.revision));
  for(const v of result.items){
    const name=v.public.name+' · '+v.public.version;
    const a=document.createElement('a');a.href='/recipes/'+v.recipeId+'/versions/'+v.versionId;a.textContent='查看';
    const buttons=[a];if(v.format==='rich-v2')buttons.push(button('如何编辑',()=>{text('notice','请在 Vonvon Bot App 的创作中心准备新版，核对所选来源和内容后再确认发布。');}));
    else if(v.revision===latest.get(v.recipeId))buttons.push(button('准备新版',async()=>{
      if(!discardOK())return;
      const data=await api('/recipes/'+v.recipeId+'/versions/'+v.versionId);
      fill({...data,public:{...data.public,version:''},draftId:null,revision:0});changed=true;fields.version.focus();
    }));
    if(v.public.access==='coded')buttons.push(button('分享码',async()=>{managing=v;show('codes',true);text('code-for',name);text('newcodes','');await listCodes(false);$('codes').scrollIntoView();}));
    row('history',name,...buttons);
  }
}
async function listCodes(append){
  const data=await api('/versions/'+managing.versionId+'/codes'+(append&&cursor?'?cursor='+encodeURIComponent(cursor):''));
  if(!append)$('code-list').replaceChildren();cursor=data.nextCursor;show('more',Boolean(cursor));
  const labels={available:'可用',redeemed:'已兑换',disabled:'已停用'};
  for(const c of data.items){
    const ops=[];
    if(c.status==='available'){
      ops.push(button('显示',async()=>{const r=await api('/codes/'+c.codeId+'/reveal',{method:'POST',body:{},logical:'reveal:'+c.codeId});text('newcodes',r.code);}));
      ops.push(button('停用',async()=>{if(!window.confirm('停用这枚未使用的分享码？'))return;await api('/codes/'+c.codeId+'/disable',{method:'POST',body:{},logical:'disable:'+c.codeId});text('newcodes','');await listCodes(false);}));
    }
    row('code-list','…'+c.suffix+' · '+(labels[c.status]||c.status),...ops);
  }
}
$('new').onclick=()=>{if(discardOK())fill(null);};
$('remove-legacy-notes').onclick=()=>{notesRemoved=true;changed=true;reviewing=null;$('additional-notes-body').replaceChildren();show('additional-notes',false);text('notice','旧补充说明已从当前编辑内容移除，保存后生效。');};
editor.oninput=()=>{changed=true;};
editor.onsubmit=e=>{e.preventDefault();run(async()=>{await save();text('notice','私人草稿已保存。');});};
$('review').onclick=()=>run(async()=>{
  if(!fields.name.value.trim()||!fields.summary.value.trim()||!fields.version.value.trim()){text('notice','先填写配方名称、简介和版本，再预览发布。');return;}
  const d=await save();reviewing={id:d.draftId,rev:d.revision};
  $('preview').replaceChildren();
  for(const [k,v] of Object.entries({'名称':d.public.name,'简介':d.public.summary,'公开概览':d.public.overview,'版本':d.public.version,'获取方式':d.public.access==='coded'?'凭分享码获取':'直接获取',[d.public.access==='coded'?'仅获取者和作者可见 · 角色说明':'公开 · 角色说明']:d.config.role})){
    const a=document.createElement('dt'),b=document.createElement('dd');a.textContent=k;b.textContent=v;$('preview').append(a,b);
  }
  if(d.config.setup?.steps.length){
    const label=document.createElement('dt'),body=document.createElement('dd');
    label.textContent=d.public.access==='coded'?'仅获取者和作者可见 · 补充说明':'公开 · 补充说明';
    renderNotes(body,d.config.setup.steps);$('preview').append(label,body);
  }
  confirmDialog.showModal();
});
$('back').onclick=()=>confirmDialog.close();
$('publish').onclick=()=>run(async()=>{
  const {id,rev}=reviewing;
  let v;try{v=await api('/drafts/'+id+'/publish',{method:'POST',body:{},rev,logical:'publish:'+id+':'+rev});}finally{confirmDialog.close();}
  model=null;changed=false;show('editor',false);show('result',true);
  $('published').href='/recipes/'+v.recipeId+'/versions/'+v.versionId;text('initial-code',v.firstCode?'首枚分享码：'+v.firstCode:'');text('notice','本版本已发布。');await Promise.all([history(),loadDrafts()]);
});
$('issue').onclick=()=>run(async()=>{const count=Number($('amount').value);if(!Number.isInteger(count)||count<1||count>100)throw new Error('请选择 1–100 枚。');const r=await api('/versions/'+managing.versionId+'/codes',{method:'POST',body:{count},logical:'issue:'+managing.versionId+':'+count});text('newcodes',r.items.map(c=>c.code).join('\n'));await listCodes(false);});
$('more').onclick=()=>run(()=>listCodes(true));
window.addEventListener('beforeunload',e=>{if(changed){e.preventDefault();e.returnValue='';}});
run(async()=>{const s=await fetch('/auth/session',{cache:'no-store'}).then(r=>r.json());if(!s.signedIn){show('login',true);return;}generation=s.displaySession;show('workspace',true);await Promise.all([loadDrafts(),history()]);});

window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});

function forget(){changed=false;notesRemoved=false;model=null;reviewing=null;managing=null;generation=null;keys.clear();editor.reset();$('additional-notes-body').replaceChildren();show('additional-notes',false);confirmDialog.close();for(const id of ['drafts','history','code-list','initial-code','newcodes','preview','code-for'])$(id).replaceChildren();show('workspace',false);}
async function checkSession(){
  if(!generation||document.hidden)return;
  try {
    const res=await fetch('/auth/session',{cache:'no-store'});
    if(res.ok&&(await res.json()).displaySession!==generation){forget();location.replace('/studio');}
  } catch { /* unconfirmed network failure must not discard an author's draft */ }
}
window.addEventListener('focus',checkSession);document.addEventListener('visibilitychange',checkSession);
window.addEventListener('storage',checkSession);
const authEvents=typeof BroadcastChannel==='function'?new BroadcastChannel('vv-recipe-auth'):null;
if(authEvents){authEvents.onmessage=checkSession;authEvents.postMessage('check');}
