const {app, BrowserWindow, ipcMain} = require('electron');
const assert = require('node:assert/strict');
const {readFileSync, mkdtempSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');

app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'vonvon-agent-list-')));
app.on('window-all-closed', () => {});
const fixture = JSON.parse(readFileSync('tests/fixtures/agent-settings.json', 'utf8'));
const portrait = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const brokenPortrait = 'data:image/png;base64,AAAA';
const agents = [
  {id: fixture.scope.botId, name: 'Connected Agent', avatarDataUrl: portrait, enabled: true, connection: 'connected', activation: 'active'},
  {id: 'cli_waiting', name: 'Waiting Agent', enabled: false, connection: 'disconnected', activation: 'restartRequired'},
  {id: 'cli_disabled', name: 'Disabled Agent', enabled: false, connection: 'disconnected', activation: 'active'},
  {id: 'cli_error', name: 'Error Agent', enabled: false, connection: 'disconnected', activation: 'restartRequired', readError: 'Private diagnostic message'},
];
const groups = [{id: 'oc_one', name: 'One', avatarDataUrl: portrait}, {id: 'oc_two', name: 'Two', avatarDataUrl: brokenPortrait}];
const memberships = ['oc_one', 'oc_one', 'oc_two'].map((groupId, index) => ({
  id: `membership_${index}`, agentId: agents[0].id, groupId,
  backend: 'codex-appserver', conversation: 'threads', stale: false,
}));
const snapshot = {
  revision: 1, observedAt: Date.now(), stale: false,
  host: {kind: 'connected', ownership: 'owned', version: '0.7.0'},
  agents, groups, memberships, tools: [], jobs: [], diagnostics: [],
  application: {platform: 'macos', version: '0.7.0', loginItem: false, dataPath: tmpdir()},
};
const commands = [];
ipcMain.handle('bridge:watch', () => snapshot);
ipcMain.handle('bridge:settings', (_event, request) => {
  if (request.type === 'models') return {kind: 'refused', code: 'fixture', message: 'No catalog'};
  assert.equal(request.type, 'read');
  const view = structuredClone(fixture);
  view.scope.botId = request.scope.botId;
  return {kind: 'view', view};
});
ipcMain.handle('bridge:collaboration', () => ({kind: 'refused', code: 'fixture', message: 'No project action'}));
ipcMain.handle('bridge:run', (_event, command) => {
  commands.push(command);
  if(command.type==='listPendingGroups')return {command:command.type,result:{kind:'pendingGroups',groups:[]}};
  const result = command.type === 'listJoinedGroups'
    ? {kind: 'groups', groups: [], hasMore: false}
    : {kind: 'refused', code: 'fixture', message: 'No external action'};
  return {command: command.type, result};
});

