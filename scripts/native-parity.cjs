const { app, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const home = process.env.VONVON_DESKTOP_TEST_HOME;
const mode = process.env.VONVON_PARITY_MODE;
if (!home || process.env.HOME !== home || process.env.USERPROFILE !== home || !process.env.CODEX_HOME?.startsWith(home)) throw new Error('Isolated home required');
if (!['migration', 'conflict', 'delete', 'active', 'restart', 'crash', 'temporary', 'logs', 'environment'].includes(mode)) throw new Error('Unknown probe mode');
app.on('browser-window-created', (_event, created) => { created.hide(); created.on('show', () => created.hide()); });
require('../dist/main.cjs');
let phase = 'startup';
const deadline = setTimeout(() => { process.stderr.write(`Native parity timeout in ${phase}; home=${home}\n`); app.exit(1); }, mode === 'environment' ? 600000 : 90000);
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
  try { await poll(() => evaluate(`Boolean(${expression} && !(${expression}).disabled)`), Boolean, `enabled button ${label}`); } catch (error) { process.stderr.write(JSON.stringify(await evaluate(`({body:document.body.innerText,buttons:[...document.querySelectorAll('button')].map(b=>b.textContent.trim())})`))+'\n'); throw error; }
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
    await click('Bot');
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
  if (mode === 'temporary') {
    phase = 'temporary Agent selection';
    const registryPath = path.join(home, '.vonvon-bridge', 'bots.json');
    const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    registry.bots.forEach(bot => {bot.active = true;});
    await fs.writeFile(registryPath, JSON.stringify(registry));
    const registryBefore = await fs.readFile(registryPath, 'utf8');
    await click('应用与启动');
    await click('停止 Bridge');await click('确认操作');
    await poll(snapshot, value => value.host.kind === 'disconnected', 'stopped Host');
    await evaluate(`Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(document.querySelector('[aria-label="临时运行的 Bot"]'),'cli_fixture_content');document.querySelector('[aria-label="临时运行的 Bot"]').dispatchEvent(new Event('change',{bubbles:true}));`);
    await click('仅运行此 Bot');
    state = await poll(snapshot, value => value.host.kind === 'blocked', 'invalid-credential refusal');
    const actual = await evaluate(`window.bridge.machine({type:'status'})`);
    assert.equal(actual.host, null);
    assert.equal(actual.temporaryAgent, undefined);
    assert.equal(await fs.readFile(registryPath, 'utf8'), registryBefore);
    result.temporary = {outcome:'refused-invalid-fixture-credentials',persistedSetUnchanged:true,noRunningHost:true,positiveLiveRun:'not-tested'};
  }
  if (mode === 'environment') {
    phase = 'real isolated npm tool lifecycle';
    const environment = request => evaluate(`window.bridge.environment(${JSON.stringify(request)})`);
    result.tools = [];
    for (const tool of ['codex', 'claude', 'lark-cli']) {
      phase = `install ${tool}`;
      const installed = await environment({type:'install',tool});
      assert.equal(installed.kind,'applied',JSON.stringify(installed));
      const scan = await environment({type:'scan'});
      const state = scan.tools.find(entry=>entry.tool===tool);
      assert.equal(state.installation,'managed');
      assert.ok(state.version && state.managedVersion);
      assert.ok(state.executable.startsWith(path.join(home,'.vonvon-bridge','managed-tools',tool,'releases')));
      const pointerPath = path.join(home,'.vonvon-bridge','managed-tools',tool,'current.json');
      const first = JSON.parse(await fs.readFile(pointerPath,'utf8'));
      if (tool === 'codex') {
        phase = 'cancel actual Codex update';
        await evaluate("window.pendingInstall=window.bridge.environment({type:'update',tool:'codex'});true");
        const pending = await environment({type:'toolInstallStatus'});
        assert.equal(pending.operation.kind,'running');
        const cancelled = await environment({type:'cancelInstall',operationId:pending.operation.id});
        assert.equal(cancelled.operation.kind,'cancelled');
        assert.equal((await evaluate('window.pendingInstall')).kind,'refused');
        assert.deepEqual(JSON.parse(await fs.readFile(pointerPath,'utf8')),first);
        result.realInstallCancellation = {oldSelectionUnchanged:true,retryFollows:true};
      }
      phase = `update ${tool}`;
      const updated = await environment({type:'update',tool});
      assert.equal(updated.kind,'applied',JSON.stringify(updated));
      const second = JSON.parse(await fs.readFile(pointerPath,'utf8'));
      assert.notEqual(second.generation,first.generation);
      await fs.access(state.executable);
      phase = `uninstall ${tool}`;
      const removed = await environment({type:'uninstall',tool});
      assert.equal(removed.kind,'applied',JSON.stringify(removed));
      const after = await environment({type:'scan'});
      assert.notEqual(after.tools.find(entry=>entry.tool===tool).installation,'managed');
      assert.equal(JSON.parse(await fs.readFile(pointerPath,'utf8')).state,'disabled');
      await fs.access(state.executable);
      result.tools.push({tool,version:state.managedVersion,installed:true,updated:true,uninstalled:true,priorReleaseRetained:true});
      process.stdout.write(`PASS actual npm lifecycle ${tool} ${state.managedVersion}\n`);
    }
  }
  if (mode === 'logs') {
    phase = 'bounded log view and follow';
    const logDir = path.join(home, '.vonvon-bridge', 'logs');
    await fs.mkdir(logDir, {recursive:true});
    const logPath = path.join(logDir, `${new Date().toISOString().slice(0,10)}.log`);
    await fs.writeFile(logPath, 'x'.repeat(160*1024)+'\nLOG-FIRST\nLOG-SECOND\n');
    await click('状态与诊断');
    await poll(()=>evaluate("document.querySelector('pre')?.textContent?.includes('LOG-SECOND')"),Boolean,'initial log tail');
    let text = await evaluate("document.querySelector('pre').textContent");
    assert.ok(text.indexOf('LOG-FIRST') < text.indexOf('LOG-SECOND'));
    assert.ok(Buffer.byteLength(text) <= 128*1024);
    await evaluate("[...document.querySelectorAll('label')].find(label=>label.textContent.includes('持续跟随')).querySelector('input').click()");
    await fs.appendFile(logPath, 'LOG-THIRD\n');
    await poll(()=>evaluate("document.querySelector('pre')?.textContent?.includes('LOG-THIRD')"),Boolean,'follow appended line');
    await evaluate("window.bridge.machine({type:'stopHost'})");
    await poll(()=>evaluate("document.querySelector('[role=alert]')?.textContent?.includes('已停止')"),Boolean,'log disconnect');
    await evaluate("window.bridge.machine({type:'startHost'})");
    await fs.appendFile(logPath, 'LOG-RECONNECTED\n');
    await poll(()=>evaluate("document.querySelector('pre')?.textContent?.includes('LOG-RECONNECTED') && !document.querySelector('[role=alert]')"),Boolean,'log reconnect');
    result.logs = {tailOrdered:true,followed:true,disconnected:true,reconnected:true,bounded:true};
  }
  if (mode === 'crash') {
    phase = 'renderer crash quit';
    const gone = new Promise(resolve => window.webContents.once('render-process-gone', resolve));
    window.webContents.forcefullyCrashRenderer();await gone;
    assert.equal(window.webContents.isCrashed(),true);
    result.rendererCrashed = true;
  }
  await fs.writeFile(path.join(home, 'parity-result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${mode} native probe complete; evidence=${home}\n`);
  clearTimeout(deadline);
  if (mode === 'crash') {
    const quitItem = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === '退出');
    assert.ok(quitItem);quitItem.click();
  } else app.quit();
}).catch(error => { process.stderr.write(`${phase}: ${error.stack}\n`); clearTimeout(deadline); app.exit(1); });
