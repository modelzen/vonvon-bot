import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getPidLockInfo, isPidLockOwnerRunning } from '../src/server/pid-lock';

let buildDir: string;
let entry: string;
let storeEntry: string;
let interruptDriver: string;
const dirs: string[] = [];
const children: { child: ChildProcessWithoutNullStreams; closed: Promise<number | null> }[] = [];
const retainedDirs = new Set<string>();
function trackChild(child: ChildProcessWithoutNullStreams) {
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  children.push({ child, closed });
  return closed;
}
async function waitForClose(closed: Promise<number | null>, timeout: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed,
      new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function closeChild({ child, closed }: typeof children[number]) {
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  } catch { /* Closure still needs proof if signaling fails. */ }
  return await waitForClose(closed, 1000) !== 'timeout';
}
beforeAll(async () => {
  await mkdir(resolve('node_modules/.cache'), { recursive: true });
  buildDir = await mkdtemp(resolve('node_modules/.cache/vonvon-cli-'));
  entry = join(buildDir, 'cli.mjs');
  storeEntry = join(buildDir, 'store.cjs');
  interruptDriver = join(buildDir, 'interrupt.mjs');
  await writeFile(interruptDriver, "process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.trim()==='test:interrupt')process.emit('SIGINT')});process.stdin.resume();");
  await build({ entryPoints: [resolve('src/config/store.ts')], outfile: storeEntry, bundle: true, platform: 'node', format: 'cjs' });
  let startupFixtureLoaded = false;
  await build({
    entryPoints: [resolve('src/cli/index.ts')], outfile: entry, bundle: true, packages: 'external', platform: 'node', format: 'esm',
    plugins: [{
      name: 'unregistered-windows-user',
      setup(plugin) {
        // These fixtures model an unregistered user; USERPROFILE does not isolate HKCU.
        plugin.onLoad({ filter: /[\\/]src[\\/]service[\\/]win-startup\.ts$/ }, () => {
          startupFixtureLoaded = true;
          return {
            contents: "export function readVonvonRunValue() { return { kind: 'absent' }; }",
            loader: 'js',
          };
        });
      },
    }],
  });
  expect(startupFixtureLoaded).toBe(true);
});
afterAll(async () => {
  const closed = await Promise.all(children.map(closeChild));
  if (closed.includes(false)) {
    throw new Error('Fixture cleanup failed: child closure unconfirmed; all fixture and build directories retained');
  }
  await Promise.all([...(retainedDirs.size ? [] : [buildDir]), ...dirs.filter(dir => !retainedDirs.has(dir))]
    .map(dir => rm(dir, { recursive: true, force: true }))).catch(() => {
      throw new Error('Fixture directory removal failed');
    });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'vonvon-cli-')); dirs.push(dir);
  const home = join(dir, 'home'); const root = join(dir, 'daemon');
  await mkdir(home); await mkdir(root);
  return { dir, home, root };
}
function launch(home: string, root: string, args: string[]) {
  const prefix = process.platform === 'win32' && args[0] === 'daemon' && args[1] === 'run'
    ? ['--import', pathToFileURL(interruptDriver).href] : [];
  const child = spawn(process.execPath, [...prefix, entry, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, VONVON_HOME: root }, stdio: 'pipe' });
  const exited = trackChild(child);
  let output = ''; let stdoutBytes = 0; let stderrBytes = 0; let spawnFailed = false;
  child.stdout.on('data', data => { stdoutBytes += Buffer.byteLength(data); output = (output + String(data)).slice(-16384); });
  child.stderr.on('data', data => { stderrBytes += Buffer.byteLength(data); output = (output + String(data)).slice(-16384); });
  child.on('error', () => { spawnFailed = true; });
  return { child, exited, output: () => output,
    close: () => closeChild({ child, closed: exited }),
    diagnostics: () => ({ code: child.exitCode, signal: child.signalCode, stdoutBytes, stderrBytes, spawnFailed }) };
}
async function fixtureDiagnostics(root: string) {
  const daemonLogBytes = await stat(join(root, 'daemon.log')).then(file => file.size, () => null);
  try {
    const lock = await getPidLockInfo(root);
    return { daemonLogBytes, lock: lock && {
      pid: lock.pid,
      startedAtMs: Date.parse(lock.startedAt),
      listenPort: lock.listen && /^127\.0\.0\.1:\d{1,5}$/.test(lock.listen) ? Number(lock.listen.split(':')[1]) : null,
    } };
  } catch { return { daemonLogBytes, lock: 'unreadable or invalid lock' }; }
}

