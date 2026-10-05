const {app, BrowserWindow, ipcMain} = require('electron');
const assert = require('node:assert/strict');
const {mkdtempSync, readFileSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const home = mkdtempSync(path.join(tmpdir(), 'vonvon-navigation-'));
app.setPath('userData', path.join(home, 'electron'));
const fixture = JSON.parse(readFileSync('tests/fixtures/agent-settings.json', 'utf8'));
fixture.voice.feishu = {state: 'missing_permission', message: 'FIXTURE VOICE STATUS'};
const firstId = fixture.scope.botId;
const secondId = 'cli_navigation_second';
const views = new Map([firstId, secondId].map(id => {
  const view = structuredClone(fixture); view.scope.botId = id; return [id, view];
}));
let rejectSave = false;
const saved = [];
let quitCount = 0;
const snapshot = {
  revision: 1, observedAt: Date.now(), stale: false,
  host: {kind: 'connected', ownership: 'owned', version: '0.7.0'},
  agents: [firstId, secondId].map((id, index) => ({id, name: index ? 'Second Agent' : 'Parity Agent', enabled: true, connection: 'connected', activation: 'active'})),
  groups: [], memberships: [], tools: [], jobs: [], diagnostics: [],
  application: {platform: 'macos', version: '0.7.0', loginItem: false, dataPath: home},
};
ipcMain.handle('bridge:collaboration', () => ({kind: 'refused', code: 'fixture-unused', message: 'This fixture covers settings navigation.'}));
ipcMain.handle('bridge:watch', () => snapshot);
ipcMain.handle('bridge:environment', (_event, request) => {if(request.type==='scan')return {kind:'tools',tools:[]};if(request.type==='profileList')return {kind:'profiles',profiles:[]};if(request.type==='backendCatalog')return {kind:'backends',entries:[]};return {kind:'operation',operation:null};});
ipcMain.handle('bridge:run', (_event, command) => {if(command.type === 'listPendingGroups')return {command:command.type,result:{kind:'pendingGroups',groups:[]}};assert.equal(command.type, 'quit'); quitCount++; return {command: 'quit', result: {kind: 'applied', revision: 1}};});
ipcMain.handle('bridge:settings', (_event, request) => {
  if (request.type === 'models') return {kind: 'refused', code: 'fixture', message: 'Catalog not in this fixture'};
  const view = views.get(request.scope?.botId ?? request.edit?.scope.botId);
  assert.ok(view, 'Settings request must target an existing fixture Agent');
  if (request.type === 'read') return {kind: 'view', view: structuredClone(view)};
  assert.equal(request.type, 'save');
  saved.push(structuredClone(request.edit));
  if (rejectSave) return {kind: 'saved', result: {kind: 'conflict'}};
  const section = view.sections[request.edit.section];
  section.stored = structuredClone(request.edit.patch);
  section.effective = structuredClone(request.edit.patch);
  section.revision += '-saved';
  return {kind: 'saved', result: {kind: 'saved', section: {scope: view.scope, section: request.edit.section, value: structuredClone(section)}, effects: []}};
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => {process.stderr.write('Navigation test timed out\n'); app.exit(1);}, 60000);
void app.whenReady().then(async () => {
  const window = new BrowserWindow({show: false, width: 1060, height: 780, webPreferences: {preload: path.resolve('dist/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false}});
  const evaluate = code => window.webContents.executeJavaScript(code);
  const until = async (code, timeout = 5000) => {
    const expires = Date.now() + timeout;
    while (Date.now() < expires) {if (await evaluate(code)) return; await delay(50);}
    assert.fail(`Condition not met: ${code}`);
  };
  const button = label => `Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()===${JSON.stringify(label)} || x.querySelector('.settings-entity-row__copy strong')?.textContent.trim()===${JSON.stringify(label)})`;
  const click = async label => {await until(`Boolean(${button(label)})`); await evaluate(`${button(label)}.click()`); await delay(50);};
  const concurrency = "document.querySelector('input[aria-label=\"最大并发任务\"]')";
  const setConcurrent = value => evaluate(`{const field=${concurrency};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));}`);
  const title = "document.querySelector('.settings-toolbar h1')?.textContent";
  const results = [];
  function pass(name) {results.push(name); process.stdout.write(`PASS ${name}\n`);}
  try {
    await window.loadFile(path.resolve('dist/renderer/index.html'));
    await click('Parity Agent');
    await click('Agent 设置');
    await until(`Boolean(${concurrency})`);
    await setConcurrent('6');
    await click('本机环境');
    await until("document.body.innerText.includes('有未保存的修改')");
    assert.equal(await evaluate(title), 'Parity Agent');
    await click('继续编辑');
    assert.equal(await evaluate(`${concurrency}.value`), '6');
    assert.equal(saved.length, 0);
    pass('sidebar and continue preserve draft');
    await evaluate("document.querySelector('button[aria-label=\"返回 Agent 列表\"]').click()");
    await click('放弃并离开');
    await click('Parity Agent');
    await click('Agent 设置');
    await until(`Boolean(${concurrency})`);
    assert.equal(await evaluate(`${concurrency}.value`), '5');
    pass('back discards only after explicit choice');
    await setConcurrent('6');
    rejectSave = true;
    await click('群聊');
    await click('保存并离开');
    await until("document.body.innerText.includes('未能保存')");
    assert.equal(await evaluate(title), 'Parity Agent');
    assert.equal(await evaluate(`${concurrency}.value`), '6');
    assert.equal(saved.at(-1).scope.botId, firstId);
    await click('继续编辑');
    pass('conflicted save keeps scope and draft');
    rejectSave = false;
    await click('本机环境');
    await click('保存并离开');
    await until(`${title}==='本机环境'`);
    assert.equal(views.get(firstId).sections.run.stored.maxConcurrentRuns, 6);
    assert.equal(views.get(secondId).sections.run.stored.maxConcurrentRuns, 5);
    pass('save and leave persists correct Agent');
    await evaluate("document.querySelector('button[aria-label=\"搜索设置、Agent 或项目\"]').click()");
    await until("Boolean(document.querySelector('input[aria-label=\"搜索设置、Agent 或飞书群\"]'))");
    await evaluate("{const field=document.querySelector('input[aria-label=\"搜索设置、Agent 或飞书群\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'Second Agent 最大并发任务');field.dispatchEvent(new Event('input',{bubbles:true}));}");
    await until("document.querySelectorAll('.desktop-search-results button').length===1");
    await evaluate("document.querySelector('.desktop-search-results button').click()");
    await until(`${title}==='Second Agent' && Boolean(${concurrency})`);
    await until("document.activeElement === document.querySelector('input[aria-label=\"最大并发任务\"]')");
    assert.equal(await evaluate(`${concurrency}.value`), '5');
    pass('setting search selects exact Agent and section');
    await setConcurrent('7');
    window.webContents.send('bridge:quitRequested');
    await until("document.body.innerText.includes('有未保存的修改')");
    assert.equal(quitCount, 0);
    await click('继续编辑');
    assert.equal(quitCount, 0);
    window.webContents.send('bridge:quitRequested');
    await click('放弃并离开');
    await until("!document.body.innerText.includes('有未保存的修改')");
    assert.equal(quitCount, 1);
    pass('native quit passes through draft guard');
    writeFileSync(path.join(home, 'result.json'), JSON.stringify({results, saved, quitCount}, null, 2));
    process.stdout.write(`Evidence: ${home}\n`);
  } finally {window.destroy(); clearTimeout(deadline);}
  app.quit();
}).catch(error => {process.stderr.write(`${error.stack}\n`); clearTimeout(deadline); app.exit(1);});
