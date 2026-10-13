import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
const manifestSchema = z.object({ source: z.string(), commit: z.string(), phase: z.enum(['seeding', 'complete']), files: z.array(z.object({ path: z.string(), mode: z.string(), sha256: z.string() })) });
const fixtures: string[] = [];
const importers: Promise<void>[] = [];
const closedFixtures = new Set<string>();
const originalPin = '446b2a40ca75b5f725d7b0baab777b3a8f18b2e0';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-import-')); fixtures.push(root);
  const source = join(root, 'source'); const destination = join(root, 'packages/daemon');
  await mkdir(join(source, 'src'), { recursive: true }); await mkdir(join(source, 'test'));
  await writeFile(join(source, 'LICENSE'), 'MIT fixture\n');
  await writeFile(join(source, 'src/main.ts'), 'original source\n');
  await writeFile(join(source, 'test/main.test.ts'), 'original test\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  const pin = git('rev-parse', 'HEAD');
  const script = join(root, 'scripts/import-core.mjs'); await mkdir(join(root, 'scripts'));
  const code = await readFile(resolve('../../scripts/import-core.mjs'), 'utf8');
  expect(code).toContain(`const pin = '${originalPin}'`);
  await writeFile(script, code.replace(originalPin, pin));
  const run = (preload?: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    if (closedFixtures.has(root)) { reject(new Error('Import fixture already closed')); return; }
    const prefix = preload ? ['--import', pathToFileURL(preload).href] : [];
    const child = spawn(process.execPath, [...prefix, script, source]); let output = '';
    importers.push(new Promise(resolve => child.once('close', () => resolve())));
    child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
    child.once('error', reject); child.once('close', code => resolve({ code, output }));
  });
  return { root, source, destination, script, run, git };
}
async function scratchSnapshot(destination: string) {
  const names = (await readdir(destination)).filter(name => name.startsWith('.import-')).sort();
  return Promise.all(names.map(async name => ({
    name,
    files: await Promise.all((await readdir(join(destination, name))).sort().map(async file => ({
      name: file, bytes: (await readFile(join(destination, name, file))).toString('hex'),
    }))),
  })));
}

async function expectCompleteSeed(f: Awaited<ReturnType<typeof fixture>>) {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(f.destination, 'import-core.json'), 'utf8')));
  expect(manifest.phase).toBe('complete');
  expect(manifest.commit).toBe(f.git('rev-parse', 'HEAD'));
  for (const file of manifest.files) {
    const bytes = await readFile(join(f.destination, file.path));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    expect(bytes).toEqual(await readFile(join(f.source, file.path === 'LICENSE.bridge' ? 'LICENSE' : file.path)));
    const modeMask = process.platform === 'win32' ? 0o200 : 0o777;
    expect((await lstat(join(f.destination, file.path))).mode & modeMask).toBe((file.mode === '100755' ? 0o755 : 0o644) & modeMask);
  }
  expect(await readFile(join(f.destination, 'PROVENANCE.md'), 'utf8')).toContain('A completed import never rewrites, repairs, or restores fork files.');
}

