const {app, BrowserWindow, ipcMain} = require('electron');
const assert = require('node:assert/strict');
const {mkdtempSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const home = mkdtempSync(path.join(tmpdir(), 'vonvon-management-ui-'));
app.setPath('userData', path.join(home, 'electron'));
const agentId = 'cli_management', groupId = 'oc_management';
const secondAgentId = 'cli_second', secondGroupId = 'oc_second';
const distPath = path.resolve(process.env.MANAGEMENT_DIST || 'dist');
const calls = [], results = [];
let project = {name:'Management Project', chatId:groupId, cwd:path.join(home,'project'), kind:'single', enabled:true, backend:'codex-appserver', revision:'r1'};
let currentRun = {id:'run-fixture',goal:true,canStop:true,canEndGoal:true,canRemind:true,reminderRequested:false};
let rejectProject = false, rejectShare = false, holdShare = false, resolveShare, window, reorderHistory = false;
const snapshot = {
  revision:1, observedAt:Date.now(), stale:false, host:{kind:'connected',ownership:'owned',version:'0.7.0'},
  agents:[{id:agentId,name:'Management Agent',enabled:true,connection:'connected',activation:'active'},{id:secondAgentId,name:'Second Agent',enabled:false,running:false,connection:'disconnected',activation:'active'}],
  groups:[{id:groupId,name:project.name},{id:secondGroupId,name:'Second Group'}],
  memberships:[{id:'membership_management',agentId,groupId,name:project.name,cwd:project.cwd,backend:'codex-appserver',conversation:'shared',response:'mention',administrator:'write',member:'qa',network:false,stale:false},{id:'membership_second',agentId:secondAgentId,groupId:secondGroupId,name:'Second Binding',cwd:path.join(home,'second'),backend:'claude-agent',conversation:'shared',response:'mention',administrator:'write',member:'qa',network:false,stale:false}],
  tools:[],jobs:[],diagnostics:[],application:{platform:'macos',version:'0.7.0',loginItem:false,dataPath:home},
};
function publish(){snapshot.revision++;window.webContents.send('bridge:snapshot',snapshot);}
ipcMain.handle('bridge:watch',()=>snapshot);
ipcMain.handle('bridge:settings',()=>({kind:'refused',code:'fixture',message:'Settings covered by separate native scenarios.'}));
ipcMain.handle('bridge:run',(_event,command)=>{
  if(command.type==='listPendingGroups')return {command:command.type,result:{kind:'pendingGroups',groups:[]}};
  if(command.type==='chooseFolder')return {command:command.type,result:{kind:'folderChosen',folder:{token:'12345678-1234-4234-8234-123456789012',displayPath:path.join(home,'chosen')}}};
  assert.equal(command.type,'refresh');publish();return {command:command.type,result:{kind:'applied',revision:snapshot.revision}};
});
ipcMain.handle('bridge:collaboration',(_event,request)=>{
  calls.push(request);
  if(request.action!=='usage' && request.action!=='shareUsage')assert.equal(request.agentId,agentId);
  if(request.groupId && request.action!=='shareUsage')assert.equal(request.groupId,groupId);
  if(['context','compact','clear','startGoal','reminder','stop','endGoal'].includes(request.action))assert.equal(request.threadId,'thread_current',JSON.stringify(request));
  switch(request.action){
    case 'project':return {kind:'project',project};
    case 'history':{
      const sessions=[{threadId:'thread_current',sessionId:'session_current',chatId:groupId,summary:'Current session',backend:'codex-appserver',updatedAt:Date.now()},{threadId:'thread_other',sessionId:'session_other',chatId:groupId,summary:'Other bound session',backend:'codex-appserver',updatedAt:Date.now()},{threadId:'thread_archived',sessionId:'session_archived',chatId:groupId,summary:'Archived session',backend:'codex-appserver',detached:true,updatedAt:Date.now()}];
      return {kind:'history',backend:'codex-appserver',sessions:reorderHistory ? [sessions[1],sessions[0],sessions[2]] : sessions,threads:[{sessionId:'session_archived',name:'Recover archived',preview:'old work',updatedAt:Date.now()/1000}]};
    }
    case 'context':return {kind:'context',threadId:request.threadId,usage:{used:1200,window:10000},run:currentRun};
    case 'usage':return {kind:'usage',data:{profile:{displayName:'Fixture account',lifetimeTokens:123456,topInvocations:[],dailyBuckets:[{date:new Date().toISOString().slice(0,10),tokens:3000}]},usage:{planType:'fixture',main:{primary:{usedPercent:12}},extras:[],fetchedAt:Date.now()}}};
    case 'createProject':return {kind:'applied',project:{...project,name:request.name},message:'项目群已创建。'};
    case 'editProject':
      if(rejectProject)return {kind:'refused',code:'stale',message:'Project revision changed'};
      assert.equal(request.expectedRevision,project.revision);project={...project,kind:request.conversation==='shared'?'single':'multi',enabled:request.enabled,cwd:request.folderToken?path.join(home,'chosen'):project.cwd,revision:'r2'};return {kind:'applied',project,message:'项目已更新。'};
    case 'reminder':assert.equal(request.runId,'run-fixture');currentRun={...currentRun,reminderRequested:request.requested};return {kind:'applied'};
    case 'stop':case 'endGoal':assert.equal(request.runId,'run-fixture');return {kind:'applied'};
    case 'removeProject':return {kind:'applied',message:'项目绑定已解除，目录已保留。'};
    case 'shareUsage':return rejectShare ? {kind:'refused',code:'fixture',message:'Share refused by fixture'} : holdShare ? new Promise(resolve=>{resolveShare=resolve;}) : {kind:'applied'};
    default:assert.ok(['compact','clear','startGoal','resume','openGroup'].includes(request.action));return {kind:'applied'};
  }
});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deadline=setTimeout(()=>{process.stderr.write('Management UI timeout\n');app.exit(1);},60000);
void app.whenReady().then(async()=>{
  window=new BrowserWindow({show:false,width:1060,height:780,webPreferences:{preload:path.join(distPath,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const evaluate=code=>window.webContents.executeJavaScript(code);
  const wait=async code=>{for(let i=0;i<120;i++){if(await evaluate(code))return;await pause(40);}throw new Error(`Missing UI condition: ${code}`);};
  const button=label=>`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)})`;
  const click=async label=>{await wait(`Boolean(${button(label)})`);assert.equal(await evaluate(`(()=>{const b=${button(label)};if(b.disabled)return false;b.click();return true})()`),true,label);await pause(70);};
  const value=async(label,value,select=false)=>{const query=`document.querySelector('[aria-label="${label}"]')`;await wait(`Boolean(${query})`);await evaluate(`Object.getOwnPropertyDescriptor(${select?'HTMLSelectElement':'HTMLInputElement'}.prototype,'value').set.call(${query},${JSON.stringify(value)});${query}.dispatchEvent(new Event('${select?'change':'input'}',{bubbles:true}));`);await pause(50);};
  const identity="[...document.querySelectorAll('section.ss-section')].find(section=>section.querySelector('.ss-section__label')?.textContent.trim()==='当前会话')?.querySelector('[data-search-title=\"会话\"] .ss-row__value')";
  const pass=name=>{results.push(name);process.stdout.write(`PASS ${name}\n`);};
  await window.loadFile(path.join(distPath,'renderer/index.html'));
  await wait("Array.from(document.querySelectorAll('.settings-entity-row__copy strong')).some(name => name.textContent.trim() === 'Management Agent')");
  await evaluate("Array.from(document.querySelectorAll('.settings-entity-row')).find(row => row.querySelector('.settings-entity-row__copy strong')?.textContent.trim() === 'Management Agent').click()");
  await click('加入飞书群');await value('飞书群名称','Created from desktop');await value('会话方式','shared',true);await value('执行工具','claude',true);
  await value('目录来源','existing',true);await click('选择文件夹');await click('创建飞书群并加入');
  await wait("!document.querySelector('[aria-label=\"飞书群名称\"]')");
  assert.deepEqual(calls.find(c=>c.action==='createProject'),{action:'createProject',agentId,name:'Created from desktop',folder:{kind:'existing',folderToken:'12345678-1234-4234-8234-123456789012'},tool:'claude',conversation:'shared'});
  pass('create project carries selected folder, backend and conversation');
  await evaluate("[...document.querySelectorAll('.settings-entity-row')].find(b=>b.innerText.includes('Management Project')).click()");
  await wait("document.body.innerText.includes('Current session') && document.body.innerText.includes('1,200 / 10,000')");
  assert.equal(await evaluate("document.body.innerText.includes('分享 Codex 用量')"),false,'group activity no longer shows the share row');
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='选择内容')"),false,'group activity has no share button');
  assert.equal(calls.filter(c=>c.action==='context').at(-1).threadId,'thread_current');
  assert.equal(await evaluate("[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='管理').length"),0,'history rows must not offer 管理 buttons');
  assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=\"选择会话\"]'))"),false,'current session picker is absent');
  assert.equal(await evaluate(`${identity}?.textContent.trim()`),'Current session');
  assert.equal(await evaluate(`(()=>{const row=${identity};const search=document.querySelector('[aria-label="搜索历史会话"]');return Boolean(row.compareDocumentPosition(search)&Node.DOCUMENT_POSITION_FOLLOWING)})()`),true,'current session identity precedes history');
  assert.equal(await evaluate(`(()=>{const row=${identity};for(let parent=row.parentElement;parent;parent=parent.parentElement)if(parent.scrollTop!==0)return false;const rect=row.getBoundingClientRect();return rect.top>=0&&rect.bottom<=window.innerHeight})()`),true,'current session identity is visible at initial scroll position');
  pass('history omits management buttons and current session identity is visible without a picker');
  await value('筛选历史会话','resumable',true);await wait("document.body.innerText.includes('Recover archived')");
  assert.equal(await evaluate(`${identity}?.textContent.trim()`),'Current session','resumable filter preserves current session');
  await click('恢复');
  assert.equal(calls.find(c=>c.action==='resume').sessionId,'session_archived');
  await value('筛选历史会话','all',true);await value('搜索历史会话','no match');await wait("document.body.innerText.includes('没有匹配的会话')");
  assert.equal(await evaluate(`${identity}?.textContent.trim()`),'Current session','history search preserves current session');
  await value('搜索历史会话','');
  pass('history filtering keeps archived session recoverable and out of live management');
  await click('压缩上下文');
  assert.equal(calls.filter(c=>c.action==='compact').at(-1).threadId,'thread_current');
  reorderHistory=true;
  await evaluate("[...document.querySelectorAll('section.ss-section')].find(section=>section.querySelector('.ss-section__label')?.textContent.trim()==='历史会话').querySelector('.ss-section__action button').click()");
  await wait("(()=>{const section=[...document.querySelectorAll('section.ss-section')].find(section=>section.querySelector('.ss-section__label')?.textContent.trim()==='历史会话');const other=section?.querySelector('[data-search-title=\"Other bound session\"]');const current=section?.querySelector('[data-search-title=\"Current session\"]');return Boolean(other&&current&&(other.compareDocumentPosition(current)&Node.DOCUMENT_POSITION_FOLLOWING))})()");
  assert.equal(await evaluate(`${identity}?.textContent.trim()`),'Current session','history refresh preserves current target after records reorder');
  const actionStart=calls.length;
  await click('压缩上下文');await click('清空会话');await value('自主任务目标','Complete fixture goal');await click('开始');
  await click('开启提醒');await wait("document.body.innerText.includes('关闭提醒')");await click('关闭提醒');await click('停止');await click('结束目标');
  for(const action of ['compact','clear','startGoal','reminder','stop','endGoal'])assert.ok(calls.some(c=>c.action===action),action);
  const scopedCalls=calls.slice(actionStart).filter(c=>['context','compact','clear','startGoal','reminder','stop','endGoal'].includes(c.action));
  assert.ok(scopedCalls.length>0);
  assert.ok(scopedCalls.every(c=>c.threadId==='thread_current'),JSON.stringify(scopedCalls));
  assert.equal(await evaluate(`${identity}?.textContent.trim()`),'Current session');
  assert.equal(calls.filter(c=>c.agentId===secondAgentId && c.action!=='shareUsage').length,0);
  pass('reordered history preserves current target and all scoped requests use thread_current');
  pass('conversation controls target the current group, thread and live run');
  await click('群内设置');await value('项目会话方式','threads',true);await value('项目状态','disabled',true);await click('更换目录');
  rejectProject=true;await click('群聊');await click('保存并离开');await wait("document.body.innerText.includes('未能保存')");await click('继续编辑');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"项目状态\"]').value"),'disabled');
  rejectProject=false;await click('保存项目');await wait("document.body.innerText.includes('项目已更新。')");assert.equal(project.kind,'multi');assert.equal(project.enabled,false);assert.equal(project.cwd,path.join(home,'chosen'));
  pass('project conflict preserves draft and successful retry saves the same target');
  await click('解除绑定…');assert.equal(calls.some(c=>c.action==='removeProject'),false);await click('确认解除');await wait("document.body.innerText.includes('目录已保留')");
  pass('project removal requires confirmation and displays directory retention');
  await click('用量');await wait("document.body.innerText.includes('分享 Codex 用量')");
  assert.equal(await evaluate("Boolean(document.getElementById('setting-'+encodeURIComponent('分享 Codex 用量')))"),true);
  assert.equal(await evaluate("document.body.innerText.includes('当前账号')"),true);
  await click('选择飞书群');await wait("Boolean(document.querySelector('[aria-label=\"选择分享飞书群\"]'))");
  const recipient="document.querySelector('[aria-label=\"选择分享飞书群\"]')";
  assert.equal(await evaluate(`${recipient}.value`),'');
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='生成分享卡').disabled"),true);
  assert.equal(calls.filter(c=>c.action==='shareUsage').length,0);
  assert.deepEqual(await evaluate(`[...${recipient}.options].map(option=>({value:option.value,label:option.textContent}))`),[{value:'',label:'请选择飞书群'},{value:'membership_management',label:'Management Project · Management Agent'},{value:'membership_second',label:'Second Group · Second Agent · 绑定名称：Second Binding'}]);
  await value('选择分享飞书群','membership_second',true);
  await evaluate("[...document.querySelectorAll('.usage-sections__item')].find(label=>label.textContent.includes('核心统计')).querySelector('input').click()");
  rejectShare=true;await click('生成分享卡');await wait("document.body.innerText.includes('Share refused by fixture')");
  assert.deepEqual(calls.filter(c=>c.action==='shareUsage').at(-1),{action:'shareUsage',agentId:secondAgentId,projectName:'Second Binding',groupId:secondGroupId,sections:['stats']});
  assert.equal(await evaluate(`${recipient}.value`),'membership_second');
  rejectShare=false;holdShare=true;await click('生成分享卡');
  assert.equal(await evaluate(`${recipient}.disabled`),true,'recipient cannot change while sending');
  resolveShare({kind:'applied'});holdShare=false;await wait("document.body.innerText.includes('分享完成')");
  assert.equal(calls.filter(c=>c.action==='shareUsage').length,2);
  assert.deepEqual(calls.filter(c=>c.action==='shareUsage')[1],calls.filter(c=>c.action==='shareUsage')[0]);
  pass('usage share requires explicit second recipient, sends exact tuple and retries refusal');
  snapshot.memberships[1].stale=true;publish();await wait("document.body.innerText.includes('绑定状态已过期')");
  assert.equal(await evaluate(`${recipient}.value`),'membership_second');
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='生成分享卡').disabled"),true);
  assert.equal(calls.filter(c=>c.action==='shareUsage').length,2);
  snapshot.memberships[1].stale=false;snapshot.agents[1].readError='Fixture read error';publish();await wait("document.body.innerText.includes('Bot 暂不可用')");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='生成分享卡').disabled"),true);
  snapshot.agents[1].readError=undefined;snapshot.memberships.splice(1,1);publish();await wait("document.body.innerText.includes('原绑定已移除')");
  assert.equal(await evaluate(`${recipient}.value`),'membership_second');
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='生成分享卡').disabled"),true);
  assert.equal(calls.filter(c=>c.action==='shareUsage').length,2);
  pass('stale, unreadable and removed choices never silently change recipient or send');
  snapshot.memberships.splice(0,1);publish();await wait("document.body.innerText.includes('暂无可分享的飞书群')");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='生成分享卡').disabled"),true);
  assert.equal(calls.filter(c=>c.action==='shareUsage').length,2);
  snapshot.memberships.push({id:'membership_unavailable',agentId,groupId,name:'Unavailable Binding',cwd:project.cwd,backend:'codex-appserver',conversation:'shared',response:'mention',administrator:'write',member:'qa',network:false,stale:true});publish();
  await wait("document.body.innerText.includes('绑定状态已过期')");
  assert.equal(await evaluate("document.body.innerText.includes('暂无可分享的飞书群')"),true);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='生成分享卡').disabled"),true);
  pass('empty and all-unavailable bindings explain why sharing is unavailable');
  writeFileSync(path.join(home,'result.json'),JSON.stringify({results,calls},null,2));
  process.stdout.write(`Evidence: ${home}\n`);clearTimeout(deadline);app.quit();
}).catch(error=>{process.stderr.write(`${error.stack}\n`);clearTimeout(deadline);app.exit(1);});
