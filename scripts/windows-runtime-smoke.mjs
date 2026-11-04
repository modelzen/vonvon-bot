import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPackagedCodexFixture, verifyPackagedProvider } from './windows-provider-smoke.mjs';

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function boundedWait(promise, ms) {
  let timer;
  try { await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
  finally { clearTimeout(timer); }
}

export async function verifyWindowsPayloadPaths(appDirectory) {
  async function walk(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const file = join(directory, entry.name);
      // Reserve 100 characters for the user's installation location, with headroom below MAX_PATH.
      if (100 + relative(appDirectory, file).length >= 240) throw new Error(`Windows package path exceeds installation budget: ${relative(appDirectory, file)}`);
      if (entry.isSymbolicLink()) throw new Error('Windows package must not depend on symbolic links');
      if (entry.isDirectory()) await walk(file);
    }
  }
  await walk(appDirectory);
}

/** Start the packaged runtime, verify its authenticated status and served UI, then stop it. */
export async function verifyWindowsRuntime(appDirectory, { timeoutMs = 90000, retainedHome } = {}) {
  if (!isAbsolute(appDirectory)) throw new Error('Use an absolute packaged application directory');
  await verifyWindowsPayloadPaths(appDirectory);
  if (retainedHome && !isAbsolute(retainedHome)) throw new Error('Retained runtime home must be absolute');
  const home = retainedHome ?? await mkdtemp(join(tmpdir(), 'vonvon-packaged-smoke-'));
  const executable = join(appDirectory, 'Vonvon Bot.exe');
  const cli = join(appDirectory, 'resources/daemon/bin/vonvon.mjs');
  const fixture = await createPackagedCodexFixture(home, executable);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: home, USERPROFILE: home, VONVON_HOME: home, CODEX_BIN: fixture.bin, CODEX_HOME: fixture.directory };
  delete env.VONVON_SERVICE;
  let stderr = '', exit, spawnError;
  const child = spawn(executable, [cli, 'daemon', 'run', '--parent-control'], { env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  child.on('error', error => { spawnError = error; });
  child.stdin.on('error', () => {});
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8192); });
  const closed = new Promise(resolve => child.once('close', (code, signal) => { exit = { code, signal }; resolve(); }));
  let success = false;
  try {
    const deadline = Date.now() + timeoutMs;
    let ready;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (exit) throw new Error(`Packaged daemon exited before readiness (${exit.code ?? exit.signal}): ${stderr}`);
      let lock;
      try { lock = JSON.parse(await readFile(join(home, 'daemon.pid'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (lock && child.pid && lock.pid === child.pid && /^127\.0\.0\.1:\d+$/.test(lock.listen ?? '')) { ready = lock; break; }
      await pause(100);
    }
    if (!ready) throw new Error(`Packaged daemon readiness timed out: ${stderr}`);
    const { stdout } = await exec(executable, [cli, 'daemon', 'status', '--json'], { env, windowsHide: true, timeout: 10000, maxBuffer: 16384 });
    const status = JSON.parse(stdout);
    if (!status.running || status.pid !== child.pid || status.listen !== ready.listen) throw new Error('Packaged daemon authenticated status failed');
    // Exercise the public Console launcher as well as direct Electron, without registering a real user PATH.
    const launcher = join(appDirectory, 'resources/cli/vonvon.exe');
    const launched = JSON.parse((await exec(launcher, ['daemon', 'status', '--json'], { env, windowsHide: true, timeout: 15000, maxBuffer: 16384 })).stdout);
    if (!launched.running || launched.pid !== child.pid || launched.listen !== ready.listen) throw new Error('Packaged vonvon launcher authenticated status failed');
    const response = await fetch(`http://${ready.listen}/`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok || !(await response.text()).includes('<html')) throw new Error('Packaged daemon did not serve the built UI');
    const provider = await verifyPackagedProvider(ready.listen, home, fixture);
    child.stdin.end('shutdown\n');
    await boundedWait(closed, 10000);
    if (!exit || exit.code !== 0) throw new Error('Packaged daemon shutdown was not confirmed');
    success = true;
    return { runtimeStarted: true, authenticatedStatus: true, cliLauncher: true, builtUiServed: true, cleanShutdown: true, provider };
  } finally {
    if (!exit && child.pid) {
      if (!child.stdin.destroyed) child.stdin.end('shutdown\n');
      await boundedWait(closed, 5000);
      if (!exit) { child.kill(); await boundedWait(closed, 5000); }
    }
    // Remove only the scratch home created by this invocation, after its process exits.
    if (exit || spawnError) { if (!retainedHome) await rm(home, { recursive: true, force: true }); }
    else if (success) throw new Error('Packaged runtime exit was not confirmed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await verifyWindowsRuntime(process.argv[2], { retainedHome: process.argv[3] })));
}