afterEach(async () => {
  const roots = fixtures.splice(0);
  roots.forEach(root => closedFixtures.add(root));
  await Promise.all(importers.splice(0));
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

it('reads pinned Git blobs even with dirty working files, then preserves adaptations, additions and deletions with zero writes', async () => {
  const f = await fixture(); await writeFile(join(f.source, 'src/main.ts'), 'dirty checkout');
  expect((await f.run()).code).toBe(0);
  expect(await readFile(join(f.destination, 'src/main.ts'), 'utf8')).toBe('original source\n');
  await writeFile(join(f.destination, 'src/main.ts'), 'fork adaptation');
  await writeFile(join(f.destination, 'src/new.ts'), 'fork addition');
  await rm(join(f.destination, 'test/main.test.ts'));
  const manifest = await readFile(join(f.destination, 'import-core.json'));
  expect((await f.run()).code).toBe(0);
  expect(await readFile(join(f.destination, 'src/main.ts'), 'utf8')).toBe('fork adaptation');
  expect(await readFile(join(f.destination, 'src/new.ts'), 'utf8')).toBe('fork addition');
  expect(await readdir(join(f.destination, 'test'))).toEqual([]);
  expect(await readFile(join(f.destination, 'import-core.json'))).toEqual(manifest);
});

it('rejects a mismatched HEAD without creating the destination', async () => {
  const f = await fixture(); await writeFile(join(f.source, 'next'), 'next'); f.git('add', '.'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'next');
  expect((await f.run()).code).toBe(1);
  await expect(readdir(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('converges after interruption at each publication and preserves unknown staging directories', { timeout: process.platform === 'win32' ? 20_000 : 5_000 }, async () => {
  const f = await fixture(); expect((await f.run()).code).toBe(0);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(f.destination, 'import-core.json'), 'utf8')));
  for (let count = 0; count < manifest.files.length; count++) {
    await rm(f.destination, { recursive: true }); await mkdir(f.destination);
    await writeFile(join(f.destination, 'import-core.json'), JSON.stringify({ ...manifest, phase: 'seeding' }));
    for (const file of manifest.files.slice(0, count)) {
      const sourcePath = file.path === 'LICENSE.bridge' ? 'LICENSE' : file.path;
      const content = await readFile(join(f.source, sourcePath));
      expect(createHash('sha256').update(content).digest('hex')).toBe(file.sha256);
      await mkdir(join(f.destination, sourcePath === 'LICENSE' ? '.' : sourcePath.split('/')[0] ?? '.'), { recursive: true });
      await writeFile(join(f.destination, file.path), content); await chmod(join(f.destination, file.path), 0o644);
    }
    await mkdir(join(f.destination, '.import-ABC123')); await writeFile(join(f.destination, '.import-ABC123/abandoned'), 'partial');
    expect((await f.run()).code).toBe(0);
    expect((await readdir(f.destination)).filter(name => name.startsWith('.import-'))).toEqual(['.import-ABC123']);
    expect(await readFile(join(f.destination, '.import-ABC123/abandoned'), 'utf8')).toBe('partial');
    await expectCompleteSeed(f);
    expect(manifestSchema.parse(JSON.parse(await readFile(join(f.destination, 'import-core.json'), 'utf8'))).phase).toBe('complete');
  }
});

it('refuses divergent seeding and parent symlinks without modifying external files', async () => {
  const f = await fixture(); await f.run();
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(f.destination, 'import-core.json'), 'utf8')));
  await writeFile(join(f.destination, 'import-core.json'), JSON.stringify({ ...manifest, phase: 'seeding' }));
  await writeFile(join(f.destination, 'src/main.ts'), 'user edit');
  expect((await f.run()).code).toBe(1);
  expect(await readFile(join(f.destination, 'src/main.ts'), 'utf8')).toBe('user edit');
  await rm(join(f.destination, 'src'), { recursive: true });
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.destination, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await f.run()).code).toBe(1); expect(await readdir(outside)).toEqual([]);
});

it('serializes concurrent imports and rejects an unrelated provenance file', { timeout: process.platform === 'win32' ? 20_000 : 5_000 }, async () => {
  const f = await fixture();
  expect((await Promise.all([f.run(), f.run(), f.run()])).every(value => value.code === 0)).toBe(true);
  await rm(f.destination, { recursive: true }); await mkdir(f.destination);
  const content = '# Daemon source provenance and V2 import blocker\nuser-owned content';
  await writeFile(join(f.destination, 'PROVENANCE.md'), content);
  expect((await f.run()).code).toBe(1);
  expect(await readFile(join(f.destination, 'PROVENANCE.md'), 'utf8')).toBe(content);
});

it('uses the platform lock endpoint without requiring a TCP port on Windows', async () => {
  const f = await fixture();
  const preload = join(f.root, 'check-lock-endpoint.mjs');
  await writeFile(preload, `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function(options, ...args) {
      if (process.platform === 'win32') {
        assert.match(options.path, /^\\\\\\\\\\.\\\\pipe\\\\vonvon-import-core-[a-f0-9]{64}$/);
        assert.equal(options.port, undefined);
      } else {
        assert.equal(options.host, '127.0.0.1');
        assert.equal(typeof options.port, 'number');
      }
      return listen.call(this, options, ...args);
    };
  `);
  const result = await f.run(preload);
  expect(result.code, result.output).toBe(0);
  await expectCompleteSeed(f);
});

