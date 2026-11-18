const {app, BrowserWindow, ipcMain} = require('electron');
const assert = require('node:assert/strict');
const {mkdtempSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const home = mkdtempSync(path.join(tmpdir(), 'vonvon-management-ui-'));
app.setPath('userData', path.join(home, 'electron'));
const agentId = 'cli_management', groupId = 'oc_management';
const distPath = path.resolve(process.env.MANAGEMENT_DIST || 'dist');
const calls = [], results = [];
let project = {name:'Management Project', chatId:groupId, cwd:path.join(home,'project'), kind:'single', enabled:true, backend:'codex-appserver', revision:'r1'};
let currentRun = {id:'run-fixture',goal:true,canStop:true,canEndGoal:true,canRemind:true,reminderRequested:false};
let rejectProject = false, window;
const snapshot = {
  revision:1, observedAt:Date.now(), stale:false, host:{kind:'connected',ownership:'owned',version:'0.7.0'},
  agents:[{id:agentId,name:'Management Agent',enabled:true,connection:'connected',activation:'active'}],
  groups:[{id:groupId,name:project.name}],
  memberships:[{id:'membership_management',agentId,groupId,name:project.name,cwd:project.cwd,backend:'codex-appserver',conversation:'shared',response:'mention',administrator:'write',member:'qa',network:false,stale:false}],
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
  calls.push(request);assert.equal(request.agentId,agentId);
  if(request.groupId)assert.equal(request.groupId,groupId);
  switch(request.action){
    case 'project':return {kind:'project',project};
    case 'history':return {kind:'history',backend:'codex-appserver',sessions:[{threadId:'thread_current',sessionId:'session_current',chatId:groupId,summary:'Current session',backend:'codex-appserver',updatedAt:Date.now()},{threadId:'thread_other',sessionId:'session_other',chatId:groupId,summary:'Other bound session',backend:'codex-appserver',updatedAt:Date.now()},{threadId:'thread_archived',sessionId:'session_archived',chatId:groupId,summary:'Archived session',backend:'codex-appserver',detached:true,updatedAt:Date.now()}],threads:[{sessionId:'session_archived',name:'Recover archived',preview:'old work',updatedAt:Date.now()/1000}]};
    case 'context':return {kind:'context',threadId:request.threadId,usage:{used:request.threadId==='thread_other'?2400:1200,window:10000},run:currentRun};
    case 'usage':return {kind:'usage',data:{profile:{displayName:'Fixture account',lifetimeTokens:123456,topInvocations:[],dailyBuckets:[{date:new Date().toISOString().slice(0,10),tokens:3000}]},usage:{planType:'fixture',main:{primary:{usedPercent:12}},extras:[],fetchedAt:Date.now()}}};
    case 'createProject':return {kind:'applied',project:{...project,name:request.name},message:'项目群已创建。'};
    case 'editProject':
      if(rejectProject)return {kind:'refused',code:'stale',message:'Project revision changed'};
      assert.equal(request.expectedRevision,project.revision);project={...project,kind:request.conversation==='shared'?'single':'multi',enabled:request.enabled,cwd:request.folderToken?path.join(home,'chosen'):project.cwd,revision:'r2'};return {kind:'applied',project,message:'项目已更新。'};
    case 'reminder':assert.equal(request.runId,'run-fixture');currentRun={...currentRun,reminderRequested:request.requested};return {kind:'applied'};
    case 'stop':case 'endGoal':assert.equal(request.runId,'run-fixture');return {kind:'applied'};
    case 'removeProject':return {kind:'applied',message:'项目绑定已解除，目录已保留。'};
    default:assert.ok(['compact','clear','startGoal','resume','openGroup','shareUsage'].includes(request.action));return {kind:'applied'};
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
  const selector="document.querySelector('[aria-label=\"选择会话\"]')";
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
  assert.equal(calls.filter(c=>c.action==='context').at(-1).threadId,'thread_current');
  assert.equal(await evaluate("[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='管理').length"),0,'history rows must not offer 管理 buttons');
  assert.deepEqual(await evaluate(`[...${selector}.options].map(option=>({value:option.value,label:option.textContent}))`),[{value:'thread_current',label:'Current session'},{value:'thread_other',label:'Other bound session'}],'only bound sessions are selectable');
  assert.equal(await evaluate(`${selector}.value`),'thread_current');
  assert.equal(await evaluate(`(()=>{const picker=${selector};const search=document.querySelector('[aria-label="搜索历史会话"]');return Boolean(picker.compareDocumentPosition(search)&Node.DOCUMENT_POSITION_FOLLOWING)})()`),true,'current session controls precede history');
  assert.equal(await evaluate(`(()=>{const picker=${selector};for(let parent=picker.parentElement;parent;parent=parent.parentElement)if(parent.scrollTop!==0)return false;const rect=picker.getBoundingClientRect();return rect.top>=0&&rect.bottom<=window.innerHeight})()`),true,'session selector is visible at initial scroll position');
  pass('history omits all management buttons and visible session selector contains only bound sessions');
  await value('筛选历史会话','resumable',true);await wait("document.body.innerText.includes('Recover archived')");
  assert.deepEqual(await evaluate(`[...${selector}.options].map(option=>option.value)`),['thread_current','thread_other'],'resumable filter preserves bound session choices');
  await click('恢复');
  assert.equal(calls.find(c=>c.action==='resume').sessionId,'session_archived');
  await value('筛选历史会话','all',true);await value('搜索历史会话','no match');await wait("document.body.innerText.includes('没有匹配的会话')");
  assert.deepEqual(await evaluate(`[...${selector}.options].map(option=>option.value)`),['thread_current','thread_other'],'history search preserves bound session choices');
  await value('搜索历史会话','');
  pass('history filtering keeps archived session recoverable and out of live management');
  await click('压缩上下文');
  assert.equal(calls.filter(c=>c.action==='compact').at(-1).threadId,'thread_current');
  const selectionStart=calls.length;
  await value('选择会话','thread_other',true);
  await wait("document.body.innerText.includes('2,400 / 10,000')");
  assert.equal(await evaluate(`${selector}.selectedOptions[0].textContent`),'Other bound session');
  assert.equal(await evaluate(`${selector}.value`),'thread_other');
  assert.deepEqual(calls.slice(selectionStart).filter(c=>c.action==='context').map(c=>c.threadId),['thread_other']);
  await click('压缩上下文');await click('清空会话');await value('自主任务目标','Complete fixture goal');await click('开始');
  await click('开启提醒');await wait("document.body.innerText.includes('关闭提醒')");await click('关闭提醒');await click('停止');await click('结束目标');await click('选择内容');await wait("Boolean(document.querySelector('[aria-label=\"选择分享内容\"]'))");await evaluate("[...document.querySelectorAll('.usage-sections__item')].find(label=>label.textContent.includes('核心统计')).querySelector('input').click()");await click('生成分享卡');assert.deepEqual(calls.find(c=>c.action==='shareUsage').sections,['stats']);
  await evaluate("document.querySelector('button[aria-label=\"关闭\"]').click()");await wait("!document.querySelector('[aria-label=\"选择分享内容\"]')");
  for(const action of ['compact','clear','startGoal','reminder','stop','endGoal','shareUsage'])assert.ok(calls.some(c=>c.action===action),action);
  const selectedCalls=calls.slice(selectionStart).filter(c=>['context','compact','clear','startGoal','reminder','stop','endGoal'].includes(c.action));
  assert.ok(selectedCalls.length>0);
  assert.ok(selectedCalls.every(c=>c.threadId==='thread_other'),JSON.stringify(selectedCalls));
  assert.equal(await evaluate(`${selector}.value`),'thread_other','history refresh preserves selected session');
  pass('switching management updates context and all subsequent scoped requests use exactly thread_other');
  pass('conversation and usage controls target the selected group, thread and live run');
  await click('群内设置');await value('项目会话方式','threads',true);await value('项目状态','disabled',true);await click('更换目录');
  rejectProject=true;await click('群聊');await click('保存并离开');await wait("document.body.innerText.includes('未能保存')");await click('继续编辑');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"项目状态\"]').value"),'disabled');
  rejectProject=false;await click('保存项目');await wait("document.body.innerText.includes('项目已更新。')");assert.equal(project.kind,'multi');assert.equal(project.enabled,false);assert.equal(project.cwd,path.join(home,'chosen'));
  pass('project conflict preserves draft and successful retry saves the same target');
  await click('解除绑定…');assert.equal(calls.some(c=>c.action==='removeProject'),false);await click('确认解除');await wait("document.body.innerText.includes('目录已保留')");
  pass('project removal requires confirmation and displays directory retention');
  writeFileSync(path.join(home,'result.json'),JSON.stringify({results,calls},null,2));
  process.stdout.write(`Evidence: ${home}\n`);clearTimeout(deadline);app.quit();
}).catch(error=>{process.stderr.write(`${error.stack}\n`);clearTimeout(deadline);app.exit(1);});
