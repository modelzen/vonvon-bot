import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { EnvironmentService } from '../src/environment/service';
import { executableRoots } from './environment-executable-fixture';

vi.mock('node:fs/promises', async importOriginal => {
  const { fixtureFilesystem } = await import('./environment-executable-fixture');
  return fixtureFilesystem(await importOriginal<typeof import('node:fs/promises')>());
});

const processTestTimeout = process.platform === 'win32' ? 60_000 : 5_000;
const readinessTimeout = process.platform === 'win32' ? 15_000 : 2_000;
const dirs: string[] = [];
afterEach(async () => {
  try { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); }
  finally { executableRoots.clear(); }
});

async function fixture(foreignPath?: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vonvon-environment-')));
  dirs.push(dir);
  executableRoots.add(await realpath(dir));
  const bin = join(dir, 'bin');
  await import('node:fs/promises').then(fs => fs.mkdir(bin));
  const cli = join(bin, process.platform === 'win32' ? 'lark-cli.cjs' : 'lark-cli');
  const npmScript = join(bin, process.platform === 'win32' ? 'npm.cjs' : 'npm');
  const npm = process.platform === 'win32' ? join(bin, 'npm.cmd') : npmScript;
  await writeFile(npmScript, '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o700 });
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('lark-cli 1.2.3'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write(JSON.stringify({defaultAs:'user',identities:{user:{available:true},bot:{available:false}}})); process.exit(0); }
if (args[0] === 'profile' && args[1] === 'list') { process.stdout.write(JSON.stringify([{name:'test',appId:'cli_test',brand:'feishu',active:true}])); process.exit(0); }
if (args[0] === 'profile' && args[1] === 'use') process.exit(0);
if (args[0] === 'profile' && args[1] === 'add') { process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); }
if (args[0] === 'auth' && args[1] === 'login') { process.stdout.write('https://accounts.feishu.cn/login'); const gate = path.join(process.env.HOME, 'release-login'); const timer = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(timer); process.exit(0); } }, 20); }
if (args[0] === 'config' && args[1] === 'init') process.exit(0);
`;
  await writeFile(cli, script, { mode: 0o700 });
  if (process.platform === 'win32') {
    for (const name of ['lark-cli', 'npm']) await writeFile(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`);
  }
  const environment = new EnvironmentService({ home: dir, getDataRoot: () => dir, resolveCodex: () => null, nodePath: process.execPath, path: foreignPath ? [foreignPath, bin].join(delimiter) : bin, fetchLatest: async () => null, npmPath: npm });
  return { dir, npmScript, environment };
}

async function waitUntil(check: () => Promise<boolean>) {
  for (const deadline = Date.now() + readinessTimeout; Date.now() < deadline;) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for tool operation');
}

