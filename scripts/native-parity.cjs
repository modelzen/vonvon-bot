const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const home = process.env.VONVON_DESKTOP_TEST_HOME;
const mode = process.env.VONVON_PARITY_MODE;
if (!home || process.env.HOME !== home || process.env.USERPROFILE !== home || !process.env.CODEX_HOME?.startsWith(home)) throw new Error('Isolated home required');
if (!['migration', 'conflict', 'delete', 'active', 'restart'].includes(mode)) throw new Error('Unknown probe mode');
app.on('browser-window-created', (_event, created) => { created.hide(); created.on('show', () => created.hide()); });
require('../dist/main.cjs');
let phase = 'startup';
const deadline = setTimeout(() => { process.stderr.write(`Native parity timeout in ${phase}; home=${home}\n`); app.exit(1); }, 90000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = expression => window.webContents.executeJavaScript(expression);
let window;
async function poll(operation, accept, label) {
  for (let n = 0; n < 200; n++) {
    const value = await operation();
    if (accept(value)) return value;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function snapshot() {
  return evaluate('new Promise(resolve=>{let stop;stop=window.bridge.watch(value=>{resolve(value);queueMicrotask(()=>stop?.());});})');
}
async function run(command) {
  return evaluate(`window.bridge.run(${JSON.stringify(command)})`);
}
async function settings(request) {
  return evaluate(`window.bridge.settings(${JSON.stringify(request)})`);
}
async function click(label) {
  const expression = `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)})`;
  try { await poll(() => evaluate(expression + ' ? true : false'), Boolean, `button ${label}`); } catch (error) { process.stderr.write(JSON.stringify(await evaluate(`({body:document.body.innerText,buttons:[...document.querySelectorAll('button')].map(b=>b.textContent.trim())})`))+'\n'); throw error; }
  const clicked = await evaluate(`(()=>{const b=${expression};if(b.disabled)return false;b.click();return true})()`);
  assert.equal(clicked, true, `button ${label} enabled`);
}
async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
void app.whenReady().then(async () => {
  window = await poll(() => BrowserWindow.getAllWindows()[0], Boolean, 'window');
  await poll(() => window.webContents.isLoading(), value => !value, 'renderer load');
  const expected = mode === 'conflict' ? 'blocked' : 'connected';
  phase = `wait ${expected}`;
  let state = await poll(snapshot, value => value?.host?.kind === expected && (expected === 'blocked' || (value.application.dataPath !== '尚未确认' && !value.stale)), `Host ${expected}`);
  if (process.env.VONVON_PARITY_INJECT_FAILURE === 'after-host') {
    const pid = JSON.parse(await fs.readFile(path.join(home, '.vonvon-bridge', 'web-console.json'), 'utf8')).pid;
    await fs.writeFile(path.join(home, 'injected-failure.json'), JSON.stringify({ phase: 'after-host', pid }));
    throw new Error('Deliberate probe failure after owned Host connection');
  }
  const result = { mode, initial: { host: state.host, agents: state.agents.map(agent => ({ id: agent.id, enabled: agent.enabled, connection: agent.connection })), dataPath: state.application.dataPath }, osServiceQueries: process.env.VONVON_OS_QUERIES };
  if (mode === 'migration') {
    phase = 'migrated store';
    const oldPath = path.join(home, '.feishu-codex-bridge');
    const newPath = path.join(home, '.vonvon-bridge');
    assert.equal((await fs.lstat(oldPath)).isSymbolicLink(), true);
    assert.equal(await fs.realpath(oldPath), await fs.realpath(newPath));
    assert.equal(state.application.dataPath, newPath);
    const response = await settings({ type: 'read', scope: { kind: 'host' } });
    assert.equal(response.kind, 'view', JSON.stringify(response));
    const saved = await settings({ type: 'save', edit: { scope: { kind: 'host' }, section: 'execution', revision: response.view.sections.execution.revision, patch: { codexBin: null } } });
    assert.equal(saved.result.kind, 'saved', JSON.stringify(saved));
    const oldSettings = await readOptional(path.join(oldPath, 'service-environment.json'));
    const newSettings = await readOptional(path.join(newPath, 'service-environment.json'));
    assert.ok(oldSettings, 'Desktop save created service-environment.json');
    assert.equal(JSON.parse(oldSettings).codexBin, null);
    assert.equal(oldSettings, newSettings);
    result.alias = { oldPath, newPath, oldIsSymlink: true, sameRealpath: true, settingsBytesEqual: true, saved: saved.result.kind };
    const agent = await settings({ type: 'read', scope: { kind: 'agent', botId: 'cli_fixture_engineering' } });
    assert.equal(agent.kind, 'view', JSON.stringify(agent));
    assert.equal(agent.view.sections.cards.access.kind, 'readonly');
    const denied = await settings({ type: 'save', edit: { scope: { kind: 'agent', botId: 'cli_fixture_engineering' }, section: 'cards', revision: agent.view.sections.cards.revision, patch: { showToolCalls: true } } });
    assert.equal(denied.result.kind, 'unavailable', JSON.stringify(denied));
    await click('Agent');
    await click('研发助手');
    await poll(() => evaluate("document.body.innerText.includes('显示工具调用')"), Boolean, 'stopped Agent settings');
    const ui = await evaluate(`({text:document.body.innerText, disabled:[...document.querySelectorAll('button')].filter(b=>b.textContent.includes('保存')).map(b=>b.disabled)})`);
    assert.equal(ui.disabled.length > 0 && ui.disabled.every(Boolean), true, 'Visible save controls disabled');
    result.stoppedSettings = { readonly: agent.view.sections.cards.access.kind, denied: denied.result.kind, previewVisible: ui.text.includes('显示工具调用'), saveControlsDisabled: ui.disabled.every(Boolean), saveControlCount: ui.disabled.length };
  }
  if (mode === 'conflict') {
    phase = 'conflict recovery';
    const oldPath = path.join(home, '.feishu-codex-bridge');
    const newPath = path.join(home, '.vonvon-bridge');
    const oldBefore = await readOptional(path.join(oldPath, 'fixture-conflict.txt'));
    const newBefore = await readOptional(path.join(newPath, 'fixture-conflict.txt'));
    assert.notEqual(oldBefore, newBefore);
    const body = await evaluate('document.body.innerText');
    result.blocked = { message: state.host.message, bothPathsNamed: state.host.message.includes(oldPath) && state.host.message.includes(newPath), uiShowsConflict: body.includes('Bridge 尚未就绪') && body.includes('.vonvon-bridge') && body.includes('.feishu-codex-bridge'), oldBefore, newBefore };
    await fs.rename(newPath, `${newPath}.held-for-recovery`);
    await click('状态与诊断');
    await click('重新检查');
    state = await poll(snapshot, value => value?.host?.kind === 'connected' && !value.stale, 'reconnected Host');
    result.recovered = { host: state.host, dataPath: state.application.dataPath, oldAlias: (await fs.lstat(oldPath)).isSymbolicLink(), newStore: await readOptional(path.join(newPath, 'fixture-conflict.txt')), heldStore: await readOptional(`${newPath}.held-for-recovery/fixture-conflict.txt`) };
  }
  if (mode === 'delete') {
    phase = 'stopped agent deletion';
    const firstFile = path.join(home, '.vonvon-bridge', 'bots', 'cli_fixture_engineering', 'config.json');
    const before = await fs.readFile(firstFile, 'utf8');
    const secretsBefore = JSON.parse(await fs.readFile(path.join(home, '.vonvon-bridge', 'secrets.enc'), 'utf8'));
    const reply = await run({ type: 'deleteAgent', agentId: 'cli_fixture_content' });
    result.deleteReply = reply;
    assert.equal(reply.kind, 'applied', JSON.stringify(reply));
    state = await poll(snapshot, value => value.agents.length === 1, 'one remaining Agent');
    const secretsAfter = JSON.parse(await fs.readFile(path.join(home, '.vonvon-bridge', 'secrets.enc'), 'utf8'));
    result.preserved = { remainingIds: state.agents.map(agent => agent.id), firstConfigBytesEqual: before === await fs.readFile(firstFile, 'utf8'), deletedDirectoryAbsent: await fs.stat(path.join(home, '.vonvon-bridge', 'bots', 'cli_fixture_content')).then(() => false, error => error.code === 'ENOENT'), removedTargetSecret: !('app-cli_fixture_content' in secretsAfter.entries), otherSecretBytesEqual: JSON.stringify(secretsBefore.entries['app-cli_fixture_engineering']) === JSON.stringify(secretsAfter.entries['app-cli_fixture_engineering']) };
  }
  if (mode === 'active') {
    phase = 'active deletion guard';
    const registryPath = path.join(home, '.vonvon-bridge', 'bots.json');
    const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    registry.bots[0].active = true;
    await fs.writeFile(registryPath, JSON.stringify(registry));
    await run({ type: 'refresh' });
    const target = path.join(home, '.vonvon-bridge', 'bots', 'cli_fixture_engineering');
    const names = ['config.json', 'projects.json', 'sessions.json', 'comment-instructions.md'];
    const before = await Promise.all(names.map(name => fs.readFile(path.join(target, name))));
    const registryBefore = await fs.readFile(registryPath);
    const secretsPath = path.join(home, '.vonvon-bridge', 'secrets.enc');
    const secretsBefore = await fs.readFile(secretsPath);
    const reply = await run({ type: 'deleteAgent', agentId: 'cli_fixture_engineering' });
    result.activeReply = reply;
    assert.equal(reply.kind, 'refused', JSON.stringify(reply));
    assert.equal(reply.code, 'agent-active');
    const targetFilesUnchanged = (await Promise.all(names.map(name => fs.readFile(path.join(target, name))))).every((value, index) => value.equals(before[index]));
    const registryBytesEqual = (await fs.readFile(registryPath)).equals(registryBefore);
    const secretBytesEqual = (await fs.readFile(secretsPath)).equals(secretsBefore);
    assert.equal(targetFilesUnchanged && registryBytesEqual && secretBytesEqual, true);
    result.preserved = { targetFilesUnchanged, registryBytesEqual, secretBytesEqual, targetListed: (await snapshot()).agents.some(agent => agent.id === 'cli_fixture_engineering') };
  }
  if (mode === 'restart') {
    phase = 'owned restart';
    const before = await snapshot();
    const beforePid = JSON.parse(await fs.readFile(path.join(home, '.vonvon-bridge', 'web-console.json'), 'utf8')).pid;
    const read = await settings({ type: 'read', scope: { kind: 'host' } });
    const save = await settings({ type: 'save', edit: { scope: { kind: 'host' }, section: 'execution', revision: read.view.sections.execution.revision, patch: { codexBin: null } } });
    assert.equal(save.result.kind, 'saved', JSON.stringify(save));
    const reply = await run({ type: 'restartHost' });
    assert.equal(reply.kind, 'applied', JSON.stringify(reply));
    result.restartReply = reply;
    state = await poll(snapshot, value => value.host.kind === 'connected' && !value.stale && value.revision > before.revision, 'Host restart');
    const after = await settings({ type: 'read', scope: { kind: 'host' } });
    const afterPid = JSON.parse(await fs.readFile(path.join(home, '.vonvon-bridge', 'web-console.json'), 'utf8')).pid;
    assert.notEqual(afterPid, beforePid, 'Owned restart created a new Host process');
    assert.equal(after.view.sections.execution.stored.codexBin, null);
    assert.deepEqual(state.agents.map(agent => agent.id).sort(), before.agents.map(agent => agent.id).sort());
    result.restart = { beforePid, afterPid, beforeOwnership: before.host.ownership, afterOwnership: state.host.ownership, afterVersion: state.host.version, preservedAgentIds: state.agents.map(agent => agent.id).sort(), savedSetting: after.view.sections.execution.stored.codexBin };
  }
  await fs.writeFile(path.join(home, 'parity-result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${mode} native probe complete; evidence=${home}\n`);
  clearTimeout(deadline);
  app.quit();
}).catch(error => { process.stderr.write(`${phase}: ${error.stack}\n`); clearTimeout(deadline); app.exit(1); });