it('fails closed when the Windows pipe cannot bind without falling back to TCP or writing a seed', async () => {
  const f = await fixture();
  const preload = join(f.root, 'deny-lock-endpoint.mjs');
  await writeFile(preload, `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    net.Server.prototype.listen = function(options) {
      assert.match(options.path, /^\\\\\\\\\\.\\\\pipe\\\\vonvon-import-core-[a-f0-9]{64}$/);
      assert.equal(options.port, undefined);
      throw Object.assign(new Error('injected pipe permission failure'), { code: 'EACCES' });
    };
  `);
  const result = await f.run(preload);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('injected pipe permission failure');
  expect(await readdir(f.destination)).toEqual([]);
});

it('rejects a read-only partial import while retaining its bytes', async () => {
  const f = await fixture(); expect((await f.run()).code).toBe(0);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(f.destination, 'import-core.json'), 'utf8')));
  await writeFile(join(f.destination, 'import-core.json'), JSON.stringify({ ...manifest, phase: 'seeding' }));
  const license = join(f.destination, 'LICENSE.bridge');
  const bytes = await readFile(license);
  await chmod(license, 0o444);
  try {
    const result = await f.run();
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Conflicting partial import: LICENSE.bridge');
    expect(await readFile(license)).toEqual(bytes);
  } finally { await chmod(license, 0o644); }
});

it('recovers an actual killed import while preserving its bounded unknown residue', async () => {
  const f = await fixture(); const source = await readFile(f.script, 'utf8');
  await writeFile(f.script, source.replace('await fs.link(staged, target);', "await fs.link(staged, target); process.kill(process.pid, 'SIGKILL');"));
  expect((await f.run()).code).not.toBe(0);
  expect((await readdir(f.destination)).some(name => name.startsWith('.import-'))).toBe(true);
  const residue = await scratchSnapshot(f.destination);
  expect(residue).toHaveLength(1);
  expect(residue[0]?.files).toHaveLength(1);
  await writeFile(f.script, source);
  expect((await f.run()).code).toBe(0);
  expect(await scratchSnapshot(f.destination)).toEqual(residue);
  await expectCompleteSeed(f);
});

it.each(['import-core.json', 'PROVENANCE.md'])('recovers %s publication and preserves unknown metadata scratch after a process dies before rename', async name => {
  const f = await fixture();
  const preload = join(f.root, 'crash-before-rename.mjs');
  await writeFile(preload, `import { promises as fs } from 'node:fs'; const rename=fs.rename; fs.rename=async(from,to)=>{if(to.endsWith(${JSON.stringify(name)}))process.kill(process.pid,'SIGKILL');return rename(from,to)};`);
  expect((await f.run(preload)).code).not.toBe(0);
  const residue = await scratchSnapshot(f.destination);
  expect(residue).toHaveLength(1);
  expect(residue[0]?.files).toHaveLength(1);
  await writeFile(join(f.destination, 'unowned.tmp'), 'keep');
  expect((await f.run()).code).toBe(0);
  expect((await readdir(f.destination)).filter(entry => entry.endsWith('.tmp'))).toEqual(['unowned.tmp']);
  expect(await readFile(join(f.destination, 'unowned.tmp'), 'utf8')).toBe('keep');
  expect(await scratchSnapshot(f.destination)).toEqual(residue);
  await expectCompleteSeed(f);
});

it('preserves unknown staging after complete publication without rewriting imported files', async () => {
  const f = await fixture();
  const preload = join(f.root, 'crash-after-complete.mjs');
  await writeFile(preload, `import { promises as fs } from 'node:fs'; const rename=fs.rename; fs.rename=async(from,to)=>{const complete=to.endsWith('import-core.json')&&(await fs.readFile(from,'utf8')).includes('"phase": "complete"');await rename(from,to);if(complete)process.kill(process.pid,'SIGKILL')};`);
  expect((await f.run(preload)).code).not.toBe(0);
  expect((await readdir(f.destination)).some(entry => entry.startsWith('.import-'))).toBe(true);
  const residue = await scratchSnapshot(f.destination);
  expect(residue).toHaveLength(1);
  expect(residue[0]?.files).toHaveLength(0);
  await expectCompleteSeed(f);
  await writeFile(join(f.destination, 'src/main.ts'), 'fork after complete');
  expect((await f.run()).code).toBe(0);
  expect(await readFile(join(f.destination, 'src/main.ts'), 'utf8')).toBe('fork after complete');
  expect(await scratchSnapshot(f.destination)).toEqual(residue);
});

