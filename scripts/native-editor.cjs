const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'vonvon-editor-')));
app.on('window-all-closed', () => {});
const fixture = JSON.parse(readFileSync(path.resolve('tests/fixtures/agent-settings.json'), 'utf8'));
const portrait = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5LsAAAAASUVORK5CYII=';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const snapshot = {
  revision: 1, observedAt: Date.now(), stale: false,
  host: { kind: 'connected', ownership: 'owned', version: '0.7.0' },
  agents: [{ id: fixture.scope.botId, name: 'Parity Agent', avatarDataUrl: portrait, enabled: true, connection: 'connected', activation: 'active' }],
  groups: [], memberships: [], tools: [], jobs: [], diagnostics: [],
  application: { platform: 'macos', version: '0.7.0', loginItem: false, dataPath: tmpdir() },
};

void app.whenReady().then(async () => {
  const interactive = process.argv.includes('--interactive');
  for (const scenario of interactive ? ['mixed'] : ['mixed', 'failure', 'conflict', 'pending']) {
    const view = structuredClone(fixture);
    const saves = [];
    let rejectFirst = scenario === 'failure';
    let conflictFirst = scenario === 'conflict';
    let releasePending;
    ipcMain.removeHandler('bridge:watch');
    ipcMain.removeHandler('bridge:settings');
    ipcMain.removeHandler('bridge:collaboration');
    ipcMain.handle('bridge:collaboration', () => ({kind:'refused',code:'fixture',message:'No collaboration fixture'}));
    ipcMain.handle('bridge:watch', () => snapshot);
    ipcMain.handle('bridge:settings', (_event, request) => {
      if (request.type === 'models') return {kind:'refused',code:'fixture',message:'No models'};
      if (request.type === 'read') return { kind: 'view', view: structuredClone(view) };
      assert.equal(request.type, 'save');
      assert.equal(request.edit.section, 'run');
      saves.push(structuredClone(request.edit));
      if (rejectFirst) {
        rejectFirst = false;
        return { kind: 'saved', result: { kind: 'rejected', fields: [{ field: 'pendingPolicy', message: 'FIXTURE REJECTED' }] } };
      }
      if (conflictFirst) {
        conflictFirst = false;
        view.sections.run.revision = 'external-revision';
        return { kind: 'saved', result: { kind: 'conflict', current: { scope: view.scope, section: 'run', value: structuredClone(view.sections.run) } } };
      }
      const complete = () => {
        assert.equal(request.edit.revision, view.sections.run.revision);
        Object.assign(view.sections.run.stored, request.edit.patch);
        view.sections.run.revision = `rev-${saves.length}`;
        return { kind: 'saved', result: {
          kind: 'saved', section: { scope: view.scope, section: 'run', value: structuredClone(view.sections.run) },
          effects: [{ fields: Object.keys(request.edit.patch), when: 'next-message', detail: '下一条消息生效' }],
        } };
      };
      if (scenario === 'pending' && saves.length === 1) return new Promise(resolve => {releasePending = () => resolve(complete());});
      return complete();
    });
    const window = new BrowserWindow({show:interactive,width:1080,height:780,webPreferences:{
      preload:path.resolve('dist/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,
    }});
    const evalJs = expression => window.webContents.executeJavaScript(expression);
    const until = async expression => {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await evalJs(expression)) return;
        await pause(100);
      }
      assert.fail(`${scenario}: condition not met: ${expression}`);
    };
    const field = label => `document.querySelector('[aria-label=${JSON.stringify(label)}]')`;
    const setInput = async (label, value) => evalJs(`{const element=${field(label)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event('input',{bubbles:true}));}`);
    const setSelect = async (label, value) => evalJs(`{const element=${field(label)}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event('change',{bubbles:true}));}`);
    const click = async label => evalJs(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`);
    try {
      await window.loadFile(path.resolve('dist/renderer/index.html'));
      if (interactive) {
        window.show();
        process.stdout.write('Interactive Agent settings fixture ready. Close the window to finish.\n');
        await new Promise(resolve => window.once('closed', resolve));
        continue;
      }
      await until("Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === 'Parity Agent')");
      await click('Parity Agent');
      await until(`Boolean(${field('最大并发任务')})`);
      await until("document.querySelector('.collaboration-profile .collaboration-avatar-image')?.naturalWidth === 1");
      await setInput('最大并发任务', '6');
      await until(`${field('最大并发任务')}.value === '6'`);
      assert.equal(saves.length, 0, `${scenario}: number is manual`);
      await setSelect('待处理消息策略', 'steer');
      await until('document.body.innerText.includes(\'下一条消息生效\') || document.body.innerText.includes(\'FIXTURE REJECTED\') || document.body.innerText.includes(\'设置已在别处更改\')');
      assert.equal(saves.length, 1);
      assert.deepEqual(saves[0].patch, {pendingPolicy:'steer'});
      assert.equal(await evalJs(`${field('最大并发任务')}.value`), '6');
      if (scenario === 'mixed') {
        await until("document.body.innerText.includes('本次修改已保存')");
        await click('保存');
        await until('document.body.innerText.includes(\'已保存\') && document.querySelector(\'input[aria-label="最大并发任务"]\').value === "6"');
        await pause(300);
        assert.equal(saves.length, 2);
        assert.deepEqual(saves[1].patch, {maxConcurrentRuns:6});
        assert.equal(saves[1].revision, 'rev-1');
      } else if (scenario === 'failure') {
        await until("document.body.innerText.includes('FIXTURE REJECTED')");
        assert.equal(await evalJs(`${field('待处理消息策略')}.disabled`), true);
        assert.equal(await evalJs(`${field('最大并发任务')}.disabled`), true);
        assert.equal(await evalJs(`${field('待处理消息策略')}.value`), 'steer');
        assert.equal(saves.length, 1, 'failed patch remains pending until retry');
        await click('重试');
        await until("document.body.innerText.includes('本次修改已保存')");
        assert.deepEqual(saves[1].patch, {pendingPolicy:'steer'});
        assert.equal(await evalJs(`${field('最大并发任务')}.value`), '6');
        await click('保存');
        await until("document.querySelector('input[aria-label=\"最大并发任务\"]')?.value === '6' && document.body.innerText.includes('已保存')");
        assert.deepEqual(saves[2].patch, {maxConcurrentRuns:6});
        assert.equal(saves[2].revision, 'rev-2');
        assert.equal(view.sections.run.stored.maxConcurrentRuns, 6);
        await evalJs("document.querySelector('button[aria-label=\"返回列表\"]').click()");
        await until("document.body.innerText.includes('有未保存的修改')");
        await click('保存并离开');
        await until("document.body.innerText.includes('Parity Agent') && !document.body.innerText.includes('最大并发任务')");
      } else if (scenario === 'pending') {
        await until("document.body.innerText.includes('正在保存')");
        await evalJs("document.querySelector('button[aria-label=\"返回列表\"]').click()");
        await until("document.body.innerText.includes('有未保存的修改')");
        await click('继续编辑');
        assert.equal(await evalJs(`${field('待处理消息策略')}.disabled`), true);
        releasePending();
        await until("document.body.innerText.includes('本次修改已保存')");
        await click('保存');
        await pause(300);
        assert.deepEqual(saves[1].patch, {maxConcurrentRuns:6});
        assert.equal(saves[1].revision, 'rev-1');
      } else {
        await until("document.body.innerText.includes('设置已在别处更改')");
        assert.equal(await evalJs(`${field('最大并发任务')}.value`), '6');
        assert.equal(await evalJs(`${field('待处理消息策略')}.value`), 'steer');
        await click('重新读取并放弃草稿');
        await until(`${field('最大并发任务')}.value === '5'`);
        await setInput('最大并发任务', '7');
        await until(`${field('最大并发任务')}.value === '7'`);
        await click('保存');
        await pause(300);
        assert.deepEqual(saves[1].patch, {maxConcurrentRuns:7});
        assert.equal(saves[1].revision, 'external-revision');
      }
      process.stdout.write(`PASS editor ${scenario}\n`);
    } finally { window.destroy(); }
  }
  app.quit();
}).catch(error => { process.stderr.write(`${error.stack}\n`); app.exit(1); });
