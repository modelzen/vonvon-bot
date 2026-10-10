import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentService } from '../src/environment/service';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'vonvon-environment-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  await import('node:fs/promises').then(fs => fs.mkdir(bin));
  const cli = join(bin, 'lark-cli');
  const npm = join(bin, 'npm');
  await writeFile(npm, '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o700 });
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
  await chmod(cli, 0o700);
  const environment = new EnvironmentService({ home: dir, getDataRoot: () => dir, resolveCodex: () => null, nodePath: process.execPath, path: bin, fetchLatest: async () => null, npmPath: npm });
  return { dir, npm, environment };
}

async function waitUntil(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for tool operation');
}

describe('daemon environment operations', () => {
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
    } finally { await f.environment.close(); }
  });

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
      let drained = false;
      const closing = f.environment.close().then(() => { drained = true; });
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(drained).toBe(false);
      expect(await f.environment.run({ type: 'profileList' })).toMatchObject({ kind: 'refused', code: 'environment-closed' });
      await writeFile(join(f.dir, 'release-login'), 'go');
      await closing;
      expect(drained).toBe(true);
    } finally { await f.environment.close(); }
  });

  it('cancels a running fake npm install and retains the previous selection', async () => {
    const f = await fixture();
    await writeFile(f.npm, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
    try {
      const installing = f.environment.run({ type: 'install', tool: 'lark-cli' });
      let id: string | undefined;
      await waitUntil(async () => {
        const status = await f.environment.run({ type: 'toolInstallStatus' });
        if (status.kind !== 'toolInstall' || status.operation?.kind !== 'running') return false;
        id = status.operation.id;
        return true;
      });
      if (!id) throw new Error('Install id missing');
      expect(await f.environment.run({ type: 'cancelInstall', operationId: id })).toMatchObject({ kind: 'toolInstall', operation: { kind: 'cancelled', id } });
      expect(await installing).toMatchObject({ kind: 'refused', code: 'install-cancelled' });
      expect(await readFile(join(f.dir, 'managed-tools', 'lark-cli', 'current.json'), 'utf8').catch(() => null)).toBeNull();
    } finally { await f.environment.close(); }
  });

  it('publishes a verified managed install and disables only that selection', async () => {
    const f = await fixture();
    await writeFile(f.npm, `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
const args=process.argv.slice(2);const prefix=args[args.indexOf('--prefix')+1];
const windows=process.platform==='win32';
const packageDir=path.join(prefix,...(windows?['node_modules']:['lib','node_modules']),'@larksuite','cli');
fs.mkdirSync(packageDir,{recursive:true});fs.writeFileSync(path.join(packageDir,'package.json'),JSON.stringify({name:'@larksuite/cli',version:'1.2.4'}));
const bin=windows?prefix:path.join(prefix,'bin');fs.mkdirSync(bin,{recursive:true});
fs.writeFileSync(path.join(bin,windows?'lark-cli.cmd':'lark-cli'),windows?'@echo off\\r\\necho lark-cli 1.2.4\\r\\n':'#!/usr/bin/env node\\nprocess.stdout.write("lark-cli 1.2.4");\\n',{mode:0o700});
`, { mode: 0o700 });
    try {
      expect(await f.environment.run({ type: 'install', tool: 'lark-cli' })).toMatchObject({ kind: 'applied' });
      const installed = await f.environment.run({ type: 'scan' });
      expect(installed).toMatchObject({ kind: 'tools', tools: expect.arrayContaining([expect.objectContaining({ tool: 'lark-cli', installation: 'managed', version: '1.2.4', managedVersion: '1.2.4' })]) });
      expect(await f.environment.run({ type: 'uninstall', tool: 'lark-cli' })).toMatchObject({ kind: 'applied' });
      const disabled = await f.environment.run({ type: 'scan' });
      expect(disabled).toMatchObject({ kind: 'tools', tools: expect.arrayContaining([expect.objectContaining({ tool: 'lark-cli', installation: 'external', managedVersion: null })]) });
    } finally { await f.environment.close(); }
  });
});
