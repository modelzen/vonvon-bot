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
let installation = "missing", authentication = "unknown", marker = "initial";
const commands = [];
let installOperation = null, finishInstall;
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
  ipcMain.handle("bridge:machine", (_event,request) => {assert.equal(request.type,"logs");return {type:"logs",text:"fixture logs"};});
  ipcMain.handle('bridge:environment', (_event, request) => {
    if (request.type === 'toolInstallStatus') return {kind:'toolInstall',operation:installOperation};
    if (request.type === 'install') {installOperation={kind:'running',id:'00000000-0000-4000-8000-000000000001',tool:'codex',update:false,startedAt:Date.now()};return new Promise(resolve=>{finishInstall=resolve;});}
    if (request.type === 'cancelInstall') {assert.equal(request.operationId,installOperation.id);installOperation={kind:'cancelled',id:installOperation.id,message:'安装已取消，旧版本保留。'};finishInstall({kind:'refused',code:'cancelled',message:installOperation.message});return {kind:'toolInstall',operation:installOperation};}
    if (request.type === 'scan') return {kind: 'tools', tools: [{tool:'codex',installation:installation==='missing'?'missing':'external',executable:installation==='missing'?null:'/fixture/codex',version:marker,managedVersion:null,latestVersion:null,updateAvailable:null,canUninstall:false}]};
    if (request.type === 'authStatus') return {kind:'auth',tool:'codex',state:authentication==='notRequired'?'signedIn':authentication,message:`auth-${marker}`};
    if (request.type === 'profileList') return {kind:'profiles',profiles:[]};
    if (request.type === 'backendCatalog') return {kind:'backends',entries:[]};
    return {kind:'operation',operation:null};
  });
  ipcMain.handle("bridge:run", (_event, command) => {
    commands.push(command);
    let result = { kind: "applied", revision: snapshot.revision };
    if (command.type === 'startCodexLogin') {
      snapshot.jobs = [{id:'fixture_codex_login',type:'loginCodex',phase:'authorizing',userCode:'CODE-1234'}];publish();
      result={kind:'started',jobId:'fixture_codex_login'};
    }
    if (command.type === 'cancelJob') {snapshot.jobs=[];publish();}
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
  await waitFor("document.querySelector('.environment-brand img')?.complete && document.querySelector('.environment-brand img')?.naturalWidth > 0");
  const states = [
    ["missing", "unknown", true, false],
    ["installed", "signedOut", false, true],
    ["installed", "signedIn", false, false],
    ["installed", "notRequired", false, false],
    ["installed", "unknown", false, false],
    ["unknown", "unknown", false, false],
  ];
  for (const [nextInstallation, nextAuthentication, install, login] of states) {
    installation=nextInstallation;authentication=nextAuthentication;marker=`fixture-${installation}-${authentication}`;
    await click('重新检测');
    await waitFor(`document.querySelector('[aria-label="Codex CLI 本机环境"]')?.textContent.includes(${JSON.stringify(install?'未安装':marker)})`);
    if (login) await waitFor("document.querySelector('[aria-label=\"Codex CLI 本机环境\"]')?.textContent.includes('需要授权')");
    const buttons = await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('[aria-label=\"Codex CLI 本机环境\"] button')).map(button=>button.textContent.trim())");
    assert.equal(buttons.includes('安装'), install, marker);
    assert.equal(buttons.includes('登录'), login, marker);
    if (nextAuthentication === 'unknown' && !install) assert.ok(await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"Codex CLI 本机环境\"]')?.textContent.includes('授权未确认')"));
  }
  installation='installed';authentication='signedOut';marker='device-auth';
  await click('重新检测');await waitFor("document.querySelector('[aria-label=\"Codex CLI 本机环境\"]')?.textContent.includes('需要授权')");
  await click('登录');await waitFor("document.querySelector('.desktop-device-code')?.textContent==='CODE-1234'");
  await click('打开官方授权页面');
  assert.ok(commands.some(command=>command.type==='openJobAuthorization'&&command.jobId==='fixture_codex_login'));
  await click('取消本次操作');
  assert.ok(commands.some(command=>command.type==='cancelJob'&&command.jobId==='fixture_codex_login'));
  installation='missing';authentication='unknown';marker='active-install';
  await click('重新检测');await waitFor("document.querySelector('[aria-label=\"Codex CLI 本机环境\"]')?.textContent.includes('未安装')");
  snapshot.jobs = [{ id: "fixture_install", type: "installCodex", phase: "running", message: "fixture-install-running" }];
  publish();
  await waitFor("document.body.innerText.includes('fixture-install-running')");
  assert.equal(await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('main button')).find(button=>button.textContent.trim()==='安装')?.disabled"), true);
  snapshot.jobs = [];
  publish();
  await waitFor("![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='安装')?.disabled");
  await click('安装');
  await waitFor("document.querySelector('[role=dialog]')?.textContent.includes('开始安装')");
  assert.equal(installOperation, null, 'confirmation must not start installation');
  await click('开始安装');await waitFor("document.body.innerText.includes('取消任务')");
  await click('取消任务');await waitFor("document.body.innerText.includes('安装已取消，旧版本保留。')");
  assert.equal(installOperation.kind,'cancelled');
  await click('完成');
  await click('安装');await click('开始安装');await waitFor("document.body.innerText.includes('后台继续')");
  await click('后台继续');await waitFor("document.body.innerText.includes('返回进度')");
  await click('Bot');await click('本机环境');await waitFor("document.body.innerText.includes('取消任务')");
  installation='installed';authentication='signedOut';marker='installed-after-navigation';
  installOperation={kind:'succeeded',id:installOperation.id,message:'工具已安装。'};
  finishInstall({kind:'applied',message:'工具已安装。'});
  await waitFor("document.body.innerText.includes('installed-after-navigation')");
  assert.equal(await window.webContents.executeJavaScript("[...document.querySelectorAll('main button')].some(b=>b.textContent.trim()==='安装')"),false);
  await click('完成');
  snapshot.diagnostics=[{title:'飞书事件订阅',status:'error',message:'缺少必需事件',eventConfigUrl:'https://open.larksuite.com/app/cli_fixture/event'}];publish();
  await click('状态与诊断');await click('打开事件设置');
  assert.ok(commands.some(c=>c.type==='openEventSettings'&&c.url==='https://open.larksuite.com/app/cli_fixture/event'));
  await click("Bot");
  await click("添加 Bot");
  await waitFor("Boolean(document.querySelector('input[aria-label=\"完整注册链接\"]'))");
  await waitFor("Number(getComputedStyle(document.querySelector('[role=dialog]')).opacity) >= 0.999");
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('input[aria-label=\"完整注册链接\"]').value"), registrationUrl);
  await click("打开链接");
  await click("复制链接");
  assert.deepEqual(commands.filter(command => command.jobId === job.id && ["openJobAuthorization", "copyJobAuthorization"].includes(command.type)), [
    { type: "openJobAuthorization", jobId: job.id },
    { type: "copyJobAuthorization", jobId: job.id },
  ]);
  snapshot.jobs = [{ ...job, expiresAt: Date.now() - 1 }];
  publish();
  await waitFor("document.body.innerText.includes('二维码和注册链接已过期')");
  assert.equal(await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).some(button=>['打开链接','复制链接'].includes(button.textContent.trim()))"), false);
  await writeFile(path.join(home, "controls.json"), JSON.stringify({ states, activeInstallDisabled: true, stagedInstallCancellation: true, installCompletionAfterNavigation: true, tenantEventLink: true, deviceCodeVisible: true, loginCancellation: true, registrationCommands: commands, expiredActionsHidden: true }, null, 2));
  process.stdout.write(`PASS native renderer tool states, active install, registration link/open/copy commands and expiry. Evidence: ${home}\n`);
  clearTimeout(timeout);
  app.quit();
}).catch(error => {
  process.stderr.write(`${error.stack}\n`);
  clearTimeout(timeout);
  app.exit(1);
});
