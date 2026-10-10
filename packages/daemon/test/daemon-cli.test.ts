import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';

let buildDir: string;
let entry: string;
let storeEntry: string;
const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
beforeAll(async () => {
  await mkdir(resolve('node_modules/.cache'), { recursive: true });
  buildDir = await mkdtemp(resolve('node_modules/.cache/vonvon-cli-'));
  entry = join(buildDir, 'cli.mjs');
  storeEntry = join(buildDir, 'store.cjs');
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
function launch(home: string, root: string, args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, VONVON_HOME: root }, stdio: 'pipe' });
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
});
it('starts without bots, refuses duplicate ownership and releases PID lease on shutdown', async () => {
  const f = await fixture();
  const p = launch(f.home, f.root, ['daemon', 'run']);
  await expect.poll(p.output, { timeout: 15_000 }).toContain('vonvon daemon ready');
  const record = z.object({ listen: z.string(), pid: z.number(), startedAt: z.string() }).parse(JSON.parse(await readFile(join(f.root, 'daemon.pid'), 'utf8')));
  expect(record.pid).toBe(p.child.pid); expect(record.listen).toMatch(/^127\.0\.0\.1:\d+$/);
  const second = launch(f.home, f.root, ['daemon', 'run']);
  expect(await second.exited).toBe(1); expect(second.output()).toMatch(/host is busy|already running/);
  expect((await readdir(f.home)).filter((entry) => entry !== '.codex')).toEqual([]);
  p.child.kill('SIGTERM'); expect(await p.exited).toBe(0);
  await expect(readFile(join(f.root, 'daemon.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(join(f.root, '.access'))).toEqual([]);
}, 20_000);

it('concurrent detached starts return the same ready owner and stop clears its lease', async () => {
  const f = await fixture();
  const first = launch(f.home, f.root, ['daemon', 'start', '--port', '0']);
  const second = launch(f.home, f.root, ['daemon', 'start', '--port', '0']);
  expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
  const record = z.object({ pid: z.number(), listen: z.string() }).parse(JSON.parse(await readFile(join(f.root, 'daemon.pid'), 'utf8')));
  expect(first.output()).toContain(`PID ${record.pid} at ${record.listen}`);
  expect(second.output()).toContain(`PID ${record.pid} at ${record.listen}`);
  const stopped = launch(f.home, f.root, ['daemon', 'stop']);
  expect(await stopped.exited).toBe(0);
  await expect(readFile(join(f.root, 'daemon.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 30_000);

it('keeps generated secret getters on their captured root outside the parent shell', async () => {
  const f = await fixture();
  const setter = launch(f.home, f.root, ['secrets', 'set', 'fixture']); setter.child.stdin.end('dummy-only');
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
});
