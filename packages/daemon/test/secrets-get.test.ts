import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

let buildDir: string;
let cli: string;
let keystore: string;
let access: string;
const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const replySchema = z.object({ protocolVersion: z.literal(1), values: z.record(z.string(), z.string()), errors: z.record(z.string(), z.object({ message: z.string() })) }).strict();
const traceSchema = z.array(z.object({ name: z.string(), path: z.string(), flags: z.union([z.string(), z.number()]).optional() }));
beforeAll(async () => {
  await mkdir(resolve('node_modules/.cache'), { recursive: true });
  buildDir = await mkdtemp(resolve('node_modules/.cache/vonvon-secrets-get-'));
  cli = join(buildDir, 'cli.mjs'); keystore = join(buildDir, 'keystore.cjs'); access = join(buildDir, 'access.cjs');
  await build({ entryPoints: [resolve('src/cli/index.ts')], outfile: cli, bundle: true, packages: 'external', platform: 'node', format: 'esm' });
  for (const { source, outfile } of [{ source: 'keystore', outfile: keystore }, { source: 'data-access', outfile: access }]) {
    await build({ entryPoints: [resolve(`src/config/${source}.ts`)], outfile, bundle: true, platform: 'node', format: 'cjs' });
  }
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) { await chmod(join(dir, 'vh'), 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});
afterAll(async () => { await rm(buildDir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'secrets-get-')); dirs.push(dir);
  const home = join(dir, 'home'); const root = join(dir, 'vh'); await mkdir(home); await mkdir(root);
  return { dir, home, root };
}
function launch(f: { home: string; root: string }, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, args, { env: { ...process.env, HOME: f.home, VONVON_HOME: f.root, FEISHU_CODEX_BRIDGE: '1', ...env }, stdio: 'pipe' });
  children.push(child);
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); });
  const started = performance.now();
  const done = new Promise<{ code: number | null; stdout: string; stderr: string; elapsed: number }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr, elapsed: performance.now() - started }));
  });
  return { child, done, stdout: () => stdout };
}
async function get(f: { home: string; root: string }, input: string, preload?: string, env?: NodeJS.ProcessEnv) {
  const p = launch(f, [...(preload ? ['--require', preload] : []), cli, 'secrets', 'get'], env);
  p.child.stdin.end(input); return p.done;
}
async function seed(f: { home: string; root: string }, value = 'v') {
  const p = launch(f, ['-e', `require(${JSON.stringify(keystore)}).setSecret('app-cli_t', ${JSON.stringify(value)}).catch(e=>{console.error(e);process.exitCode=1})`]);
  expect(await p.done).toMatchObject({ code: 0, stderr: '' });
}
const success = { protocolVersion: 1, values: { 'app-cli_t': 'v' }, errors: {} };
it.each([
  { name: 'success', input: { ids: ['app-cli_t'] }, expected: success },
  { name: 'partial success', input: { ids: ['app-cli_t', 'app-cli_x', 'typesafe-api-key'] }, expected: { protocolVersion: 1, values: { 'app-cli_t': 'v' }, errors: { 'app-cli_x': { message: 'not found' }, 'typesafe-api-key': { message: 'not handed out: only the daemon reads this key' } } } },
  { name: 'unreadable key', input: { ids: ['app-cli_t'] }, expected: { protocolVersion: 1, values: {}, errors: { 'app-cli_t': { message: 'master.key 不对：要是本人所有、权限 0600、32 字节的普通文件（KEYSTORE_MASTER_KEY_MODE）' } } } },
  { name: 'missing ids', input: {}, expected: { protocolVersion: 1, values: {}, errors: {} } },
  { name: 'invalid JSON', input: '{', expected: { protocolVersion: 1, values: {}, errors: { _: { message: 'invalid request JSON' } } } },
  { name: 'invalid ids', input: { ids: [1] }, expected: { protocolVersion: 1, values: {}, errors: { _: { message: 'invalid request: ids must be an array of strings' } } } },
  { name: 'unsupported version', input: { protocolVersion: 2, ids: ['app-cli_t'] }, expected: { protocolVersion: 1, values: {}, errors: { 'app-cli_t': { message: 'unsupported protocolVersion: only 1' } } } },
])('returns exactly one v1 reply for $name', async ({ name, input, expected }) => {
  const f = await fixture(); await seed(f);
  if (name === 'unreadable key') await chmod(join(f.root, 'master.key'), 0o644);
  const result = await get(f, typeof input === 'string' ? input : JSON.stringify(input));
  expect(result.code, result.stderr).toBe(0); expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
  expect(result.stderr).not.toContain('"app-cli_t":"v"'); expect(result.stderr).toBe('');
});
it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reads a read-only root without adding files', async () => {
  const f = await fixture(); await seed(f); const before = await readdir(f.root);
  await chmod(f.root, 0o555);
  const result = await get(f, '{"ids":["app-cli_t"]}');
  expect(result).toMatchObject({ code: 0, stdout: `${JSON.stringify(success)}\n` }); expect(await readdir(f.root)).toEqual(before);
});
it('needs no writes or listener and reads only the two keystore files under simulated seccomp', async () => {
  const f = await fixture(); await seed(f);
  const preload = join(f.dir, 'sandbox.cjs'); const trace = join(f.dir, 'trace.json');
  await writeFile(preload, `
const fs=require('node:fs'),fsp=require('node:fs/promises'),net=require('node:net');
const records=[],write=fs.writeFileSync;
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){records.push({name:'connect',path:''});return connect.apply(this,args)};
net.Server.prototype.listen=function(){records.push({name:'listen',path:''});process.nextTick(()=>this.emit('error',Object.assign(new Error('sandbox'),{code:'EPERM'})));return this};
for(const api of [fs,fsp])for(const name of ['open','openSync','mkdir','mkdirSync','writeFile','writeFileSync','rename','renameSync','unlink','unlinkSync','link','linkSync','readFile','readFileSync']){
 if(typeof api[name]!=='function')continue;
 const original=api[name];api[name]=function(...args){records.push({name,path:String(args[0]),...(/^open/.test(name)?{flags:args[1]}:{})});return original.apply(this,args)};
}
require('node:module').syncBuiltinESMExports();
process.on('exit',()=>write(process.env.TRACE_FILE,JSON.stringify(records)));
`);
  const result = await get(f, '{"ids":["app-cli_t"]}', preload, { TRACE_FILE: trace });
  expect(result, result.stderr).toMatchObject({ code: 0, stdout: `${JSON.stringify(success)}\n` });
  const records = traceSchema.parse(JSON.parse(await readFile(trace, 'utf8')));
  expect(records.some(r => r.name === 'listen' || r.name === 'connect')).toBe(false);
  const writes = records.filter(r => /^(mkdir|writeFile|rename|unlink|link)/.test(r.name) || (typeof r.flags === 'number' ? !!(r.flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT)) : typeof r.flags === 'string' && /[wa+]/.test(r.flags)));
  expect(writes).toEqual([]);
  const rootReads = records.map(r => relative(f.root, r.path)).filter(path => path && !path.startsWith('..') && !isAbsolute(path));
  expect([...new Set(rootReads)].sort()).toEqual(['master.key', 'secrets.enc']);
  const constantsReader = launch(f, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(keystore)}).KEYSTORE_READ_FILES))`]);
  const declared = await constantsReader.done;
  expect(JSON.parse(declared.stdout)).toEqual(['secrets.enc', 'master.key']);
});
it('does not wait for another process holding admission', async () => {
  const f = await fixture(); await seed(f);
  const holder = launch(f, ['-e', `require(${JSON.stringify(access)}).acquireMutex(process.env.VONVON_HOME,'admission').then(()=>{console.log('held');setInterval(()=>{},1000)})`]);
  await expect.poll(holder.stdout, { timeout: 5000 }).toContain('held');
  const result = await get(f, '{"ids":["app-cli_t"]}');
  expect(result, result.stderr).toMatchObject({ code: 0, stdout: `${JSON.stringify(success)}\n` }); expect(result.elapsed).toBeLessThan(1000);
});
it('leaves a missing data root absent', async () => {
  const f = await fixture(); const root = join(f.root, 'absent');
  const result = await get({ ...f, root }, '{"ids":["app-cli_t"]}');
  expect(result).toMatchObject({ code: 0, stdout: '{"protocolVersion":1,"values":{},"errors":{"app-cli_t":{"message":"not found"}}}\n' });
  await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('fails before replying when the data root is a symlink', async () => {
  const f = await fixture(); const root = join(f.dir, 'link'); await symlink(f.root, root, 'dir');
  const result = await get({ ...f, root }, '{"ids":["app-cli_t"]}');
  expect(result.code).not.toBe(0); expect(result.stdout).toBe('');
});
it('serves three CLI readers during child-process writes without values going backwards', async () => {
  const f = await fixture(); await seed(f, 'v-0');
  const writer = launch(f, ['-e', `const k=require(${JSON.stringify(keystore)});(async()=>{for(let n=1;n<=30;n++){await k.setSecret('app-cli_t','v-'+n);if(n===15){console.log('half');await new Promise(r=>process.stdin.once('data',r))}}})().catch(e=>{console.error(e);process.exitCode=1})`]);
  await expect.poll(writer.stdout, { timeout: 10_000 }).toContain('half');
  let ready = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    let previous = 0;
    for (let n = 0; n < 5; n++) {
      const result = await get(f, '{"ids":["app-cli_t"]}'); expect(result.code, result.stderr).toBe(0);
      const reply = replySchema.parse(JSON.parse(result.stdout)); expect(reply.errors).toEqual({});
      const value = reply.values['app-cli_t']; expect(value).toMatch(/^v-\d+$/);
      const current = Number(value?.slice(2)); expect(current).toBeGreaterThanOrEqual(previous); previous = current;
      if (n === 0) { expect(current).toBe(15); if (++ready === 3) writer.child.stdin.end('continue'); }
    }
  }));
  expect(await writer.done).toMatchObject({ code: 0, stderr: '' });
  expect(replySchema.parse(JSON.parse((await get(f, '{"ids":["app-cli_t"]}')).stdout)).values['app-cli_t']).toBe('v-30');
}, 30_000);