for (const phase of ['complete', 'seeding', 'rejected']) {
  for (const kind of ['file', 'directory', 'symlink']) {
    it.each([
      '.import-ABC123',
      'import-core.json.12345678-1234-4234-8234-123456789abc.tmp',
      'PROVENANCE.md.12345678-1234-4234-8234-123456789abc.tmp',
    ])(`preserves foreign ${kind} %s during ${phase} import`, async name => {
      const f = await fixture();
      expect((await f.run()).code).toBe(0);
      if (phase !== 'complete') {
        const manifest = manifestSchema.parse(JSON.parse(await readFile(join(f.destination, 'import-core.json'), 'utf8')));
        await writeFile(join(f.destination, 'import-core.json'), JSON.stringify({ ...manifest, phase: 'seeding' }));
        if (phase === 'seeding') await rm(join(f.destination, 'src/main.ts'));
        else await writeFile(join(f.destination, 'src/main.ts'), 'fork conflict');
      }
      const foreign = join(f.destination, name);
      const outside = join(f.root, 'foreign-target');
      const content = 'foreign bytes must survive\n';
      if (kind === 'directory') {
        await mkdir(foreign);
        await writeFile(join(foreign, 'foreign.txt'), content);
      } else if (kind === 'symlink') {
        await writeFile(outside, content);
        await symlink(outside, foreign);
      } else {
        await writeFile(foreign, content);
      }
      const result = await f.run();
      expect(await readdir(f.destination), 'foreign path must survive the import').toContain(name);
      if (kind === 'directory') {
        expect((await lstat(foreign)).isDirectory()).toBe(true);
        expect(await readFile(join(foreign, 'foreign.txt'), 'utf8')).toBe(content);
      } else if (kind === 'symlink') {
        expect((await lstat(foreign)).isSymbolicLink()).toBe(true);
        expect(await readlink(foreign)).toBe(outside);
        expect(await readFile(outside, 'utf8')).toBe(content);
      } else {
        expect((await lstat(foreign)).isFile()).toBe(true);
        expect(await readFile(foreign, 'utf8')).toBe(content);
      }
      expect(result.code, result.output).toBe(phase === 'rejected' ? 1 : 0);
      if (phase === 'rejected') {
        expect(result.output).toContain('Conflicting partial import: src/main.ts');
        expect(await readFile(join(f.destination, 'src/main.ts'), 'utf8')).toBe('fork conflict');
      } else {
        expect(manifestSchema.parse(JSON.parse(await readFile(join(f.destination, 'import-core.json'), 'utf8'))).phase).toBe('complete');
        expect(await readFile(join(f.destination, 'src/main.ts'), 'utf8')).toBe('original source\n');
      }
    });
  }
}

it.each([
  ['directory creation', "const create=fs.mkdtemp;fs.mkdtemp=async(...args)=>{const result=await create(...args);process.kill(process.pid,'SIGKILL');return result}"],
  ['exclusive open', "const open=fs.open;fs.open=async(...args)=>{const handle=await open(...args);if(args[1]==='wx')process.kill(process.pid,'SIGKILL');return handle}"],
  ['partial write', "const open=fs.open;fs.open=async(...args)=>{const handle=await open(...args);if(args[1]==='wx')handle.writeFile=async bytes=>{await handle.write(String(bytes).slice(0,7));process.kill(process.pid,'SIGKILL')};return handle}"],
  ['seeding rename', "const rename=fs.rename;fs.rename=async(...args)=>{await rename(...args);process.kill(process.pid,'SIGKILL')}"],
  ['payload release', "const unlink=fs.unlink;fs.unlink=async(...args)=>{await unlink(...args);process.kill(process.pid,'SIGKILL')}"],
  ['empty directory cleanup', "fs.rmdir=async()=>{process.kill(process.pid,'SIGKILL')}"],
])('recovers a real SIGKILL at %s without deleting unknown residue', async (_boundary, hook) => {
  const f = await fixture();
  const preload = join(f.root, 'crash-boundary.mjs');
  await writeFile(preload, `import { promises as fs } from 'node:fs'; ${hook};`);
  expect((await f.run(preload)).code).not.toBe(0);
  const residue = await scratchSnapshot(f.destination);
  expect(residue).toHaveLength(1);
  expect(residue[0]?.files.length).toBeLessThanOrEqual(1);
  expect((await f.run()).code).toBe(0);
  await expectCompleteSeed(f);
  expect(await scratchSnapshot(f.destination)).toEqual(residue);
  const manifest = await readFile(join(f.destination, 'import-core.json'));
  await writeFile(join(f.destination, 'src/main.ts'), 'fork adaptation');
  await rm(join(f.destination, 'test/main.test.ts'));
  expect((await f.run()).code).toBe(0);
  expect(await scratchSnapshot(f.destination)).toEqual(residue);
  expect(await readFile(join(f.destination, 'import-core.json'))).toEqual(manifest);
  expect(await readFile(join(f.destination, 'src/main.ts'), 'utf8')).toBe('fork adaptation');
  expect(await readdir(join(f.destination, 'test'))).toEqual([]);
});