it('exposes daemon lifecycle commands while status and logs leave a missing home untouched', async () => {
  const f = await fixture();
  for (const args of [['--help'], ['daemon', '--help']]) {
    const p = launch(f.home, f.root, args); expect(await p.exited).toBe(0);
    expect(p.output()).not.toMatch(/__daemon-control|__desktop-service|migrate|restart/);
  }
  const service = launch(f.home, f.root, ['service', '--help']);
  expect(await service.exited).toBe(0);
  expect(service.output()).toContain('install');
  expect(service.output()).toContain('uninstall');
  for (const args of [['start'], ['run'], ['__daemon-control', 'stop'], ['data', 'migrate']]) {
    const p = launch(f.home, f.root, args); expect(await p.exited).toBe(1);
  }
  for (const args of [['daemon', 'status', '--json'], ['daemon', 'logs']]) {
    const p = launch(f.home, f.root, args); expect(await p.exited).toBe(0);
  }
  expect(await readdir(f.home)).toEqual([]); expect(await readdir(f.root)).toEqual([]);
}, 20_000);
it('starts without bots, refuses duplicate ownership and releases PID lease on shutdown', async () => {
  const f = await fixture();
  const p = launch(f.home, f.root, ['daemon', 'run']);
  await expect.poll(p.output, { timeout: 15_000 }).toContain('vonvon daemon ready');
  const record = z.object({ listen: z.string(), pid: z.number(), startedAt: z.string() }).parse(JSON.parse(await readFile(join(f.root, 'daemon.pid'), 'utf8')));
  expect(record.pid).toBe(p.child.pid); expect(record.listen).toMatch(/^127\.0\.0\.1:\d+$/);
  const second = launch(f.home, f.root, ['daemon', 'run']);
  expect(await second.exited).toBe(1); expect(second.output()).toMatch(/host is busy|already running/);
  expect((await readdir(f.home)).filter((entry) => entry !== '.codex')).toEqual([]);
  if (process.platform === 'win32') p.child.stdin.end('test:interrupt\n');
  else p.child.kill('SIGTERM');
  expect(await p.exited).toBe(0);
  await expect(readFile(join(f.root, 'daemon.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(join(f.root, '.access'))).toEqual([]);
}, 20_000);

it('concurrent detached starts return the same ready owner and stop clears its lease', async () => {
  const f = await fixture().catch(() => { throw new Error('Concurrent fixture creation failed'); });
  const attempts: ReturnType<typeof launch>[] = [];
  retainedDirs.add(f.dir);
  const startedAt = Date.now();
  let stage = 'start CLI launch';
  let failed = false;
  let owner: Awaited<ReturnType<typeof getPidLockInfo>> = null;
  try {
    const first = launch(f.home, f.root, ['daemon', 'start', '--port', '0']);
    attempts.push(first);
    const second = launch(f.home, f.root, ['daemon', 'start', '--port', '0']);
    attempts.push(second);
    stage = 'start CLI closure';
    // Reserve 7 seconds for child closure and authenticated owner cleanup within the 30 second test.
    expect(await Promise.all(attempts.map(attempt => waitForClose(attempt.exited, 10_000)))).toEqual([0, 0]);
    stage = 'ready owner';
    owner = await getPidLockInfo(f.root);
    if (!owner || !owner.listen) throw new Error('Ready owner unavailable');
    expect(first.output().includes(`PID ${owner.pid} at ${owner.listen}`)).toBe(true);
    expect(second.output().includes(`PID ${owner.pid} at ${owner.listen}`)).toBe(true);
    stage = 'normal stop CLI launch';
    const stopped = launch(f.home, f.root, ['daemon', 'stop']);
    attempts.push(stopped);
    stage = 'normal stop CLI closure';
    expect(await waitForClose(stopped.exited, 5000)).toBe(0);
    stage = 'lease absence';
    const lease = await readFile(join(f.root, 'daemon.pid')).then(
      () => 'present',
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'absent' : 'unreadable',
    );
    expect(lease).toBe('absent');
  } catch {
    failed = true;
    console.error('Detached start failure diagnostics', JSON.stringify({
      stage, elapsedMs: Date.now() - startedAt,
      cli: attempts.map(attempt => attempt.diagnostics()), ...await fixtureDiagnostics(f.root),
    }));
    // Never forward an arbitrary error or its cause to Vitest's formatter.
    throw new Error(`Detached start failed during ${stage}`);
  } finally {
    let cleanupStage = 'start CLI closure';
    try {
      const cliClosed = !(await Promise.all(attempts.map(attempt => attempt.close()))).includes(false);
      cleanupStage = 'owner lock read';
      const current = await getPidLockInfo(f.root);
      if (current) {
        owner = current;
        // The CLI authenticates this fixture owner and waits for its exit and lease removal.
        cleanupStage = 'authenticated owner stop';
        const cleanup = launch(f.home, f.root, ['daemon', 'stop']);
        attempts.push(cleanup);
        try {
          const code = await waitForClose(cleanup.exited, 5000);
          if (code !== 0) throw new Error('Fixture stop failed or timed out');
        } finally {
          if (!await cleanup.close()) {
            cleanupStage = 'stop CLI closure';
            throw new Error('Fixture stop CLI closure unconfirmed');
          }
        }
      }
      cleanupStage = 'owner closure verification';
      if (!owner || isPidLockOwnerRunning(owner) || await getPidLockInfo(f.root)) {
        throw new Error('Fixture owner closure is unconfirmed');
      }
      cleanupStage = 'start CLI closure';
      if (!cliClosed) throw new Error('Fixture start CLI closure unconfirmed');
      retainedDirs.delete(f.dir);
    } catch {
      console.error('Fixture cleanup failed; fixture and build retained', cleanupStage,
        JSON.stringify({ elapsedMs: Date.now() - startedAt,
          cli: attempts.map(attempt => attempt.diagnostics()), ...await fixtureDiagnostics(f.root) }));
      if (!failed) throw new Error(`Fixture cleanup failed during ${cleanupStage}; fixture and build retained`);
    }
  }
}, 30_000);

it('keeps generated secret getters on their captured root outside the parent shell', async () => {
  const f = await fixture();
  const setter = launch(f.home, f.root, ['secrets', 'set', 'fixture']); setter.child.stdin.end('dummy-only');
  expect(await setter.exited).toBe(0);
  const generator = spawn(process.execPath, ['-e', `process.argv[1]=${JSON.stringify(entry)};require(${JSON.stringify(storeEntry)}).buildEncryptedAccountConfig('fixture','feishu').then(config=>console.log(JSON.stringify(config.secrets.providers.bridge))).catch(e=>{console.error(e.message);process.exitCode=1})`], { env: { ...process.env, HOME: f.home, VONVON_HOME: f.root }, stdio: 'pipe' });
  trackChild(generator);
  let providerOutput = ''; generator.stdout.on('data', data => { providerOutput += String(data); });
  expect(await new Promise<number | null>(resolve => generator.once('close', resolve))).toBe(0);
  const outside = await fixture();
  const provider = z.object({ command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()).optional() }).parse(JSON.parse(providerOutput));
  const getter = spawn(provider.command, provider.args, { env: { ...process.env, HOME: outside.home, VONVON_HOME: outside.root, ...provider.env }, stdio: 'pipe' });
  trackChild(getter);
  let output = ''; getter.stdout.on('data', data => { output += String(data); });
  getter.stdin.end(JSON.stringify({ ids: ['fixture'] }));
  expect(await new Promise<number | null>(resolve => getter.once('close', resolve))).toBe(0);
  expect(JSON.parse(output)).toEqual({ values: { fixture: 'dummy-only' }, errors: {} });
  expect(await readdir(outside.root)).toEqual([]);
});

it('refuses a reused PID without signaling the unrelated process or changing its lock', async () => {
  const f = await fixture();
  const sleeper = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], { stdio: 'pipe' });
  trackChild(sleeper);
  await new Promise<void>(resolve => sleeper.stdout.once('data', () => resolve()));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const lock = JSON.stringify({ pid: sleeper.pid, startedAt: new Date().toISOString(), listen: `127.0.0.1:${address.port}` });
  await writeFile(join(f.root, 'daemon.pid'), lock);
  await writeFile(join(f.root, 'local-credential'), 'aa'.repeat(32));
  const before = await readdir(f.root);
  const status = launch(f.home, f.root, ['daemon', 'status', '--json']);
  const statusExit = await status.exited;
  expect(await readdir(f.root)).toEqual(before);
  const stop = launch(f.home, f.root, ['daemon', 'stop']);
  expect(await stop.exited).toBe(1);
  expect(sleeper.exitCode).toBeNull();
  expect(sleeper.signalCode).toBeNull();
  expect(statusExit).toBe(1);
  expect(status.output()).toContain('Cannot verify daemon owner');
  expect(stop.output()).toContain('Cannot verify daemon owner');
  expect(await readFile(join(f.root, 'daemon.pid'), 'utf8')).toBe(lock);
  expect((await readdir(f.root)).filter(name => name !== '.access')).toEqual(before);
  expect(await readdir(f.home)).toEqual([]);
}, 30_000);

it('service refusal leaves an absent data home untouched for public and hidden commands', async () => {
  const f = await fixture();
  await rm(f.root, { recursive: true });
  const refusal = 'Vonvon Bot cannot manage an OS service in this version. Use vonvon daemon start and vonvon daemon stop.';
  for (const args of [
    ['service', 'install'], ['service', 'uninstall'],
    ['__daemon-control', 'start'], ['__daemon-control', 'stop'],
    ['__daemon-control', 'restart'], ['__daemon-control', 'update'],
  ]) {
    const attempt = launch(f.home, f.root, args);
    expect(await attempt.exited).toBe(1);
    expect(attempt.output()).toContain(refusal);
    await expect(readdir(f.root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(f.home)).toEqual([]);
  }
}, process.platform === 'win32' ? 20_000 : 5_000);
