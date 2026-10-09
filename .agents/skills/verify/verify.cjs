#!/usr/bin/env node
'use strict';
const {spawn, execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..', '..', '..');
const auditRoot = path.join(repo, '.audit', 'verify');
const linux = process.platform === 'linux';
const LINUX_FLAGS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const SIDEBAR_BUTTONS = 'aside[aria-label="应用侧栏"] nav button';
const USAGE = `Usage:
  verify.cjs doctor
  verify.cjs capture [--click <sidebar name>] [--slug <slug>] [--timeout <seconds>]
  verify.cjs cleanup`;

if (process.versions.electron) driver();
else cli(process.argv.slice(2)).then(code => process.exit(code), error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
});

async function cli([command, ...args]) {
  if (command === 'doctor') return printChecks(doctor());
  if (command === 'capture') return capture(parseCaptureArgs(args));
  if (command === 'cleanup') return cleanup();
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

function parseCaptureArgs(args) {
  const options = {click: undefined, slug: undefined, timeoutSeconds: 60};
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value.\n${USAGE}`);
    if (flag === '--click') options.click = value;
    else if (flag === '--slug') options.slug = value;
    else if (flag === '--timeout') options.timeoutSeconds = Number(value);
    else throw new Error(`Unknown flag ${flag}.\n${USAGE}`);
  }
  options.slug ??= options.click ? options.click.replace(/[^\p{L}\p{N}]+/gu, '-') : 'launch';
  return options;
}

function doctor() {
  const main = path.join(repo, 'dist', 'main.cjs');
  const built = fs.existsSync(main) ? fs.statSync(main).mtimeMs : 0;
  const newest = newestFile(path.join(repo, 'desktop'));
  const checks = [{
    name: 'build',
    ok: built > newest.mtimeMs,
    detail: !built ? 'dist/main.cjs missing. Run npm run build.'
      : built > newest.mtimeMs ? 'dist/main.cjs is newer than every file under desktop/.'
      : `${path.relative(repo, newest.file)} changed after dist/main.cjs. Run npm run build.`,
  }];
  try {
    const binary = electronBinary();
    checks.push({name: 'electron', ok: fs.existsSync(binary), detail: binary});
  } catch (error) {
    checks.push({name: 'electron', ok: false, detail: `${error.message} See AGENTS.md, Linux host notes.`});
  }
  if (linux) {
    const xvfb = onPath('xvfb-run');
    checks.push({name: 'xvfb-run', ok: Boolean(xvfb), detail: xvfb ?? 'xvfb-run is not on PATH.'});
  }
  const runtime = path.join(repo, 'build', 'runtime', 'mac-arm64', 'core', 'dist', 'host.js');
  checks.push({
    name: 'runtime',
    ok: true,
    detail: process.platform === 'darwin' && fs.existsSync(runtime)
      ? 'Prepared runtime present. Expect a live Host.'
      : 'No prepared runtime for this platform. Expect "Bridge 尚未就绪 / 打包运行时不可用".',
  });
  return checks;
}

function printChecks(checks) {
  for (const check of checks) process.stdout.write(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}\n`);
  return checks.every(check => check.ok) ? 0 : 1;
}