it.each(['exclusive collision', 'replaced payload', 'unexpected entry', 'replaced directory'])('preserves foreign data during live cleanup after %s', async scenario => {
  const f = await fixture();
  const preload = join(f.root, 'foreign-live.mjs');
  const record = join(f.root, 'foreign-path');
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  const hook = scenario === 'exclusive collision'
    ? "const open=fs.open;fs.open=async(file,flags,...args)=>{if(flags==='wx'){await fs.writeFile(file,'foreign bytes');await fs.writeFile(record,file)}return open(file,flags,...args)}"
    : scenario === 'replaced payload'
      ? "fs.rename=async(file)=>{await fs.renameOriginal(file,file+'.original');await fs.writeFile(file,'foreign bytes');await fs.writeFile(record,file);throw new Error('injected replacement')}"
      : scenario === 'unexpected entry'
        ? "const create=fs.mkdtemp;fs.mkdtemp=async(...args)=>{const directory=await create(...args);const file=directory+'/foreign';await fs.writeFile(file,'foreign bytes');await fs.writeFile(record,file);return directory}"
        : "fs.rename=async(file)=>{const directory=path.dirname(file);await fs.renameOriginal(directory,directory+'.original');await fs.symlink(outside,directory,'dir');await fs.writeFile(directory+'/foreign','foreign bytes');await fs.writeFile(record,directory+'/foreign');throw new Error('injected directory replacement')}";
  await writeFile(preload, `import { promises as fs } from 'node:fs';import path from 'node:path';const record=${JSON.stringify(record)},outside=${JSON.stringify(outside)};fs.renameOriginal=fs.rename;${hook};`);
  const result = await f.run(preload);
  expect(result.code, result.output).toBe(scenario === 'unexpected entry' ? 0 : 1);
  const foreign = await readFile(record, 'utf8');
  expect(await readFile(foreign, 'utf8')).toBe('foreign bytes');
  if (scenario === 'replaced directory') {
    expect((await lstat(resolve(foreign, '..'))).isSymbolicLink()).toBe(true);
    expect(await readlink(resolve(foreign, '..'))).toBe(outside);
  }
  if (scenario === 'unexpected entry') await expectCompleteSeed(f);
});

it.each([
  ['payload write', "const open=fs.open;fs.open=async(...args)=>{const handle=await open(...args);if(args[1]==='wx')handle.writeFile=async()=>{throw new Error('injected write failure')};return handle}"],
  ['payload sync', "const open=fs.open;fs.open=async(...args)=>{const handle=await open(...args);if(args[1]==='wx')handle.sync=async()=>{throw new Error('injected sync failure')};return handle}"],
  ['source publication', "fs.link=async()=>{throw new Error('injected link failure')}"],
])('cleans its own scratch after an ordinary %s failure and permits retry', async (_boundary, hook) => {
  const f = await fixture();
  const preload = join(f.root, 'error-boundary.mjs');
  await writeFile(preload, `import { promises as fs } from 'node:fs'; ${hook};`);
  const result = await f.run(preload);
  expect(result.code).toBe(1);
  expect(result.output).toContain('injected');
  expect(await scratchSnapshot(f.destination)).toEqual([]);
  expect((await f.run()).code).toBe(0);
  await expectCompleteSeed(f);
  expect(await scratchSnapshot(f.destination)).toEqual([]);
});
