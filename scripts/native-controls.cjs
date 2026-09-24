const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const { mkdtempSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const home = mkdtempSync(path.join(tmpdir(), "vonvon-native-controls-"));
const userData = path.join(home, "electron-user-data");
mkdirSync(userData);
app.setPath("userData", userData);

let window;
let snapshot;
const commands = [];
const registrationUrl = "https://accounts.feishu.cn/register?token=fixture%2Fvalue&next=%2Fconsole";
const job = {
  id: "fixture_registration",
  type: "registerAgent",
  phase: "qr",
  image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  url: registrationUrl,
  expiresAt: Date.now() + 120000,
};
const timeout = setTimeout(() => {
  process.stderr.write("Native renderer control checks timed out.\n");
  app.exit(1);
}, 60000);

async function waitFor(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Renderer condition did not become true: ${expression}`);
}

async function click(label) {
  const match = `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)})`;
  await waitFor(`Boolean(${match})`);
  assert.equal(await window.webContents.executeJavaScript(`(()=>{const button=${match};if(button.disabled)return false;button.click();return true;})()`), true, label);
}

function publish() {
  snapshot = { ...snapshot, revision: snapshot.revision + 1, observedAt: Date.now() };
  window.webContents.send("bridge:snapshot", snapshot);
}

void app.whenReady().then(async () => {
  snapshot = {
    revision: 1, observedAt: Date.now(), stale: false,
    host: { kind: "connected", ownership: "owned", version: "0.7.0" },
    agents: [], groups: [], memberships: [], tools: [], jobs: [], diagnostics: [],
    application: { platform: process.platform === "darwin" ? "macos" : "windows", version: "0.7.0", loginItem: false, dataPath: path.join(home, ".vonvon-bridge") },
  };
  ipcMain.handle("bridge:watch", () => snapshot);
  ipcMain.handle("bridge:run", (_event, command) => {
    commands.push(command);
    let result = { kind: "applied", revision: snapshot.revision };
    if (command.type === "registerAgent") {
      snapshot.jobs = [job];
      publish();
      result = { kind: "started", jobId: job.id };
    }
    return { command: command.type, result };
  });
  window = new BrowserWindow({ width: 1060, height: 780, show: false, webPreferences: {
    preload: path.resolve("dist/preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  await window.loadFile(path.resolve("dist/renderer/index.html"));
  await click("本机环境");
  const states = [
    ["missing", "unknown", true, false],
    ["installed", "signedOut", false, true],
    ["installed", "signedIn", false, false],
    ["installed", "notRequired", false, false],
    ["installed", "unknown", false, false],
    ["unknown", "unknown", false, false],
  ];
  for (const [installation, authentication, install, login] of states) {
    const marker = `fixture-${installation}-${authentication}`;
    snapshot.tools = [{ tool: "codex", installation, authentication, version: "codex-cli 0.156.1", message: marker }];
    publish();
    await waitFor(`document.body.innerText.includes(${JSON.stringify(marker)})`);
    const buttons = await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('main button')).map(button=>button.textContent.trim())");
    assert.equal(buttons.includes("安装 Codex"), install, marker);
    assert.equal(buttons.includes("登录 Codex"), login, marker);
  }
  snapshot.tools = [{ tool: "codex", installation: "missing", authentication: "unknown", version: null }];
  snapshot.jobs = [{ id: "fixture_install", type: "installCodex", phase: "running", message: "fixture-install-running" }];
  publish();
  await waitFor("document.body.innerText.includes('fixture-install-running')");
  assert.equal(await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('main button')).some(button=>button.textContent.trim()==='安装 Codex')"), false);
  snapshot.jobs = [];
  publish();
  await click("Agent");
  await click("添加 Agent");
  await waitFor("Boolean(document.querySelector('input[aria-label=\"完整注册链接\"]'))");
  await waitFor("Number(getComputedStyle(document.querySelector('[role=dialog]')).opacity) >= 0.999");
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('input[aria-label=\"完整注册链接\"]').value"), registrationUrl);
  await click("打开链接");
  await click("复制链接");
  assert.deepEqual(commands.filter(command => ["openJobAuthorization", "copyJobAuthorization"].includes(command.type)), [
    { type: "openJobAuthorization", jobId: job.id },
    { type: "copyJobAuthorization", jobId: job.id },
  ]);
  await writeFile(path.join(home, "registration-controls.png"), (await window.capturePage()).toPNG());
  snapshot.jobs = [{ ...job, expiresAt: Date.now() - 1 }];
  publish();
  await waitFor("document.body.innerText.includes('二维码和注册链接已过期')");
  assert.equal(await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).some(button=>['打开链接','复制链接'].includes(button.textContent.trim()))"), false);
  await writeFile(path.join(home, "controls.json"), JSON.stringify({ states, activeInstallHidden: true, registrationCommands: commands, expiredActionsHidden: true }, null, 2));
  process.stdout.write(`PASS native renderer tool states, active install, registration link/open/copy commands and expiry. Evidence: ${home}\n`);
  clearTimeout(timeout);
  app.quit();
}).catch(error => {
  process.stderr.write(`${error.stack}\n`);
  clearTimeout(timeout);
  app.exit(1);
});
