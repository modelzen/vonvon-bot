import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SERVICE_UNAVAILABLE } from '../src/host/service';

let buildDir: string;
let entry: string;
let storeEntry: string;
let interruptDriver: string;
const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
beforeAll(async () => {
  await mkdir(resolve('node_modules/.cache'), { recursive: true });
  buildDir = await mkdtemp(resolve('node_modules/.cache/vonvon-cli-'));
  entry = join(buildDir, 'cli.mjs');
  storeEntry = join(buildDir, 'store.cjs');
  interruptDriver = join(buildDir, 'interrupt.mjs');
  await writeFile(interruptDriver, "process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.trim()==='test:interrupt')process.emit('SIGINT')});process.stdin.resume();");
  await build({ entryPoints: [resolve('src/config/store.ts')], outfile: storeEntry, bundle: true, platform: 'node', format: 'cjs' });
  await build({ entryPoints: [resolve('src/cli/index.ts')], outfile: entry, bundle: true, packages: 'external', platform: 'node', format: 'esm' });
});
afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all([buildDir, ...dirs].map(dir => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'vonvon-cli-')); dirs.push(dir);
  const home = join(dir, 'home'); const root = join(dir, 'daemon');
  await mkdir(home); await mkdir(root);
  return { home, root };
}
function launch(home: string, root: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const prefix = process.platform === 'win32' && args[0] === 'daemon' && args[1] === 'run'
    ? ['--import', pathToFileURL(interruptDriver).href] : [];
  // HOME and XDG_CONFIG_HOME isolate the service registration lookup from the real user.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), VONVON_HOME: root, ...extraEnv };
  if (!extraEnv.VONVON_SERVICE) delete env.VONVON_SERVICE;
  const child = spawn(process.execPath, [...prefix, entry, ...args], { env, stdio: 'pipe' });
  children.push(child);
  let output = '';
  child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { child, exited, output: () => output };
}
it('exposes daemon lifecycle commands while status and logs leave a missing home untouched', async () => {
  const f = await fixture();
  for (const args of [['--help'], ['daemon', '--help']]) {
    const p = launch(f.home, f.root, args); expect(await p.exited).toBe(0);
    expect(p.output()).not.toMatch(/__daemon-control|__desktop-service|migrate|__restart/);
    if (args[0] === 'daemon') expect(p.output()).toMatch(/^ +restart +Restart the daemon/m);
    if (args[0] === '--help') for (const name of ['bot', 'group', 'settings']) expect(p.output()).toMatch(new RegExp(`^ +${name} +\\S`, 'm'));
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
  // The RPC commands take no data lease, so the empty root below also proves they skip it.
  for (const args of [['bot', 'list'], ['bot', 'status', '--bot', 'cli_a'], ['group', 'list', '--json'], ['settings', 'get']]) {
    const p = launch(f.home, f.root, args); expect(await p.exited).toBe(1);
    expect(p.output()).toContain('daemon 没有运行。先运行 vonvon daemon start。');
  }
  expect(await readdir(f.home)).toEqual([]); expect(await readdir(f.root)).toEqual([]);
});
it('starts without bots, refuses duplicate ownership and releases PID lease on shutdown', async () => {
  const f = await fixture();
  const p = launch(f.home, f.root, ['daemon', 'run']);
  await expect.poll(p.output, { timeout: 15_000 }).toContain('vonvon daemon ready');
  const record = z.object({ listen: z.string(), pid: z.number(), startedAt: z.string() }).parse(JSON.parse(await readFile(join(f.root, 'daemon.pid'), 'utf8')));
  expect(record.pid).toBe(p.child.pid); expect(record.listen).toMatch(/^127\.0\.0\.1:\d+$/);
  // The real connectLocal path: both must exit on their own once the socket is closed.
  const bots = launch(f.home, f.root, ['bot', 'list', '--json']);
  expect(await bots.exited, bots.output()).toBe(0); expect(bots.output()).toContain('{"bots":[]}');
  const groups = launch(f.home, f.root, ['group', 'list']);
  expect(await groups.exited, groups.output()).toBe(0); expect(groups.output()).toContain('还没有绑定的群');
  const second = launch(f.home, f.root, ['daemon', 'run']);
  expect(await second.exited).toBe(1); expect(second.output()).toMatch(/host is busy|already running/);
  expect((await readdir(f.home)).filter((entry) => entry !== '.codex')).toEqual([]);
  if (process.platform === 'win32') p.child.stdin.end('test:interrupt\n');
  else p.child.kill('SIGTERM');
  expect(await p.exited).toBe(0);
  await expect(readFile(join(f.root, 'daemon.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(join(f.root, '.access'))).toEqual([]);
});

it('service status gives an isolated data root service names of its own', async () => {
  const f = await fixture();
  const p = launch(f.home, f.root, ['service', 'status', '--json']);
  expect(await p.exited, p.output()).toBe(0);
  const line = p.output().split('\n').find(text => text.startsWith('{'));
  const status = z.object({ name: z.string(), servicePath: z.string(), installed: z.boolean() }).parse(JSON.parse(line ?? 'null'));
  expect(status.name).toMatch(/^(com\.vonvon\.bot\.daemon\.|vonvon-bot-)[0-9a-f]{12}(\.service)?$/);
  expect(status.servicePath.startsWith(f.home)).toBe(true);
  expect(status.installed).toBe(false);
});

it('concurrent detached starts return the same ready owner and stop clears its lease', async () => {
  const f = await fixture();
  const first = launch(f.home, f.root, ['daemon', 'start', '--port', '0']);
  const second = launch(f.home, f.root, ['daemon', 'start', '--port', '0']);
  const codes = await Promise.all([first.exited, second.exited]);
  // #296's CI saw both exit 1 once with nothing to go on: show both CLIs and the detached daemon's log.
  const log = await readFile(join(f.root, 'daemon.log'), 'utf8').catch(() => '(no daemon.log)');
  expect(codes, `first:\n${first.output()}\nsecond:\n${second.output()}\ndaemon.log:\n${log}`).toEqual([0, 0]);
  const record = z.object({ pid: z.number(), listen: z.string() }).parse(JSON.parse(await readFile(join(f.root, 'daemon.pid'), 'utf8')));
  expect(first.output()).toContain(`PID ${record.pid} at ${record.listen}`);
  expect(second.output()).toContain(`PID ${record.pid} at ${record.listen}`);
  const stopped = launch(f.home, f.root, ['daemon', 'stop']);
  expect(await stopped.exited).toBe(0);
  await expect(readFile(join(f.root, 'daemon.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 30_000);

it('daemon restart replaces a detached daemon on the same port, and a clean stop leaves no crash record (s17)', async () => {
  const f = await fixture();
  const start = launch(f.home, f.root, ['daemon', 'start', '--port', '0']);
  expect(await start.exited, start.output()).toBe(0);
  const before = z.object({ pid: z.number(), listen: z.string() }).parse(JSON.parse(await readFile(join(f.root, 'daemon.pid'), 'utf8')));
  expect(await readdir(join(f.root, 'crash'))).toEqual(['run.json']);
  const restart = launch(f.home, f.root, ['daemon', 'restart']);
  const log = async () => readFile(join(f.root, 'daemon.log'), 'utf8').catch(() => '(no daemon.log)');
  expect(await restart.exited, `${restart.output()}\ndaemon.log:\n${await log()}`).toBe(0);
  const status = launch(f.home, f.root, ['daemon', 'status', '--json']);
  expect(await status.exited).toBe(0);
  const after = z.object({ running: z.literal(true), pid: z.number(), listen: z.string(), crashes: z.array(z.unknown()) }).parse(JSON.parse(status.output()));
  expect(after.pid).not.toBe(before.pid);
  expect(after.listen).toBe(before.listen);
  expect(after.crashes).toEqual([]);
  expect(restart.output()).toBe(`running PID ${after.pid} at ${after.listen}\n`);
  const stop = launch(f.home, f.root, ['daemon', 'stop']);
  expect(await stop.exited, stop.output()).toBe(0);
  expect(await readdir(join(f.root, 'crash'))).toEqual([]);
  const stopped = launch(f.home, f.root, ['daemon', 'restart']);
  expect(await stopped.exited, stopped.output()).toBe(0);
  expect(stopped.output()).toContain('daemon 没在运行，已启动。');
  expect(await launch(f.home, f.root, ['daemon', 'stop']).exited).toBe(0);
}, 60_000);

it('open --print on a new host creates the data root, starts the daemon and keeps the credential out of a pipe', async () => {
  const f = await fixture();
  const root = join(f.root, 'not-yet');
  const p = launch(f.home, root, ['open', '--print']);
  const log = async () => readFile(join(root, 'daemon.log'), 'utf8').catch(() => '(no daemon.log)');
  expect(await p.exited, `${p.output()}\ndaemon.log:\n${await log()}`).toBe(0);
  const record = z.object({ listen: z.string() }).parse(JSON.parse(await readFile(join(root, 'daemon.pid'), 'utf8')));
  expect(p.output()).toContain(`http://${record.listen}/\n`);
  expect(p.output()).toContain('带凭据的链接没打印');
  expect(p.output()).not.toContain((await readFile(join(root, 'local-credential'), 'utf8')).trim());
  const stopped = launch(f.home, root, ['daemon', 'stop']);
  expect(await stopped.exited).toBe(0);
}, 30_000);

it('keeps generated secret getters on their captured root outside the parent shell', async () => {
  const f = await fixture();
  // run from a bot's session, `secrets set` would refuse (s23g)
  const setter = launch(f.home, f.root, ['secrets', 'set', '--raw', 'fixture'], { FEISHU_CODEX_BRIDGE: '', VONVON_SESSION: '' }); setter.child.stdin.end('dummy-only');
  expect(await setter.exited).toBe(0);
  const generator = spawn(process.execPath, ['-e', `process.argv[1]=${JSON.stringify(entry)};require(${JSON.stringify(storeEntry)}).buildEncryptedAccountConfig('fixture','feishu').then(config=>console.log(JSON.stringify(config.secrets.providers.bridge))).catch(e=>{console.error(e.message);process.exitCode=1})`], { env: { ...process.env, HOME: f.home, VONVON_HOME: f.root }, stdio: 'pipe' });
  children.push(generator);
  let providerOutput = ''; generator.stdout.on('data', data => { providerOutput += String(data); });
  expect(await new Promise<number | null>(resolve => generator.once('close', resolve))).toBe(0);
  const outside = await fixture();
  const provider = z.object({ command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()).optional() }).parse(JSON.parse(providerOutput));
  const getter = spawn(provider.command, provider.args, { env: { ...process.env, HOME: outside.home, VONVON_HOME: outside.root, ...provider.env }, stdio: 'pipe' });
  children.push(getter);
  let output = ''; getter.stdout.on('data', data => { output += String(data); });
  getter.stdin.end(JSON.stringify({ ids: ['fixture'] }));
  expect(await new Promise<number | null>(resolve => getter.once('close', resolve))).toBe(0);
  expect(JSON.parse(output)).toEqual({ values: { fixture: 'dummy-only' }, errors: {} });
  expect(await readdir(outside.root)).toEqual([]);
});

it('secrets set and remove refuse an unknown option without echoing it: a key may have been typed there (s23g)', async () => {
  const f = await fixture();
  const session = { FEISHU_CODEX_BRIDGE: '', VONVON_SESSION: '' };
  for (const args of [['set', 'typesafe-api-key', '--ts_TESTKEY0000'], ['set', '--ts_TESTKEY0000', 'typesafe-api-key'], ['remove', 'typesafe-api-key', '--ts_TESTKEY0000'], ['remove', 'typesafe-api-key', 'ts_TESTKEY0000']]) {
    const p = launch(f.home, f.root, ['secrets', ...args], session); p.child.stdin.end();
    expect(await p.exited, p.output()).toBe(2);
    expect(p.output()).not.toContain('TESTKEY');
  }
  const help = launch(f.home, f.root, ['secrets', 'remove', '--help'], session);
  expect(await help.exited).toBe(0);
  expect(help.output()).toContain('vonvon secrets list');
  for (const file of ['secrets.enc', 'master.key']) expect(await readdir(f.root)).not.toContain(file);
});

it('refuses a reused PID without signaling the unrelated process or changing its lock', async () => {
  const f = await fixture();
  const sleeper = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], { stdio: 'pipe' });
  children.push(sleeper);
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
  expect((await readdir(f.root)).filter(name => name !== '.access' && name !== '.locks')).toEqual(before);
  expect(await readdir(f.home)).toEqual([]);
}, 30_000);

it('replaces a dead daemon lock whose PID was reused without signaling the reusing process (#287)', async () => {
  const f = await fixture();
  const sleeper = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], { stdio: 'pipe' });
  children.push(sleeper);
  await new Promise<void>(resolve => sleeper.stdout.once('data', () => resolve()));
  await writeFile(join(f.root, 'daemon.pid'), JSON.stringify({ pid: sleeper.pid, startedAt: new Date().toISOString(), listen: '127.0.0.1:9' }));
  const start = launch(f.home, f.root, ['daemon', 'start', '--port', '0']);
  expect(await start.exited, start.output()).toBe(0);
  const record = z.object({ pid: z.number(), listen: z.string() }).parse(JSON.parse(await readFile(join(f.root, 'daemon.pid'), 'utf8')));
  expect(record.pid).not.toBe(sleeper.pid);
  expect(start.output()).toContain(`PID ${record.pid} at ${record.listen}`);
  const stop = launch(f.home, f.root, ['daemon', 'stop']);
  expect(await stop.exited, stop.output()).toBe(0);
  expect(sleeper.exitCode).toBeNull();
  expect(sleeper.signalCode).toBeNull();
  await expect(readFile(join(f.root, 'daemon.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 40_000);

it('service-managed run exits 0 without a daemon PID lease when no registration names this root', async () => {
  const f = await fixture();
  const run = launch(f.home, f.root, ['daemon', 'run', '--port', '0'], { VONVON_SERVICE: process.platform === 'darwin' ? 'launchd' : 'systemd' });
  expect(await run.exited, run.output()).toBe(0);
  expect(await readdir(f.root)).not.toContain('daemon.pid');
  expect(await readdir(join(f.root, '.access'))).toEqual([]);
});

it('service commands from a checkout and hidden controls leave an absent data home untouched', async () => {
  const f = await fixture();
  await rm(f.root, { recursive: true });
  for (const [args, code, text] of [
    [['service', 'install'], 1, 'install_refused: Distribution cannot install a service'],
    [['service', 'uninstall'], 0, 'not-installed: No data directory'],
    [['service', 'status'], 0, 'not installed'],
    [['__daemon-control', 'start'], 1, SERVICE_UNAVAILABLE], [['__daemon-control', 'stop'], 1, SERVICE_UNAVAILABLE],
    [['__daemon-control', 'restart'], 1, SERVICE_UNAVAILABLE], [['__daemon-control', 'update'], 1, SERVICE_UNAVAILABLE],
  ] as const) {
    const attempt = launch(f.home, f.root, [...args]);
    expect(await attempt.exited, attempt.output()).toBe(code);
    expect(attempt.output()).toContain(text);
    await expect(readdir(f.root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(f.home)).toEqual([]);
  }
});