void app.whenReady().then(async () => {
  const interactive = process.argv.includes('--interactive');
  const window = new BrowserWindow({show: interactive, width: 1060, height: 780, webPreferences: {
    preload: path.resolve('dist/preload.cjs'), sandbox: true, contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false,
  }});
  const evaluate = code => window.webContents.executeJavaScript(code);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => {
    for (let index = 0; index < 100; index++) {
      if (await evaluate(code)) return;
      await pause(50);
    }
    assert.fail(`Missing UI condition: ${code}`);
  };
  try {
    await window.loadFile(path.resolve('dist/renderer/index.html'));
    await until("document.querySelectorAll('section[aria-label=\"Bot 列表\"] .collaboration-agent-list-row').length === 4");
    if (interactive) {
      process.stdout.write('Agent list fixture ready. Close the window to finish.\n');
      await new Promise(resolve => window.once('closed', resolve));
      return;
    }
    const rows = await evaluate(`Array.from(document.querySelectorAll('.collaboration-agent-list-row')).map(row => ({
      name: row.querySelector('strong').textContent.trim(),
      subtitle: row.querySelector('small').textContent.trim(),
      status: row.querySelector('.settings-entity-row__value').textContent.trim(),
      disabled: row.disabled,
    }))`);
    assert.deepEqual(rows, [
      {name: 'Connected Agent', subtitle: '飞书 · 2 个群聊', status: '已连接', disabled: false},
      {name: 'Waiting Agent', subtitle: '飞书 · 0 个群聊', status: '待重启', disabled: false},
      {name: 'Disabled Agent', subtitle: '飞书 · 0 个群聊', status: '已停用', disabled: false},
      {name: 'Error Agent', subtitle: '群配置读取失败', status: '读取失败', disabled: false},
    ]);
    assert.equal(await evaluate("document.querySelectorAll('section[aria-label=\"Bot 列表\"] .settings-add-row').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('section[aria-label=\"Bot 列表\"] .settings-entity-row').length"), 4);
    await until("document.querySelector('.collaboration-avatar.agent img')?.dataset.loaded === 'true'");
    process.stdout.write('PASS compact list, unique groups and status precedence\n');
    await evaluate("Array.from(document.querySelectorAll('.collaboration-agent-list-row')).find(row => row.querySelector('strong').textContent === 'Error Agent').click()");
    await until("document.querySelector('.settings-toolbar h1')?.textContent === 'Error Agent'");
    assert.equal(await evaluate("document.querySelector('.collaboration-profile')?.nextElementSibling?.textContent.includes('已绑定的飞书群')"), true);
    assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '加入飞书群')?.disabled"), true);
    await evaluate("document.querySelector('button[aria-label=\"返回列表\"]').click()");
    await until("document.querySelectorAll('.collaboration-agent-list-row').length === 4");
    await evaluate("document.querySelector('.collaboration-agent-list-row').click()");
    await until("document.querySelector('.settings-toolbar h1')?.textContent === 'Connected Agent'");
    await until("document.querySelectorAll('.settings-entity-row .collaboration-avatar.group img[data-loaded=true]').length === 2");
    await until("document.querySelector('.settings-entity-row .collaboration-avatar.group img[data-failed=true]') !== null");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.collaboration-avatar.group img[data-failed=true]')).display"), 'none');
    assert.equal(await evaluate("document.querySelector('.collaboration-avatar.group img[data-failed=true]').parentElement.querySelector('svg') !== null"), true);
    await evaluate("document.querySelector('button[aria-label=\"返回列表\"]').click()");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '群聊').click()");
    await until("document.querySelector('.section-title-link .collaboration-avatar.group img[data-loaded=true]') !== null");
    await evaluate("Array.from(document.querySelectorAll('.section-title-link')).find(button => button.textContent.trim() === 'One').click()");
    await until("document.querySelector('.collaboration-profile .collaboration-avatar.group.large img[data-loaded=true]') !== null");
    assert.equal(await evaluate("document.querySelector('.collaboration-profile .collaboration-avatar.group img').naturalWidth"), 1);
    await evaluate("document.querySelector('button[aria-label=\"返回列表\"]').click()");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Bot').click()");
    await evaluate("document.querySelector('.collaboration-agent-list-row').click()");
    await until("document.querySelector('.settings-toolbar h1')?.textContent === 'Connected Agent'");
    process.stdout.write('PASS actual group portraits on bound rows, list and detail with failed-image fallback\n');
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '加入飞书群').click()");
    await until("document.body.innerText.includes('让 Bot 加入飞书群')");
    await until("Boolean(document.querySelector('[aria-label=\"飞书群名称\"]'))");
    assert.equal(commands.some(command => command.type === 'listJoinedGroups'), false);
    assert.equal(await evaluate("document.body.innerText.includes('操作未完成')"), false);
    process.stdout.write('PASS detail navigation and join-group entry\n');
    snapshot.agents = [];
    snapshot.groups = [];
    snapshot.memberships = [];
    const emptyWindow = new BrowserWindow({show: false, width: 1060, height: 780, webPreferences: {
      preload: path.resolve('dist/preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false,
    }});
    try {
      await emptyWindow.loadFile(path.resolve('dist/renderer/index.html'));
      const empty = code => emptyWindow.webContents.executeJavaScript(code);
      for (let index = 0; index < 100 && !(await empty("document.body.innerText.includes('邀请你的第一个 Bot')")); index++) await pause(50);
      assert.equal(await empty("document.body.innerText.includes('邀请你的第一个 Bot')"), true);
      assert.equal(await empty("Array.from(document.querySelectorAll('button')).filter(button => button.textContent.trim() === '添加 Bot').length"), 1);
      await empty("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '添加 Bot').click()");
      assert.equal(commands.at(-1).type, 'registerAgent');
      process.stdout.write('PASS first Agent empty state retains registration entry\n');
    } finally {emptyWindow.destroy();}
  } finally {
    if (!window.isDestroyed()) window.destroy();
    app.quit();
  }
}).catch(error => {process.stderr.write(`${error.stack}\n`); app.exit(1);});
