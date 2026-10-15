import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot, serviceTarget } from '../src/service/identity';

const bin = resolve(import.meta.dirname, '../bin/vonvon.mjs');
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function serviceFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-startup-cli-')));
  roots.push(root);
  const [home, data, config, temp] = ['home', 'data', 'config', 'tmp'].map(name => join(root, name)) as [string, string, string, string];
  for (const path of [home, data, config, temp]) mkdirSync(path);
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, VONVON_HOME: data, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: join(root, 'runtime'),
    TMPDIR: temp, NODE_OPTIONS: '', NODE_ENV: 'production', VITEST: '', VONVON_SERVICE: 'systemd',
  };
  return { root, home, data, config, env };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  await new Promise<void>(done => server.close(() => done()));
  if (!address || typeof address === 'string') throw new Error('Expected loopback port');
  return address.port;
}

function runManaged(fixture: ReturnType<typeof serviceFixture>, port: number, until?: () => boolean): Promise<{ code: number | null; stderr: string; stoppedByTest: boolean }> {
  const child = spawn(process.execPath, [bin, 'daemon', 'run', '--port', String(port)], { env: fixture.env, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let stderr = '';
  let stoppedByTest = false;
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const poll = setInterval(() => { if (until?.()) { stoppedByTest = true; child.kill('SIGTERM'); } }, 100);
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', code => { clearInterval(poll); clearTimeout(timer); done({ code, stderr, stoppedByTest }); });
  });
}

function startupLogs(data: string): Array<Record<string, unknown>> {
  const logs = join(data, 'logs');
  return readdirSync(logs).flatMap(name => readFileSync(join(logs, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>));
}

describe.skipIf(process.platform !== 'linux')('built CLI under systemd', () => {
  it('exits zero without a registration and flushes registration_absent to the daily log', async () => {
    const fixture = serviceFixture();
    const result = await runManaged(fixture, await freePort());
    expect(result.code, result.stderr).toBe(0);
    expect(startupLogs(fixture.data)).toContainEqual(expect.objectContaining({ phase: 'daemon-startup', event: 'registration_absent', kind: 'absent' }));
    expect(existsSync(join(fixture.data, 'daemon.pid'))).toBe(false);
  }, 30_000);

  it('takes over a lock whose PID was reused by an unrelated live process (#287)', async () => {
    const fixture = serviceFixture();
    const port = await freePort();
    const target = serviceTarget({ platform: 'linux', home: fixture.home, xdgConfigHome: fixture.config });
    if (target.platform !== 'linux') throw new Error('Expected systemd target');
    const rendered = renderDefinition({ target, root: await resolveServiceRoot(fixture.data), port, distribution: { kind: 'npm', executable: process.execPath, entry: bin }, capturedPath: '/usr/bin' });
    if (rendered.platform !== 'linux') throw new Error('Expected unit');
    mkdirSync(dirname(target.unitPath), { recursive: true });
    writeFileSync(target.unitPath, rendered.unit);
    const unrelated = spawn(process.execPath, ['-e', "for(const s of ['SIGTERM','SIGINT','SIGHUP','SIGUSR1','SIGUSR2'])process.on(s,()=>process.stdout.write(s));process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(unrelated);
    let signals = '';
    await new Promise<void>(done => unrelated.stdout?.on('data', (chunk: Buffer) => { signals += chunk.toString(); if (signals.startsWith('ready')) done(); }));
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const lockPath = join(fixture.data, 'daemon.pid');
    writeFileSync(lockPath, JSON.stringify({ pid: unrelated.pid, startedAt: new Date().toISOString(), listen: `127.0.0.1:${port}`, bootId }));
    let taken: { pid: number; listen: string | null } | undefined;
    const result = await runManaged(fixture, port, () => {
      try { const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; listen: string | null }; if (lock.pid !== unrelated.pid && lock.listen) taken = lock; }
      catch { /* rewritten or released */ }
      return taken !== undefined;
    });
    expect(result.stoppedByTest, result.stderr).toBe(true);
    expect(taken).toMatchObject({ listen: `127.0.0.1:${port}` });
    expect(startupLogs(fixture.data)).toContainEqual(expect.objectContaining({ phase: 'daemon-startup', event: 'stale_owner_replaced', pid: unrelated.pid }));
    expect(startupLogs(fixture.data)).not.toContainEqual(expect.objectContaining({ event: 'owner_present' }));
    expect(unrelated.exitCode).toBeNull(); expect(unrelated.signalCode).toBeNull();
    expect(() => process.kill(unrelated.pid ?? 0, 0)).not.toThrow();
    expect(signals).toBe('ready');
  }, 30_000);
});
