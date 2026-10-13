import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { acquireMutex, closeMutex } from '../src/config/data-access';
import { renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot, serviceTarget } from '../src/service/identity';

vi.mock('../src/service/identity', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/service/identity')>();
  return { ...actual, resolveServiceRoot: (path: string) => path === '/fixture/root' ? Promise.resolve(path) : actual.resolveServiceRoot(path) };
});

const bin = resolve(import.meta.dirname, '../bin/vonvon.mjs');

function serviceFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-prelock-cli-')));
  const home = join(root, 'home');
  const data = join(root, 'data');
  const xdgConfigHome = join(root, 'config');
  const xdgRuntimeDir = join(root, 'runtime');
  const xdgCacheHome = join(root, 'cache');
  const xdgDataHome = join(root, 'xdg-data');
  const xdgStateHome = join(root, 'state');
  const temp = join(root, 'tmp');
  for (const path of [home, data, xdgConfigHome, xdgRuntimeDir, xdgCacheHome, xdgDataHome, xdgStateHome, temp]) mkdirSync(path);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    VONVON_HOME: data,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_RUNTIME_DIR: xdgRuntimeDir,
    XDG_CACHE_HOME: xdgCacheHome,
    XDG_DATA_HOME: xdgDataHome,
    XDG_STATE_HOME: xdgStateHome,
    TMPDIR: temp,
    NODE_OPTIONS: '',
    NODE_ENV: 'production',
    VITEST: '',
    VONVON_SERVICE: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'launchd' : 'systemd',
  };
  return { root, data, home, xdgConfigHome, env };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Expected loopback port');
  return address.port;
}

async function runManagedCli(fixture: ReturnType<typeof serviceFixture>, port: number): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
  const child = spawn(process.execPath, [bin, 'daemon', 'run', '--port', String(port)], {
    env: fixture.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  let timedOut = false;
  const killGroup = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') { child.kill('SIGKILL'); return; }
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
    child.stderr.destroy();
  }, 10_000);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve({ code, stderr, timedOut }));
    });
  } finally {
    clearTimeout(timer);
  }
}

