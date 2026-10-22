import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
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
    env: { ...process.env, HOME: directory, VONVON_HOME: directory }, stdio: 'pipe',
  });
}
function result(child: ChildProcess): Promise<{ code: number | null; output: string }> {
  if (!child.stdout || !child.stderr) throw new Error('Expected piped child output');
  let output = '';
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { output += String(data); });
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, output })); });
}
async function run(directory: string, code: string, timeout = 5000) {
  const child = launch(directory, code);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try { return await result(child); } finally { clearTimeout(timer); }
}
function ipc(directory: string, code: string) {
  return spawn(process.execPath, ['-e', `const k=require(${JSON.stringify(entry)}); (async()=>{${code};process.disconnect()})().catch(e=>{console.error(e);process.exit(1)})`], {
    env: { ...process.env, HOME: directory, VONVON_HOME: directory }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
}
function signal(child: ReturnType<typeof ipc>, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`missing IPC signal ${expected}`)), 5000);
    const message = (value: unknown) => { if (value === expected) finish(); };
    const exit = () => finish(new Error(`child exited before ${expected}`));
    function finish(error?: Error) {
      clearTimeout(timer); child.off('message', message); child.off('exit', exit);
      if (error) reject(error); else resolve();
    }
    child.on('message', message); child.once('exit', exit);
  });
}
const readValue = `try { console.log((await k.getSecret('app-cli_t')) ?? 'none') } catch(e) { console.log('ERR:'+e.code) }`;


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

  it.each(['missing', 'short', 'public', 'version', 'envelope', 'store-symlink', ...(process.platform === 'win32' ? [] : ['store-fifo'])])('fails closed for %s without overwriting ciphertext or replacing the key', async mode => {
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
    if (mode === 'store-symlink') { await rename(storePath, join(directory, 'real.enc')); await symlink('real.enc', storePath); }
    if (mode === 'store-fifo') {
      await unlink(storePath);
      expect((await result(spawn('mkfifo', [storePath]))).code).toBe(0);
    }
    const metadata = await lstat(storePath);
    const target = metadata.isSymbolicLink() ? await readlink(storePath) : undefined;
    const ciphertext = metadata.isFIFO() ? undefined : await readFile(storePath);
    const key = await readFile(keyPath).catch(() => undefined);
    expect((await run(directory, 'await k.setSecret("next","dummy-two")')).code).toBe(1);
    expect((await run(directory, 'await k.removeSecret("kept")')).code).toBe(1);
    expect((await lstat(storePath)).isFIFO()).toBe(metadata.isFIFO());
    expect((await lstat(storePath)).isSymbolicLink()).toBe(metadata.isSymbolicLink());
    if (target) expect(await readlink(storePath)).toBe(target);
    if (!metadata.isFIFO()) expect(await readFile(storePath)).toEqual(ciphertext);
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

describe('lock-free readers (s31b0)', () => {
  it.each([false, true])('readers overlap atomic writers (remove=%s)', async removing => {
    const directory = await root();
    const stop = join(scratch, `stop-${roots.length}`);
    const readers = Array.from({ length: 3 }, () => ipc(directory, `
      const fs=require('node:fs'); const records=[];
      async function read(){let value;try{value=(await k.getSecret('app-cli_t'))??'none'}catch(e){value='ERR:'+e.code}
        records.push(value);process.send(value);}
      while(!fs.existsSync(${JSON.stringify(stop)})){await read();await new Promise(r=>setImmediate(r))}
      await read();console.log(JSON.stringify(records));`));
    const records = readers.map(() => new Array<string>());
    readers.forEach((child, i) => child.on('message', (value: unknown) => {
      if (typeof value === 'string') records[i]?.push(value);
    }));
    const readerResults = readers.map(child => result(child));
    let writer: ReturnType<typeof ipc> | undefined;
    let writerResult: ReturnType<typeof result> | undefined;
    try {
      await Promise.all(readers.map(child => signal(child, 'none')));
      writer = ipc(directory, `
        for(let i=1;i<=${removing ? 50 : 100};i++){
          await k.setSecret('app-cli_t','v-'+i);
          if(i===${removing ? 25 : 50}){const resume=new Promise(r=>process.once('message',r));process.send('half');await resume}
          ${removing ? "await k.removeSecret('app-cli_t');" : ''}
        }`);
      writerResult = result(writer);
      await signal(writer, 'half');
      // At the midpoint the writer holds a published value until every reader has observed it ten times.
      await Promise.all(readers.map((child, i) => new Promise<void>((resolve, reject) => {
        const ready = () => (records[i] ?? []).filter(value => /^v-\d+$/.test(value)).length >= 10;
        const timer = setTimeout(() => { child.off('message', check); reject(new Error('reader did not overlap writer')); }, 5000);
        function check() { if (ready()) { clearTimeout(timer); child.off('message', check); resolve(); } }
        child.on('message', check); check();
      })));
      writer.send('resume');
      expect(await writerResult).toEqual({ code: 0, output: '' });
      await writeFile(stop, 'stop');
      const completed = await Promise.all(readerResults);
      completed.forEach((value, i) => {
        expect(value.code).toBe(0);
        const observed = records[i] ?? [];
        expect(observed.length).toBeGreaterThanOrEqual(10);
        expect(observed.some(value => /^v-\d+$/.test(value) && Number(value.slice(2)) < (removing ? 50 : 100))).toBe(true);
        let last = 0;
        for (const value of observed) {
          expect(value === 'none' || /^v-\d+$/.test(value)).toBe(true);
          if (value === 'none') { if (!removing) expect(last).toBe(0); }
          else { const n = Number(value.slice(2)); expect(n).toBeGreaterThanOrEqual(last); last = n; }
        }
        expect(observed.at(-1)).toBe(removing ? 'none' : 'v-100');
      });
    } finally {
      writer?.kill('SIGKILL'); readers.forEach(child => child.kill('SIGKILL'));
      await Promise.all([...readerResults, writerResult]);
    }
  }, 20000);

  it.each(['before-commit', 'before-key-link'])('reads without waiting for a writer held %s', async phase => {
    const directory = await root();
    if (phase === 'before-commit') expect((await run(directory, `await k.setSecret('app-cli_t','old')`)).code).toBe(0);
    const child = ipc(directory, phase === 'before-commit'
      ? `await k.setSecret('app-cli_t','new',async()=>{process.send('held');await new Promise(()=>{})})`
      : `const fs=require('node:fs/promises');fs.link=async()=>{process.send('held');await new Promise(()=>{})};await k.setSecret('app-cli_t','new')`);
    const exited = result(child);
    try {
      await signal(child, 'held');
      const start = performance.now();
      expect(await run(directory, readValue, 1000)).toEqual({ code: 0, output: phase === 'before-commit' ? 'old\n' : 'none\n' });
      expect(performance.now() - start).toBeLessThan(1000);
      child.kill('SIGKILL'); await exited;
      expect(await run(directory, readValue)).toEqual({ code: 0, output: phase === 'before-commit' ? 'old\n' : 'none\n' });
    } finally { child.kill('SIGKILL'); await exited; }
  });

  it.each(['key-swapped', 'data-bitflip', 'tag-bitflip', 'truncated', 'store-symlink',
    ...(process.platform === 'win32' ? [] : ['store-fifo']), 'store-dir', 'store-big', 'key-symlink',
    'key-hardlink', 'store-hardlink', 'junk-coordination', 'own-props'])('reads fail closed or preserve supported files: %s', async mode => {
    const directory = await root();
    expect((await run(directory, `await k.setSecret('app-cli_t','v')`)).code).toBe(0);
    const key = join(directory, 'master.key'); const store = join(directory, 'secrets.enc');
    if (mode === 'key-swapped') { await writeFile(join(directory, 'replacement.key'), Buffer.alloc(32, 7), { mode: 0o600 }); await rename(join(directory, 'replacement.key'), key); }
    if (mode === 'data-bitflip' || mode === 'tag-bitflip') {
      expect((await run(directory, `const fs=require('node:fs/promises');const p=${JSON.stringify(store)};
        const store=JSON.parse(await fs.readFile(p,'utf8'));const field=${JSON.stringify(mode === 'data-bitflip' ? 'data' : 'tag')};
        const bytes=Buffer.from(store.entries['app-cli_t'][field],'base64');bytes[0]^=1;
        store.entries['app-cli_t'][field]=bytes.toString('base64');await fs.writeFile(p,JSON.stringify(store))`)).code).toBe(0);
    }
    if (mode === 'truncated') { const bytes = await readFile(store); await writeFile(store, bytes.subarray(0, Math.floor(bytes.length / 2))); }
    if (mode === 'store-symlink') { await rename(store, join(directory, 'real.enc')); await symlink('real.enc', store); }
    if (mode === 'store-fifo') { await unlink(store); expect((await result(spawn('mkfifo', [store]))).code).toBe(0); }
    if (mode === 'store-dir') { await unlink(store); await mkdir(store); }
    if (mode === 'key-symlink') { await rename(key, join(directory, 'real.key')); await symlink('real.key', key); }
    if (mode === 'key-hardlink') await link(key, join(directory, 'key-link'));
    if (mode === 'store-hardlink') await link(store, join(directory, 'store-link'));
    if (mode === 'junk-coordination') { await mkdir(join(directory, '.access')); await writeFile(join(directory, '.access/x.json'), '{'); await mkdir(join(directory, '.locks'), { recursive: true }); await writeFile(join(directory, '.locks/junk'), 'junk', { mode: 0o644 }); }
    if (mode === 'store-big') {
      expect((await run(directory, `await k.setSecret('big','x'.repeat(800000))`)).code).toBe(0);
      expect((await stat(store)).size).toBeGreaterThan(1024 * 1024);
      expect(await run(directory, `if(await k.getSecret('big')!=='x'.repeat(800000))throw Error('large value differs');
        await k.setSecret('other','kept');await k.removeSecret('big');
        if(await k.getSecret('big')!==undefined||await k.getSecret('other')!=='kept')throw Error('large mutation failed')`)).toEqual({ code: 0, output: '' });
    }
    if (mode === 'own-props') {
      expect(await run(directory, `console.log(await k.getSecret('constructor'));console.log(await k.getSecret('toString'))`)).toEqual({ code: 0, output: 'undefined\nundefined\n' });
      return;
    }
    const expected = ['key-swapped', 'data-bitflip', 'tag-bitflip'].includes(mode) ? 'ERR:KEYSTORE_DECRYPT'
      : ['truncated', 'store-symlink', 'store-fifo', 'store-dir'].includes(mode) ? 'ERR:KEYSTORE_STORE_FORMAT'
        : mode === 'key-symlink' ? 'ERR:KEYSTORE_MASTER_KEY_MODE' : 'v';
    const start = performance.now();
    expect(await run(directory, readValue)).toEqual({ code: 0, output: expected + '\n' });
    if (mode === 'store-fifo') expect(performance.now() - start).toBeLessThan(2000);
  });

});

describe('Bridge credential ownership', () => {
  it('creates without overwriting and rolls back only the transaction reserved IV', async () => {
    const directory = await root();
    expect(await run(directory, `await k.createSecret('app-imported',Buffer.from('fixture-only'),Buffer.alloc(12,1)); console.log(await k.getSecret('app-imported'))`)).toEqual({code: 0, output: 'fixture-only\n'});
    expect((await run(directory, `await k.createSecret('app-imported',Buffer.from('collision'),Buffer.alloc(12,2))`)).code).toBe(1);
    expect(await run(directory, `console.log(await k.removeSecretIfIv('app-imported',Buffer.alloc(12,2))); console.log(await k.getSecret('app-imported'))`)).toEqual({code: 0, output: 'foreign\nfixture-only\n'});
    expect(await run(directory, `console.log(await k.removeSecretIfIv('app-imported',Buffer.alloc(12,1))); console.log(await k.removeSecretIfIv('app-imported',Buffer.alloc(12,1)))`)).toEqual({code: 0, output: 'removed\nabsent\n'});
  });
});
