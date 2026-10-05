const {app, BrowserWindow, ipcMain} = require('electron');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {mkdtempSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');

const home = mkdtempSync(path.join(tmpdir(), 'vonvon-membership-settings-'));
app.setPath('userData', path.join(home, 'electron'));
app.on('window-all-closed', () => {});
const old = process.argv.includes('--baseline');
const dist = path.resolve(old ? '.scratch/group-settings/baseline-dist' : 'dist');
const agentId = 'cli_member_fixture', groupId = 'oc_member_fixture';
const section = stored => ({stored, effective: structuredClone(stored), revision: 'section-1', access: {kind: 'writable'}, apply: []});
let project, view, calls, window, rejectSave, failInitialRead, failRefresh;
const initial = () => {
  project = {name: 'Member Project', chatId: groupId, cwd: '/tmp/member-project', kind: 'single', enabled: true, backend: 'codex-appserver', revision: ''};
  view = {scope: {kind: 'project', botId: agentId, projectName: project.name}, sections: {
    permission: section({mode: 'full', guestMode: 'write', network: true}),
    response: section({noMention: false}), compact: section({autoCompact: true}),
    model: section({selection: {kind: 'explicit', model: 'gpt-6-sol', effort: 'medium'}}),
  }, identity: {chatId: groupId, backend: project.backend, cwd: project.cwd, kind: project.kind}, members: {openIds: [], revision: 'members-1'}};
  calls = []; rejectSave = false; failInitialRead = false; failRefresh = false; updateHash();
};
function updateHash() {
  project.revision = createHash('sha256').update(JSON.stringify({...project, revision: undefined, settings: view.sections, members: view.members})).digest('hex');
}
function snapshot() {return {
  revision: 1, observedAt: Date.now(), stale: false, host: {kind: 'connected', ownership: 'owned', version: '0.7.0'},
  agents: [{id: agentId, name: 'Member Agent', enabled: true, connection: 'connected', activation: 'active'}],
  groups: [{id: groupId, name: project.name}],
  memberships: [{id: 'membership_fixture', agentId, groupId, name: project.name, directory: project.cwd, backend: project.backend, conversation: project.kind === 'single' ? 'shared' : 'threads', response: 'mention', stale: false}],
  tools: [], jobs: [], diagnostics: [], application: {platform: 'macos', version: '0.7.0', loginItem: false, dataPath: home},
};}
ipcMain.handle('bridge:watch', () => snapshot());
ipcMain.handle('bridge:run', (_event, command) => {
  if (command.type === 'listPendingGroups') return {command: command.type, result: {kind: 'pendingGroups', groups: []}};
  if (command.type === 'chooseFolder') return {command: command.type, result: {kind: 'folderChosen', folder: {token: '12345678-1234-4234-8234-123456789012', displayPath: '/tmp/selected-member-folder'}}};
  assert.equal(command.type, 'refresh');
  if (failRefresh) throw new Error('FIXTURE REFRESH FAILED');
  return {command: command.type, result: {kind: 'applied', revision: 2}};
});
ipcMain.handle('bridge:collaboration', (_event, request) => {
  calls.push({channel: 'collaboration', ...request});
  if (request.action === 'project') {
    if (failInitialRead) return {kind: 'refused', code: 'fixture', message: 'FIXTURE PROJECT READ FAILED'};
    return {kind: 'project', project: structuredClone(project)};
  }
  if (request.action === 'editProject' || request.action === 'removeProject') {
    if (request.expectedRevision !== project.revision) return {kind: 'refused', code: 'conflict', message: 'FIXTURE REVISION CONFLICT'};
    if (request.action === 'removeProject') return {kind: 'applied', message: 'removed'};
    project = {...project, cwd: request.folderToken ? '/tmp/selected-member-folder' : project.cwd, kind: request.conversation === 'shared' ? 'single' : 'multi', enabled: request.enabled};
    view.identity.cwd = project.cwd; view.identity.kind = project.kind;
    updateHash();
    return {kind: 'applied', project: structuredClone(project)};
  }
  if (request.action === 'history') return {kind: 'history', backend: project.backend, sessions: [], threads: []};
  if (request.action === 'openGroup') return {kind: 'applied'};
  return {kind: 'refused', code: 'fixture', message: `Unsupported ${request.action}`};
});
ipcMain.handle('bridge:settings', (_event, request) => {
  calls.push({channel: 'settings', ...request});
  if (request.type === 'read') return {kind: 'view', view: structuredClone(view)};
  if (request.type === 'models') return {kind: 'models', catalog: {backend: project.backend, state: 'ready', source: 'backend-provided', observedAt: new Date().toISOString(), titleEfforts: ['medium'], models: [{id: 'gpt-6-sol', displayName: 'GPT 6 Sol', description: '', supportedEfforts: ['medium', 'high'], defaultEffort: 'medium', isDefault: true, hidden: false}]}};
  if (request.type === 'sessions') return {kind: 'sessions', sessions: []};
  if (request.type === 'save') {
    const {section: key, revision, patch} = request.edit;
    assert.equal(request.edit.scope.projectName, project.name);
    assert.equal(revision, view.sections[key].revision);
    if (rejectSave) return {kind: 'saved', result: {kind: 'rejected', fields: [{field: key, message: 'FIXTURE SAVE REJECTED'}]}};
    Object.assign(view.sections[key].stored, patch);
    Object.assign(view.sections[key].effective, patch);
    view.sections[key].revision += 'x'; updateHash();
    return {kind: 'saved', result: {kind: 'saved', section: {scope: view.scope, section: key, value: structuredClone(view.sections[key])}, effects: []}};
  }
  if (request.type === 'act') {
    assert.equal(request.action.kind, 'projectMember');
    assert.equal(request.action.revision, view.members.revision);
    view.members.openIds.push(request.action.openId);
    view.members.revision += 'x'; updateHash();
    return {kind: 'acted', result: {kind: 'saved'}};
  }
  throw new Error(`Unsupported settings request ${request.type}`);
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(source) {try {return await window.webContents.executeJavaScript(source);} catch (error) {throw new Error(`Renderer evaluation failed: ${source}`, {cause: error});}}
async function wait(source) {for (let i = 0; i < 100; i++) {if (await evaluate(source)) return; await pause(50);} throw new Error(`Missing UI: ${source}`);}
const button = label => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)})`;
async function click(label) {await wait(`Boolean(${button(label)})`); await evaluate(`${button(label)}.click()`); await pause(80);}
async function setValue(label, value, tag = 'HTMLInputElement') {
  const field = `document.querySelector('[aria-label=${JSON.stringify(label)}]')`;
  await wait(`Boolean(${field})`);
  await evaluate(`Object.getOwnPropertyDescriptor(${tag}.prototype,'value').set.call(${field},${JSON.stringify(value)});${field}.dispatchEvent(new Event('${tag === 'HTMLInputElement' ? 'input' : 'change'}',{bubbles:true}));`);
  await pause(70);
}
async function openSettings(skipBinding = false) {
  await window.loadFile(path.join(dist, 'renderer/index.html'));
  await wait("[...document.querySelectorAll('.settings-entity-row__copy strong')].some(n=>n.textContent.trim()==='Member Agent')");
  await evaluate("[...document.querySelectorAll('.settings-entity-row')].find(n=>n.innerText.includes('Member Agent')).click()");
  await wait("[...document.querySelectorAll('.settings-entity-row')].some(n=>n.innerText.includes('Member Project'))");
  await evaluate("[...document.querySelectorAll('.settings-entity-row')].find(n=>n.innerText.includes('Member Project')).click()");
  await click('群内设置');
  if (!skipBinding) await wait("Boolean(document.querySelector('[aria-label=\"项目状态\"]'))");
}
function createWindow() {
  window = new BrowserWindow({show: false, width: 1060, height: 780, webPreferences: {preload: path.join(dist, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false}});
}
async function test() {
  initial();
  createWindow();
  await openSettings();
  const initialHash = project.revision;
  if (old) await click('行为');
  else await evaluate("document.querySelector('.membership-settings-details summary').click()");
  await setValue('模型', '', 'HTMLSelectElement');
  await wait("Boolean(document.getElementById('setting-'+encodeURIComponent('新会话默认模型')).querySelector('button'))");
  await evaluate("document.getElementById('setting-'+encodeURIComponent('新会话默认模型')).querySelectorAll('button')[1].click()");
  await wait("document.body.innerText.includes('已保存。')");
  assert.deepEqual(view.sections.model.stored.selection, {kind: 'default'});
  if (old) await click('群内权限');
  await setValue('成员 Open ID', 'ou_fixture_member');
  await evaluate("document.getElementById('setting-'+encodeURIComponent('响应成员')).querySelector('button').click()");
  await wait("document.body.innerText.includes('ou_fixture_member')");
  assert.deepEqual(view.members.openIds, ['ou_fixture_member']);
  const afterCoreHash = project.revision;
  assert.notEqual(afterCoreHash, initialHash);
  if (old) await click('绑定');
  await setValue('项目状态', 'disabled', 'HTMLSelectElement');
  await click('保存项目');
  await wait("document.body.innerText.includes('项目已更新。')");
  assert.equal(project.enabled, false);
  const edit = calls.find(c => c.action === 'editProject');
  assert.equal(edit.expectedRevision, afterCoreHash);
  assert.ok(calls.some(c => c.type === 'save' && c.edit.section === 'model'));
  assert.ok(calls.some(c => c.type === 'act' && c.action.kind === 'projectMember'));
  process.stdout.write(`PASS ${old ? 'baseline' : 'continuous'} model/member saves and binding edit\n`);
  if (!old) {
    await evaluate("document.querySelector('.membership-settings-details summary').click()");
    await evaluate("document.querySelector('button[aria-label=\"搜索设置、Agent 或项目\"]').click()");
    await setValue('搜索设置、Agent 或飞书群', '选择话题');
    await wait("[...document.querySelectorAll('[role=\"option\"]')].some(n=>n.textContent.includes('选择话题'))");
    await evaluate("[...document.querySelectorAll('[role=\"option\"]')].find(n=>n.textContent.includes('选择话题')).click()");
    await wait("document.querySelector('.membership-settings-details').open && document.activeElement?.closest('[data-search-title=\"选择话题\"]')");
    process.stdout.write('PASS topic search opens collapsed details and focuses the field\n');
    failRefresh = true;
    await click('解除绑定…'); await click('确认解除');
    await wait("document.body.innerText.includes('removed')");
    assert.equal(calls.find(c=>c.action==='removeProject')?.expectedRevision, project.revision);
    assert.equal(await evaluate("Boolean(document.querySelector('select[aria-label=\"模型\"]'))"), false);
    process.stdout.write('PASS removal uses fresh revision and unmounts Core editors after refresh failure\n');
  }
  window.close();
  if (old) return;

  initial(); createWindow(); await openSettings();
  await click('更换目录');
  await setValue('项目会话方式', 'threads', 'HTMLSelectElement');
  await setValue('项目状态', 'disabled', 'HTMLSelectElement');
  await setValue('模型', '', 'HTMLSelectElement');
  await evaluate("document.getElementById('setting-'+encodeURIComponent('新会话默认模型')).querySelectorAll('button')[1].click()");
  await wait("document.body.innerText.includes('已保存。')");
  assert.deepEqual(view.sections.model.stored.selection, {kind: 'default'});
  assert.equal(await evaluate("document.querySelector('[aria-label=\"项目状态\"]').value"), 'disabled');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"项目会话方式\"]').value"), 'threads');
  assert.equal(await evaluate("document.body.innerText.includes('/tmp/selected-member-folder')"), true);
  await setValue('模型', 'gpt-6-sol', 'HTMLSelectElement');
  await click('解除绑定…'); await click('确认解除');
  await wait("document.body.innerText.includes('有未保存的修改')");
  assert.equal(calls.filter(c=>c.action==='removeProject').length, 0);
  await click('继续编辑');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"项目状态\"]').value"), 'disabled');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"项目会话方式\"]').value"), 'threads');
  assert.equal(await evaluate("document.querySelector('select[aria-label=\"模型\"]').value"), 'gpt-6-sol');
  rejectSave = true;
  await click('解除绑定…'); await click('确认解除'); await click('保存并离开');
  await wait("document.body.innerText.includes('未能保存')");
  assert.equal(calls.filter(c=>c.action==='removeProject').length, 0);
  rejectSave = false;
  await click('保存并离开');
  await wait("document.body.innerText.includes('removed')");
  assert.equal(calls.filter(c=>c.action==='editProject').length, 1);
  assert.equal(calls.filter(c=>c.type==='save' && c.edit.section==='model').length, 3);
  assert.equal(calls.find(c=>c.action==='removeProject')?.expectedRevision, project.revision);
  assert.equal(project.cwd, '/tmp/selected-member-folder');
  assert.equal(project.kind, 'multi');
  assert.equal(project.enabled, false);
  process.stdout.write('PASS guarded remove preserves drafts, stops on failed save, then uses final whole-project revision\n');
  window.close();

  initial(); createWindow(); await openSettings();
  await click('更换目录');
  project.cwd = '/tmp/external-binding-change'; updateHash();
  await click('保存项目');
  await wait("document.body.innerText.includes('项目绑定已由其他位置修改')");
  assert.equal(calls.filter(c=>c.action==='editProject').length, 0);
  assert.equal(await evaluate("document.body.innerText.includes('/tmp/selected-member-folder')"), true);
  await click('解除绑定…'); await click('确认解除');
  await wait("document.body.innerText.includes('有未保存的修改')");
  await click('放弃并离开');
  await wait("document.body.innerText.includes('项目绑定已由其他位置修改')");
  assert.equal(calls.filter(c=>c.action==='removeProject').length, 0);
  process.stdout.write('PASS external structural edit blocks save and removal without dropping the draft\n');
  window.close();

  initial(); failInitialRead = true; createWindow(); await openSettings(true);
  await wait("document.body.innerText.includes('FIXTURE PROJECT READ FAILED')");
  await wait("Boolean(document.querySelector('select[aria-label=\"模型\"]'))");
  process.stdout.write('PASS initial binding read failure leaves Core settings available\n');
  window.close();
}
const deadline = setTimeout(() => {process.stderr.write(`Membership fixture timeout: ${home}\n`); app.exit(1);}, 60000);
void app.whenReady().then(test).then(() => {clearTimeout(deadline); app.quit();}, error => {clearTimeout(deadline); process.stderr.write(`${error.stack}\n`); app.exit(1);});
