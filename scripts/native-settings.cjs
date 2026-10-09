const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const home = mkdtempSync(path.join(tmpdir(), "vonvon-settings-ui-"));
app.setPath("userData", path.join(home, "electron"));
app.on("window-all-closed", () => {});
const fixture = JSON.parse(readFileSync(path.resolve("tests/fixtures/agent-settings.json"), "utf8"));
const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ["terminal", "error", "initial-error", "stuck", "pending", "navigation", "overlap", "unmount"];
const results = [];
let phase = "starting";
let reads = 0;
const deadline = setTimeout(() => {
  process.stderr.write(`Settings UI timed out during ${phase}; reads=${reads}; evidence=${home}\n`);
  app.exit(1);
}, 160000);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

ipcMain.handle('bridge:run', (_event, command) => {
  assert.equal(command.type, 'listPendingGroups');
  return {command: command.type, result: {kind: 'pendingGroups', groups: []}};
});

void app.whenReady().then(async () => {
  for (const scenario of scenarios) {
    assert.ok(["terminal", "error", "initial-error", "stuck", "pending", "navigation", "overlap", "unmount"].includes(scenario));
    phase = scenario;
    reads = 0;
    let retry = false;
    let release;
    const view = structuredClone(fixture);
    const secondId = "cli_fixture_second";
    const reply = (message, botId = view.scope.botId) => {
      const copy = structuredClone(view);
      copy.scope.botId = botId;
      if (message) copy.voice.feishu = { state: "missing_permission", message };
      return { kind: "view", view: copy };
    };
    const snapshot = {
      revision: 1, observedAt: Date.now(), stale: false,
      host: { kind: "connected", ownership: "owned", version: "0.7.0" },
      agents: [
        { id: view.scope.botId, name: "Parity Agent", enabled: true, connection: "connected", activation: "active" },
        { id: secondId, name: "Second Agent", enabled: true, connection: "connected", activation: "active" },
      ],
      groups: [], memberships: [], tools: [], jobs: [], diagnostics: [],
      application: { platform: process.platform === "darwin" ? "macos" : "windows", version: "0.7.0", loginItem: false, dataPath: home },
    };
    ipcMain.removeHandler("bridge:watch");
    ipcMain.removeHandler("bridge:settings");
    ipcMain.removeHandler('bridge:collaboration');
    ipcMain.handle('bridge:collaboration', () => ({kind: 'refused', code: 'fixture-unused', message: 'This fixture covers settings navigation.'}));
ipcMain.handle("bridge:watch", () => snapshot);
    ipcMain.handle("bridge:settings", (_event, request) => {
      if (request.type === "models") return { kind: "refused", code: "fixture", message: "Model catalogs are outside this fixture." };
      assert.equal(request.type, "read", "Unexpected settings mutation in a read-only fixture");
      if (request.scope.botId === secondId) return reply("SECOND AGENT STATUS", secondId);
      reads++;
      if (scenario === "initial-error" && reads === 1) throw new Error("FIXTURE CONNECTION LOST");
      if (scenario === "error" && reads > 1 && !retry) throw new Error("FIXTURE CONNECTION LOST");
      if (scenario === "stuck" || scenario === "unmount") return reply();
      if (scenario === "pending" && reads > 1) return new Promise(resolve => { release = resolve; });
      if (scenario === "navigation" && reads > 1) return new Promise(resolve => { release = resolve; });
      if (scenario === "overlap") {
        if (reads === 2) return new Promise(resolve => { release = resolve; });
        return reply(reads === 1 ? "INITIAL STATUS" : "NEWEST STATUS");
      }
      return reads === 1 ? reply() : reply("尚未获得语音识别权限");
    });
    const window = new BrowserWindow({ show: false, width: 1060, height: 780, webPreferences: {
      preload: path.resolve("dist/preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    const evaluate = expression => window.webContents.executeJavaScript(expression);
    const until = async (expression, milliseconds = 6000) => {
      const end = Date.now() + milliseconds;
      while (Date.now() < end) {
        if (await evaluate(expression)) return;
        await delay(100);
      }
      assert.fail(`${scenario}: condition not met: ${expression}; reads=${reads}`);
    };
    const button = label => `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)} || button.querySelector('.settings-entity-row__copy strong')?.textContent.trim()===${JSON.stringify(label)})`;
    const draftField = "document.querySelector('input[aria-label=\"最大并发任务\"]')";
    const click = async label => { await until(`Boolean(${button(label)})`); await evaluate(`${button(label)}.click()`); };
    try {
      await window.loadFile(path.resolve("dist/renderer/index.html"));
      await click("Parity Agent");
      await click("Bot 设置");
      if (scenario === "initial-error") {
        await until("document.body.innerText.includes('FIXTURE CONNECTION LOST')");
        await click("重新读取");
        await until("document.body.innerText.includes('尚未获得语音识别权限')");
      } else if (scenario === "overlap") {
        await until("document.body.innerText.includes('INITIAL STATUS')");
        await click("重新读取");
        await click("重新读取");
        await until("document.body.innerText.includes('NEWEST STATUS')");
        assert.ok(release, "Older read is pending");
        release(reply("STALE STATUS"));
        await delay(250);
        assert.equal(await evaluate("document.body.innerText.includes('NEWEST STATUS') && !document.body.innerText.includes('STALE STATUS')"), true);
      } else {
        await until("document.body.innerText.includes('正在检查权限')");
        await evaluate(`{const field=${draftField}; const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(field, '6'); field.dispatchEvent(new Event('input', {bubbles:true}));}`);
        await until(`${draftField}?.value === '6'`);
        const draft = await evaluate(`${draftField}.value`);
        if (scenario === "navigation" || scenario === "unmount") {
          if (scenario === "navigation") {
            for (let index = 0; index < 30 && !release; index++) await delay(100);
            assert.ok(release, "Background read is pending before navigation");
          }
          await evaluate("document.querySelector('button[aria-label=\"返回 Bot 列表\"]').click()");
          await click("放弃并离开");
          await click("Second Agent");
          await click("Bot 设置");
          await until("document.body.innerText.includes('SECOND AGENT STATUS')");
          const count = reads;
          if (release) release(reply("STALE FIRST AGENT"));
          await delay(1600);
          assert.equal(reads, count, "Leaving the first Agent stops its reads");
          assert.equal(await evaluate("document.body.innerText.includes('SECOND AGENT STATUS') && !document.body.innerText.includes('STALE FIRST AGENT')"), true);
        } else {
          if (scenario === "error") {
            await until("document.body.innerText.includes('FIXTURE CONNECTION LOST')");
            assert.equal(await evaluate(`${draftField}?.value`), draft, "A refresh failure preserves the draft");
            const count = reads;
            await delay(1300);
            assert.equal(reads, count, "Failed refresh pauses automatic reads");
            retry = true;
            await click("重新读取");
          }
          if (scenario === "stuck") await until("document.body.innerText.includes('已暂停自动刷新')", 35000);
          else if (scenario === "pending") await until("document.body.innerText.includes('读取超时')", 15000);
          else await until("document.body.innerText.includes('尚未获得语音识别权限')");
          assert.equal(await evaluate(`${draftField}?.value`), draft, "Refresh preserves unsaved draft");
          const count = reads;
          await delay(1600);
          assert.equal(reads, count, "Terminal, failed or exhausted refresh stops polling");
          if (scenario === "stuck") assert.ok(reads <= 6, "A testing episode has at most six reads");
          if (scenario === "pending") {
            assert.equal(reads, 2, "A hung read does not start another automatic request");
            release(reply("LATE TIMED OUT STATUS"));
            await delay(250);
            assert.equal(await evaluate("document.body.innerText.includes('LATE TIMED OUT STATUS')"), false);
          }
        }
      }
      writeFileSync(path.join(home, `${scenario}.png`), (await window.capturePage()).toPNG());
      results.push({ scenario, reads, status: "PASS" });
      writeFileSync(path.join(home, "result.json"), JSON.stringify(results, null, 2));
      process.stdout.write(`PASS ${scenario}; reads=${reads}; evidence=${home}\n`);
    } finally {
      window.destroy();
    }
  }
  clearTimeout(deadline);
  app.quit();
}).catch(error => {
  process.stderr.write(`${phase}: ${error.stack}; reads=${reads}; evidence=${home}\n`);
  clearTimeout(deadline);
  app.exit(1);
});