async function capture({click, slug, timeoutSeconds}) {
  if (printChecks(doctor()) !== 0) return 1;
  const dir = path.join(auditRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug}`);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.codex'), {recursive: true});
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    VONVON_DESKTOP_TEST_HOME: home,
    VONVON_VERIFY_OUT: dir,
    VONVON_VERIFY_CLICK: click ?? '',
    VONVON_VERIFY_TIMEOUT_MS: String(timeoutSeconds * 1000),
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CODEX_BIN', 'CLAUDE_BIN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CHATGPT_AUTH_TOKEN']) delete env[key];
  const electron = electronBinary();
  const [file, args] = linux
    ? ['xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', electron, ...LINUX_FLAGS, __filename]]
    : [electron, [__filename]];
  const log = fs.openSync(path.join(dir, 'app.log'), 'w');
  const child = spawn(file, args, {cwd: repo, env, detached: true, stdio: ['ignore', log, log]});
  fs.writeFileSync(path.join(dir, 'pgid'), String(child.pid));
  const exit = await new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), (timeoutSeconds + 20) * 1000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve(signal ?? code); });
  });
  const survivors = await stopGroup(child.pid);
  if (!survivors.length) fs.rmSync(path.join(dir, 'pgid'));
  const resultFile = path.join(dir, 'result.json');
  const ok = exit === 0 && !survivors.length && fs.existsSync(resultFile);
  if (ok) fs.rmSync(home, {recursive: true, force: true});
  process.stdout.write(`${JSON.stringify({ok, exit, survivors, evidence: dir, files: fs.readdirSync(dir)}, null, 2)}\n`);
  if (!ok) process.stdout.write(`Read ${path.join(dir, 'app.log')}${fs.existsSync(path.join(dir, 'error.txt')) ? ` and ${path.join(dir, 'error.txt')}` : ''}.\n`);
  return ok ? 0 : 1;
}

async function cleanup() {
  if (!fs.existsSync(auditRoot)) return 0;
  let failed = 0;
  for (const run of fs.readdirSync(auditRoot)) {
    const marker = path.join(auditRoot, run, 'pgid');
    if (!fs.existsSync(marker)) continue;
    const pgid = Number(fs.readFileSync(marker, 'utf8'));
    const ours = groupMembers(pgid).some(member => member.command.includes(__filename));
    const survivors = ours ? await stopGroup(pgid) : [];
    if (survivors.length) failed++;
    else fs.rmSync(marker);
    process.stdout.write(`${run}: ${ours ? `stopped process group ${pgid}` : 'nothing running'}${survivors.length ? `, still running: ${JSON.stringify(survivors)}` : ''}\n`);
  }
  return failed ? 1 : 0;
}

async function stopGroup(pgid) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!groupMembers(pgid).length) return [];
    try { process.kill(-pgid, signal); } catch {}
    for (let index = 0; index < 50 && groupMembers(pgid).length; index++) await delay(100);
  }
  return groupMembers(pgid);
}

function groupMembers(pgid) {
  return execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat=,command='], {encoding: 'utf8'})
    .split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter(match => match && Number(match[2]) === pgid && !match[3].startsWith('Z'))
    .map(match => ({pid: Number(match[1]), command: match[4]}));
}

function electronBinary() {
  return require(path.join(repo, 'node_modules', 'electron'));
}

function onPath(command) {
  return (process.env.PATH ?? '').split(path.delimiter)
    .map(dir => path.join(dir, command))
    .find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
}

function newestFile(dir) {
  let newest = {file: dir, mtimeMs: 0};
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    const candidate = entry.isDirectory() ? newestFile(file) : {file, mtimeMs: fs.statSync(file).mtimeMs};
    if (candidate.mtimeMs > newest.mtimeMs) newest = candidate;
  }
  return newest;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function driver() {
  const {app, BrowserWindow} = require('electron');
  const out = process.env.VONVON_VERIFY_OUT;
  const click = process.env.VONVON_VERIFY_CLICK;
  if (linux) useTrayPngOnLinux();
  require(path.join(repo, 'dist', 'main.cjs'));
  let waitingFor = 'Electron to start';
  const deadline = setTimeout(() => fail(new Error(`Timed out waiting for ${waitingFor}.`)), Number(process.env.VONVON_VERIFY_TIMEOUT_MS));
  function fail(error) {
    fs.writeFileSync(path.join(out, 'error.txt'), `${error.stack ?? error}\n`);
    app.exit(1);
  }
  async function poll(read, label) {
    waitingFor = label;
    for (;;) {
      const value = await read();
      if (value) return value;
      await delay(100);
    }
  }
  async function settle(window) {
    let previous;
    let unchanged = 0;
    for (let index = 0; index < 30 && unchanged < 2; index++) {
      const text = await window.webContents.executeJavaScript('document.body.innerText');
      unchanged = text === previous ? unchanged + 1 : 0;
      previous = text;
      await delay(500);
    }
  }
  async function evidence(window, label) {
    const title = await window.webContents.executeJavaScript('document.querySelector("main")?.getAttribute("aria-label") ?? null');
    const text = await window.webContents.executeJavaScript('document.body.innerText');
    fs.writeFileSync(path.join(out, `${label}.txt`), text);
    fs.writeFileSync(path.join(out, `${label}.png`), (await window.capturePage()).toPNG());
    return {title, text: `${label}.txt`, screenshot: `${label}.png`};
  }
  async function clickSidebar(window, name) {
    const target = await window.webContents.executeJavaScript(`(() => {
      const buttons = [...document.querySelectorAll(${JSON.stringify(SIDEBAR_BUTTONS)})];
      const names = buttons.map(button => (button.getAttribute('aria-label') ?? button.textContent).trim());
      const index = names.indexOf(${JSON.stringify(name)});
      if (index < 0) return {names};
      const rect = buttons[index].getBoundingClientRect();
      return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)};
    })()`);
    if (target.names) throw new Error(`No sidebar item named ${name}. Available: ${target.names.join(', ')}`);
    window.webContents.sendInputEvent({type: 'mouseMove', x: target.x, y: target.y});
    window.webContents.sendInputEvent({type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1});
    window.webContents.sendInputEvent({type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1});
    await poll(() => window.webContents.executeJavaScript(`[...document.querySelectorAll(${JSON.stringify(SIDEBAR_BUTTONS)})]
      .some(button => button.getAttribute('aria-current') === 'page' && (button.getAttribute('aria-label') ?? button.textContent).trim() === ${JSON.stringify(name)})`), `${name} to become the current page`);
  }
  app.whenReady().then(async () => {
    const window = await poll(() => BrowserWindow.getAllWindows()[0], 'the main window');
    await poll(() => !window.webContents.isLoading(), 'the renderer to load');
    const snapshot = await poll(() => window.webContents.executeJavaScript(
      'new Promise(resolve => { let stop; stop = window.bridge.watch(value => { resolve(value); queueMicrotask(() => stop?.()); }); })',
    ).then(value => value && value.host.kind !== 'starting' && value), 'the Host to leave starting');
    await settle(window);
    const before = await evidence(window, 'before');
    let after;
    if (click) {
      await clickSidebar(window, click);
      await settle(window);
      after = await evidence(window, 'after');
    }
    fs.writeFileSync(path.join(out, 'result.json'), `${JSON.stringify({
      platform: `${process.platform}-${process.arch}`,
      trayIconSwapped: linux,
      host: snapshot.host,
      agents: snapshot.agents.length,
      click: click || null,
      before,
      after: after ?? null,
    }, null, 2)}\n`);
    clearTimeout(deadline);
    setTimeout(() => fail(new Error('Graceful quit did not finish.')), 20_000).unref();
    app.quit();
  }).catch(fail);
}

function useTrayPngOnLinux() {
  const Module = require('node:module');
  const electron = require('electron');
  class Tray extends electron.Tray {
    constructor(image, ...rest) {
      super(typeof image === 'string' ? image.replace(/\.ico$/, '.png') : image, ...rest);
    }
  }
  const patched = new Proxy(electron, {get: (target, key) => (key === 'Tray' ? Tray : target[key])});
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? patched : load.call(this, request, ...rest);
  };
}