describe('daemon environment operations', () => {
  it('excludes foreign Claude and lark executables before launching scan children', async () => {
    const foreign = await mkdtemp(join(tmpdir(), 'vonvon-foreign-tools-'));
    dirs.push(foreign);
    const marker = join(foreign, 'executed');
    for (const name of ['claude', 'lark-cli']) {
      const script = join(foreign, process.platform === 'win32' ? `${name}.cjs` : name);
      await writeFile(script, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\nprocess.stdout.write('9.9.9');\n`, { mode: 0o700 });
      if (process.platform === 'win32') await writeFile(join(foreign, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`);
    }
    const f = await fixture(foreign);
    try {
      expect(await f.environment.run({ type: 'scan' })).toMatchObject({ kind: 'tools', tools: expect.arrayContaining([
        expect.objectContaining({ tool: 'claude', installation: 'missing' }),
        expect.objectContaining({ tool: 'lark-cli', installation: 'external', version: '1.2.3' }),
      ]) });
      expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull();
    } finally { await f.environment.close(); }
  }, processTestTimeout);

  it('scans, reads auth, and handles lark profiles with fake local tool', async () => {
    const f = await fixture();
    try {
      const scan = await f.environment.run({ type: 'scan' });
      expect(scan).toMatchObject({ kind: 'tools', tools: expect.arrayContaining([expect.objectContaining({ tool: 'lark-cli', installation: 'external', version: '1.2.3' })]) });
      expect(await f.environment.run({ type: 'authStatus', tool: 'lark-cli' })).toMatchObject({ kind: 'auth', state: 'signedIn' });
      expect(await f.environment.run({ type: 'profileList' })).toMatchObject({ kind: 'profiles', profiles: [{ name: 'test' }] });
      expect(await f.environment.run({ type: 'profileUse', name: 'test' })).toMatchObject({ kind: 'profiles' });
      expect(await f.environment.run({ type: 'profileAdd', name: 'new', appId: 'cli_new', appSecret: 'fake-local-secret', brand: 'feishu', use: true })).toMatchObject({ kind: 'profiles' });
      expect(await f.environment.run({ type: 'install', tool: 'lark-cli' })).toMatchObject({ kind: 'refused', code: 'install-failed' });
      expect(await f.environment.run({ type: 'update', tool: 'lark-cli' })).toMatchObject({ kind: 'refused', code: 'install-failed' });
      expect(await f.environment.run({ type: 'uninstall', tool: 'lark-cli' })).toMatchObject({ kind: 'refused', code: 'external-install' });
      const initialized = await f.environment.run({ type: 'profileInit', name: 'new' });
      if (initialized.kind !== 'operation' || initialized.operation?.kind !== 'running') throw new Error('Profile initialization did not start');
      await waitUntil(async () => {
        const status = await f.environment.run({ type: 'profileInitStatus' });
        return status.kind === 'operation' && status.operation?.kind === 'succeeded';
      });
      expect(await f.environment.run({ type: 'profileInitCancel', operationId: initialized.operation.id })).toMatchObject({ kind: 'refused', code: 'not-running' });
    } finally {
      await writeFile(join(f.dir, 'release-login'), 'go');
      await f.environment.close();
    }
  }, processTestTimeout);

  it('keeps a login child owned until cancellation or natural exit during stop', async () => {
    const f = await fixture();
    try {
      const started = await f.environment.run({ type: 'startLogin', tool: 'lark-cli' });
      if (started.kind !== 'operation' || started.operation?.kind !== 'running') throw new Error('Login did not start');
      await waitUntil(async () => {
        const status = await f.environment.run({ type: 'loginStatus' });
        return status.kind === 'operation' && status.operation?.kind === 'running' && status.operation.url === 'https://accounts.feishu.cn/login';
      });
      const cancelled = await f.environment.run({ type: 'cancelLogin', operationId: started.operation.id });
      expect(cancelled).toMatchObject({ kind: 'operation', operation: { kind: 'cancelled' } });
      const second = await f.environment.run({ type: 'startLogin', tool: 'lark-cli' });
      expect(second).toMatchObject({ kind: 'operation', operation: { kind: 'running' } });
      await waitUntil(async () => {
        const status = await f.environment.run({ type: 'loginStatus' });
        return status.kind === 'operation' && status.operation?.kind === 'running' && status.operation.url === 'https://accounts.feishu.cn/login';
      });
      let drained = false;
      const closing = f.environment.close().then(() => { drained = true; });
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(drained).toBe(false);
      expect(await f.environment.run({ type: 'profileList' })).toMatchObject({ kind: 'refused', code: 'environment-closed' });
      await writeFile(join(f.dir, 'release-login'), 'go');
      await closing;
      expect(drained).toBe(true);
    } finally {
      await writeFile(join(f.dir, 'release-login'), 'go');
      await f.environment.close();
    }
  }, processTestTimeout);

  it('cancels a running fake npm install and retains the previous selection', async () => {
    const f = await fixture();
    await writeFile(f.npmScript, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.env.HOME, 'install-started'), 'started');
const timer = setInterval(() => { if (fs.existsSync(path.join(process.env.HOME, 'release-install'))) { clearInterval(timer); process.exit(1); } }, 20);
`, { mode: 0o700 });
    try {
      const installing = f.environment.run({ type: 'install', tool: 'lark-cli' });
      let id: string | undefined;
      await waitUntil(async () => {
        const status = await f.environment.run({ type: 'toolInstallStatus' });
        if (status.kind !== 'toolInstall' || status.operation?.kind !== 'running') return false;
        id = status.operation.id;
        return await readFile(join(f.dir, 'install-started'), 'utf8').catch(() => null) === 'started';
      });
      if (!id) throw new Error('Install id missing');
      expect(await f.environment.run({ type: 'cancelInstall', operationId: id })).toMatchObject({ kind: 'toolInstall', operation: { kind: 'cancelled', id } });
      expect(await installing).toMatchObject({ kind: 'refused', code: 'install-cancelled' });
      expect(await readFile(join(f.dir, 'managed-tools', 'lark-cli', 'current.json'), 'utf8').catch(() => null)).toBeNull();
    } finally {
      await writeFile(join(f.dir, 'release-install'), 'go');
      await f.environment.close();
    }
  }, processTestTimeout);

  it('publishes a verified managed install and disables only that selection', async () => {
    const f = await fixture();
    await writeFile(f.npmScript, `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
const args=process.argv.slice(2);const prefix=args[args.indexOf('--prefix')+1];
const windows=process.platform==='win32';
const packageDir=path.join(prefix,...(windows?['node_modules']:['lib','node_modules']),'@larksuite','cli');
fs.mkdirSync(packageDir,{recursive:true});fs.writeFileSync(path.join(packageDir,'package.json'),JSON.stringify({name:'@larksuite/cli',version:'1.2.4'}));
const bin=windows?prefix:path.join(prefix,'bin');fs.mkdirSync(bin,{recursive:true});
fs.writeFileSync(path.join(bin,windows?'lark-cli.cjs':'lark-cli'),'#!/usr/bin/env node\\nprocess.stdout.write("lark-cli 1.2.4");\\n',{mode:0o700});
if(windows) fs.writeFileSync(path.join(bin,'lark-cli.cmd'),'@echo off\\r\\n"'+process.execPath+'" "%~dp0lark-cli.cjs" %*\\r\\n');
`, { mode: 0o700 });
    try {
      expect(await f.environment.run({ type: 'install', tool: 'lark-cli' })).toMatchObject({ kind: 'applied' });
      const installed = await f.environment.run({ type: 'scan' });
      expect(installed).toMatchObject({ kind: 'tools', tools: expect.arrayContaining([expect.objectContaining({ tool: 'lark-cli', installation: 'managed', version: '1.2.4', managedVersion: '1.2.4' })]) });
      expect(await f.environment.run({ type: 'uninstall', tool: 'lark-cli' })).toMatchObject({ kind: 'applied' });
      const disabled = await f.environment.run({ type: 'scan' });
      expect(disabled).toMatchObject({ kind: 'tools', tools: expect.arrayContaining([expect.objectContaining({ tool: 'lark-cli', installation: 'external', managedVersion: null })]) });
    } finally {
      await writeFile(join(f.dir, 'release-login'), 'go');
      await f.environment.close();
    }
  }, processTestTimeout);
});