function startupLogs(data: string): unknown[] {
  const logs = join(data, 'logs');
  return readdirSync(logs).flatMap(name => readFileSync(join(logs, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

function assertPackagedCommand(args: string[], port?: number): void {
  expect(args).toEqual([process.execPath, bin, 'daemon', 'run', ...(port ? ['--port', String(port)] : [])]);
  expect(existsSync(bin)).toBe(true);
  const result = spawnSync(args[0]!, [...args.slice(1), '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Run in the foreground');
  expect(result.stdout).toContain('--port <port>');
}

describe('OS service foreground entry', () => {
  it('launchd calls the packaged daemon command', async () => {
    const root = await resolveServiceRoot('/fixture/root');
    const rendered = renderDefinition({ target: { platform: 'darwin', plistPath: '/unused.plist' }, root, port: 32123, distribution: { kind: 'npm', executable: '/fixture/bin/node', entry: '/fixture/bin/vonvon.mjs' }, capturedPath: '/usr/bin' });
    if (rendered.platform !== 'darwin') throw new Error('Expected plist');
    const plist = Buffer.from(rendered.plist).toString();
    const argumentsXml = plist.match(/<key>ProgramArguments<\/key>\s*<array>(.*?)<\/array>/s)?.[1];
    expect(argumentsXml).toBeDefined();
    const args = [...argumentsXml!.matchAll(/<string>(.*?)<\/string>/g)].map((match) => match[1]!);
    expect(args).toEqual(['/fixture/bin/node', '/fixture/bin/vonvon.mjs', 'daemon', 'run', '--port', '32123']);
    assertPackagedCommand([process.execPath, bin, ...args.slice(2)], 32123);
  });

  it('systemd calls the packaged daemon command', async () => {
    const root = await resolveServiceRoot('/fixture/root');
    const rendered = renderDefinition({ target: { platform: 'linux', unitPath: '/unused.service' }, root, port: 32123,
      distribution: { kind: 'npm', executable: '/fixture/bin/node', entry: '/fixture/bin/vonvon.mjs' }, capturedPath: '/usr/bin' });
    if (rendered.platform !== 'linux') throw new Error('Expected unit');
    const line = Buffer.from(rendered.unit).toString().match(/^ExecStart=(.*)$/m)?.[1];
    expect(line).toBeDefined();
    const args = [...line!.matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g)].map(match =>
      match[1]?.replace(/\\([\\"])/g, '$1').replace(/%%/g, '%').replace(/\$\$/g, '$') ?? match[2]!,
    );
    expect(args).toEqual(['/fixture/bin/node', '/fixture/bin/vonvon.mjs', 'daemon', 'run', '--port', '32123']);
    assertPackagedCommand([process.execPath, bin, ...args.slice(2)], 32123);
  });


});

describe.skipIf(!['darwin', 'linux', 'win32'].includes(process.platform))('built CLI Pre-lock guard', () => {
  it('exits before a host mutex or PID lock when registration is absent', async () => {
    const fixture = serviceFixture();
    try {
      const hostMutex = await acquireMutex(fixture.data, 'host');
      try {
        const result = await runManagedCli(fixture, await freePort());
        expect(result.timedOut, result.stderr).toBe(false);
        expect(result.code, result.stderr).toBe(0);
        expect(startupLogs(fixture.data)).toContainEqual(expect.objectContaining({
          phase: 'daemon-startup', event: 'registration_absent',
        }));
        expect(existsSync(join(fixture.data, 'daemon.pid'))).toBe(false);
        expect(readdirSync(fixture.data).sort()).toEqual(['.access', 'logs']);
      } finally { await closeMutex(hostMutex); }
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }, 15_000);

  it.skipIf(process.platform === 'win32')('keeps a live owner PID lock byte-for-byte unchanged', async () => {
    const fixture = serviceFixture();
    try {
      const root = await resolveServiceRoot(fixture.data);
      const port = await freePort();
      const target = process.platform === 'darwin'
        ? serviceTarget({ platform: 'darwin', home: fixture.home })
        : serviceTarget({ platform: 'linux', home: fixture.home, xdgConfigHome: fixture.xdgConfigHome });
      const rendered = renderDefinition({ target, root, port,
        distribution: { kind: 'npm', executable: process.execPath, entry: bin }, capturedPath: '/usr/bin' });
      if (target.platform === 'win32') throw new Error('Expected host service target');
      if (rendered.platform === 'win32') throw new Error('Expected host service definition');
      const definitionPath = target.platform === 'darwin' ? target.plistPath : target.unitPath;
      mkdirSync(resolve(definitionPath, '..'), { recursive: true });
      writeFileSync(definitionPath, rendered.platform === 'darwin' ? rendered.plist : rendered.unit);
      const lockPath = join(fixture.data, 'daemon.pid');
      const original = Buffer.from(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), listen: null }));
      writeFileSync(lockPath, original);
      const result = await runManagedCli(fixture, port);
      expect(result.timedOut, result.stderr).toBe(false);
      expect(result.code, result.stderr).toBe(0);
      const logs = startupLogs(fixture.data);
      expect(logs).toContainEqual(expect.objectContaining({
        phase: 'daemon-startup', event: 'owner_present', pid: process.pid,
      }));
      expect(logs).not.toContainEqual(expect.objectContaining({
        phase: 'daemon-startup', event: 'registration_absent',
      }));
      expect(readFileSync(lockPath)).toEqual(original);
      expect(readdirSync(fixture.data).sort()).toEqual(['.access', 'daemon.pid', 'logs']);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }, 15_000);
});


describe('Windows relaunch helper entry', () => {
  it('refuses relaunch without touching the request or taking a data lease and stays hidden', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-relaunch-cli-')));
    try {
      const data = join(root, 'data');
      const requestDir = join(root, 'request');
      mkdirSync(data); mkdirSync(requestDir);
      writeFileSync(join(data, '.access'), 'admission must not be entered');
      const env = { ...process.env, HOME: root, USERPROFILE: root, VONVON_HOME: data };
      const result = spawnSync(process.execPath, [bin, '__win-relaunch', join(requestDir, 'missing.json')], { env, encoding: 'utf8', timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('Vonvon Bot cannot manage an OS service in this version. Use vonvon daemon start and vonvon daemon stop.');
      expect(readdirSync(requestDir)).toEqual([]);
      expect(readdirSync(data)).toEqual(['.access']);
      expect(readFileSync(join(data, '.access'), 'utf8')).toBe('admission must not be entered');
      const help = spawnSync(process.execPath, [bin, '--help'], { env, encoding: 'utf8', timeout: 10_000 });
      expect(help.status).toBe(0);
      expect(help.stdout).not.toContain('__win-relaunch');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
