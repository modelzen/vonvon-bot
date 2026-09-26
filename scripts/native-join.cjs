const {app, BrowserWindow, ipcMain} = require('electron');
const assert = require('node:assert/strict');
const {mkdtempSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const home = mkdtempSync(path.join(tmpdir(), 'vonvon-join-'));
app.setPath('userData', path.join(home, 'electron'));
const agentId = 'cli_join';
const snapshot = {revision:1,observedAt:Date.now(),stale:false,host:{kind:'connected',ownership:'owned',version:'0.7.0'},agents:[{id:agentId,name:'Join Agent',enabled:true,connection:'connected',activation:'active'}],groups:[],memberships:[],tools:[],jobs:[],diagnostics:[],application:{platform:'macos',version:'0.7.0',loginItem:false,dataPath:home}};
let window, groups=[], fail=true, unsupported=false, hold, holdNext=false;
const calls=[];
ipcMain.handle('bridge:watch',()=>snapshot);
ipcMain.handle('bridge:settings',()=>({kind:'refused',code:'fixture',message:'No settings'}));
ipcMain.handle('bridge:collaboration',(_event,request)=>{calls.push(request);return fail?{kind:'refused',code:'fixture',message:'Create retry fixture'}:{kind:'applied'};});
ipcMain.handle('bridge:run',async(_event,command)=>{
  calls.push(command);
  let result={kind:'applied',revision:1};
  if(command.type==='listPendingGroups') {
    if(holdNext){holdNext=false;result=await new Promise(resolve=>{hold=resolve;});}
    else result=unsupported?{kind:'refused',code:'unsupported',message:'Old Host'}:{kind:'pendingGroups',groups};
  }
  if(command.type==='chooseFolder')result={kind:'folderChosen',folder:{token:'12345678-1234-4234-8234-123456789012',displayPath:path.join(home,'chosen')}};
  if(command.type==='listJoinedGroups')result={kind:'groups',groups:[{id:'oc_manual',name:'Historic group',bound:false}]};
  if(command.type==='bindGroup') {result=fail?{kind:'refused',code:'fixture',message:'Bind retry fixture'}:result;if(!fail)groups=groups.filter(group=>group.chatId!==command.groupId);}
  return {command:command.type,result};
});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deadline=setTimeout(()=>{process.stderr.write('Join timeout\n');app.exit(1);},60000);
void app.whenReady().then(async()=>{
  window=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{preload:path.resolve('dist/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const evaluate=code=>window.webContents.executeJavaScript(code);
  const wait=async code=>{for(let i=0;i<200;i++){if(await evaluate(code))return;await pause(40);}throw new Error(`Missing: ${code}`);};
  const button=label=>`[...document.querySelectorAll('[role=dialog] button, button')].find(b=>b.textContent.trim()===${JSON.stringify(label)})`;
  const click=async label=>{await wait(`Boolean(${button(label)})`);assert.equal(await evaluate(`(()=>{const b=${button(label)};if(b.disabled)return false;b.click();return true})()`),true,label);await pause(100);};
  const value=async(label,value)=>{const q=`document.querySelector('[aria-label="${label}"]')`;await wait(`Boolean(${q})`);await evaluate(`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(${q},${JSON.stringify(value)});${q}.dispatchEvent(new Event('input',{bubbles:true}));`);await pause(50);};
  const close=async()=>{await evaluate("document.querySelector('[role=dialog] button[aria-label=关闭]').click()");await pause(150);};
  await window.loadFile(path.resolve('dist/renderer/index.html'));
  await wait("Boolean(document.querySelector('.collaboration-agent-list-row'))");await evaluate("document.querySelector('.collaboration-agent-list-row').click()");
  await click('加入飞书群');await value('飞书群名称','New group');await click('创建飞书群并加入');await wait("document.body.innerText.includes('Create retry fixture')");
  assert.equal(await evaluate("document.querySelector('[aria-label=飞书群名称]').value"),'New group');
  fail=false;await click('创建飞书群并加入');await wait("!document.querySelector('[aria-label=飞书群名称]')");
  const creates=calls.filter(item=>item.action==='createProject');assert.equal(creates.length,2);assert.deepEqual(creates[0],creates[1]);assert.deepEqual(creates[0].folder,{kind:'default'});
  process.stdout.write('PASS default new group and unchanged retry\n');
  await click('加入飞书群');await click('加入现有飞书群');await wait("document.body.innerText.includes('搜索并添加「Join Agent」')");
  groups=[{chatId:'oc_join',name:'Existing team',addedAt:Date.now()}];await wait("document.querySelector('[role=dialog]').textContent.includes('Join Agent 已加入 Existing team')");
  await click('继续绑定');await wait("document.querySelector('[aria-label=本地绑定名称]')?.value==='Existing team'");await close();await wait("!document.querySelector('[role=dialog]')");await wait("Boolean(document.querySelector('[aria-label=\"飞书群绑定通知\"]'))");await evaluate("document.querySelector('[aria-label=\"关闭 Existing team 的绑定通知\"]').click()");await wait("!document.querySelector('[aria-label=\"飞书群绑定通知\"]')");await click('继续绑定');await wait("document.querySelector('[aria-label=本地绑定名称]')?.value==='Existing team'");
  groups.push({chatId:'oc_second',name:'Second team',addedAt:Date.now()});await value('本地绑定名称','Custom binding');await pause(2200);assert.equal(await evaluate("document.querySelector('[aria-label=本地绑定名称]').value"),'Custom binding');
  await click('选择文件夹');fail=true;await click('绑定工作目录并发送欢迎卡片');await wait("document.body.innerText.includes('Bind retry fixture')");fail=false;await click('绑定工作目录并发送欢迎卡片');await wait("!document.querySelector('[aria-label=本地绑定名称]')");
  const binds=calls.filter(item=>item.type==='bindGroup');assert.equal(binds.length,2);assert.deepEqual(binds[0],binds[1]);assert.equal(binds[0].groupId,'oc_join');
  process.stdout.write('PASS pending notice resumes after closing and preserves draft on concurrent arrival and failed bind\n');
  groups=[];unsupported=true;await click('加入飞书群');await click('加入现有飞书群');await wait("document.body.innerText.includes('当前后台不支持绑定通知')");await click('查找已经加入的群');await wait("document.querySelector('[aria-label=选择飞书群]')?.textContent.includes('Historic group')");
  process.stdout.write('PASS old Host explicit fallback\n');await close();
  unsupported=false;holdNext=true;while(!hold)await pause(50);
  snapshot.revision++;snapshot.host={kind:'disconnected',message:'fixture disconnect'};window.webContents.send('bridge:snapshot',snapshot);await pause(100);hold({kind:'pendingGroups',groups:[{chatId:'oc_stale',name:'Stale event',addedAt:1}]});await pause(300);assert.equal(await evaluate("document.body.innerText.includes('Stale event')"),false);
  process.stdout.write('PASS disconnected Host rejects late pending response\n');
  clearTimeout(deadline);app.quit();
}).catch(error=>{process.stderr.write(`${error.stack}\n`);clearTimeout(deadline);app.exit(1);});
