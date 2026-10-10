import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let scratch: string;
let entry: string;
const roots: string[] = [];
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'vonvon-keystore-build-'));
  entry = join(scratch, 'keystore.cjs');
  await build({ entryPoints: [resolve('src/config/keystore.ts')], outfile: entry, platform: 'node', format: 'cjs', bundle: true });
});
afterAll(async () => { await Promise.all([scratch, ...roots].map(root => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'vonvon-key-')); roots.push(value); return value; }
function launch(directory: string, code: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['-e', `const k=require(${JSON.stringify(entry)}); (async()=>{${code}})().catch(e=>{console.error(e.message);process.exitCode=1})`], {
    env: { ...process.env, VONVON_HOME: directory }, stdio: 'pipe',
  });
}
function result(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; output: string }> {
  let output = '';
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { output += String(data); });
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, output })); });
}
const run = (directory: string, code: string) => result(launch(directory, code));

describe('immutable daemon keystore', () => {
  it('publishes only a complete synced key and recovers after death before publication', async () => {
    const directory = await root();
    const child = launch(directory, `const fs=require('node:fs/promises'); fs.link=async()=>{console.log('before-publish');await new Promise(()=>{})}; await k.setSecret('first','dummy')`);
    const exited = result(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', data => { if (String(data).includes('before-publish')) resolve(); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('child exited before publication')));
    });
    await expect(stat(join(directory, 'master.key'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(directory, 'secrets.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
    child.kill('SIGKILL'); await exited;
    expect((await run(directory, 'await k.setSecret("after","dummy"); console.log(await k.getSecret("after"))'))).toEqual({ code: 0, output: 'dummy\n' });
    expect((await readFile(join(directory, 'master.key'))).length).toBe(32);
  });
  it('never replaces a key that wins the no-replace publication race', async () => {
    const directory = await root();
    const published = await run(directory, `const fs=require('node:fs/promises'); const link=fs.link; fs.link=async(from,to)=>{await fs.writeFile(to,Buffer.alloc(32,7),{mode:0o600,flag:'wx'});return link(from,to)}; await k.setSecret('first','dummy')`);
    expect(published.code).toBe(0);
    expect(await readFile(join(directory, 'master.key'))).toEqual(Buffer.alloc(32, 7));
    expect(await run(directory, 'console.log(await k.getSecret("first"))')).toEqual({ code: 0, output: 'dummy\n' });
  });

  it('does not create a key on reads, then decrypts after a host rename with a private random key', async () => {
    const directory = await root();
    expect((await run(directory, 'console.log(await k.getSecret("a"))')).code).toBe(0);
    await expect(stat(join(directory, 'master.key'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await run(directory, 'await k.setSecret("a","dummy-one")')).code).toBe(0);
    const key = await readFile(join(directory, 'master.key'));
    expect(key.length).toBe(32);
    if (process.platform !== 'win32') expect((await stat(join(directory, 'master.key'))).mode & 0o777).toBe(0o600);
    const renamed = await run(directory, 'require("node:os").hostname=()=>"renamed-host"; console.log(await k.getSecret("a"))');
    expect(renamed).toEqual({ code: 0, output: 'dummy-one\n' });
    expect(await readFile(join(directory, 'master.key'))).toEqual(key);
  });

  it.each(['missing', 'short', 'public', 'version', 'envelope'])('fails closed for %s without overwriting ciphertext or replacing the key', async mode => {
    const directory = await root();
    expect((await run(directory, 'await k.setSecret("kept","dummy")')).code).toBe(0);
    const keyPath = join(directory, 'master.key');
    const storePath = join(directory, 'secrets.enc');
    if (mode === 'missing') await unlink(keyPath);
    if (mode === 'short') await writeFile(keyPath, 'broken');
    if (mode === 'public') {
      if (process.platform === 'win32') await writeFile(keyPath, 'broken');
      else await chmod(keyPath, 0o644);
    }
    if (mode === 'version') await writeFile(storePath, '{"version":99,"entries":{"kept":"unchanged"}}');
    if (mode === 'envelope') await writeFile(storePath, '{"version":1,"entries":{"kept":{"iv":"bad","data":"","tag":"bad"}}}');
    const ciphertext = await readFile(storePath);
    const key = await readFile(keyPath).catch(() => undefined);
    expect((await run(directory, 'await k.setSecret("next","dummy-two")')).code).toBe(1);
    expect((await run(directory, 'await k.removeSecret("kept")')).code).toBe(1);
    expect(await readFile(storePath)).toEqual(ciphertext);
    expect(await readFile(keyPath).catch(() => undefined)).toEqual(key);
  });

  it('serializes whole transactions from independent processes without losing entries', async () => {
    const directory = await root();
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => run(directory, `await k.setSecret("id-${index}","dummy-${index}")`)));
    expect(results.every(value => value.code === 0)).toBe(true);
    const read = await run(directory, 'for(let i=0;i<12;i++){if(await k.getSecret(`id-${i}`)!==`dummy-${i}`)throw Error("lost write")} console.log((await k.listSecretIds()).length)');
    expect(read).toEqual({ code: 0, output: '12\n' });
  });

  it('releases ownership on process death and preserves the last committed store', async () => {
    const directory = await root();
    await run(directory, 'await k.setSecret("kept","dummy")');
    const before = await readFile(join(directory, 'secrets.enc'));
    const child = launch(directory, 'await k.setSecret("interrupted","dummy",async()=>{console.log("held");await new Promise(()=>{})})');
    const exited = result(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', data => { if (String(data).includes('held')) resolve(); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('child exited before transaction hold')));
    });
    child.kill('SIGKILL'); await exited;
    expect(await readFile(join(directory, 'secrets.enc'))).toEqual(before);
    expect((await run(directory, 'await k.setSecret("after","dummy"); console.log((await k.listSecretIds()).sort().join(","))'))).toEqual({ code: 0, output: 'after,kept\n' });
  });
});
