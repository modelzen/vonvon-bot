import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
const manifestSchema = z.object({ source: z.string(), commit: z.string(), phase: z.enum(['seeding', 'complete']), files: z.array(z.object({ path: z.string(), mode: z.string(), sha256: z.string() })) });
const fixtures: string[] = [];
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
  const run = (prefix: string[] = []) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...prefix, script, source]); let output = '';
    child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
    child.once('error', reject); child.once('close', code => resolve({ code, output }));
  });
  return { root, source, destination, script, run, git };
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

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

it('converges after interruption at each publication and removes abandoned staging directories', async () => {
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
    expect((await readdir(f.destination)).filter(name => name.startsWith('.import-'))).toEqual([]);
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

it('serializes concurrent imports and rejects an unrelated provenance file', async () => {
  const f = await fixture();
  expect((await Promise.all([f.run(), f.run(), f.run()])).every(value => value.code === 0)).toBe(true);
  await rm(f.destination, { recursive: true }); await mkdir(f.destination);
  const content = '# Daemon source provenance and V2 import blocker\nuser-owned content';
  await writeFile(join(f.destination, 'PROVENANCE.md'), content);
  expect((await f.run()).code).toBe(1);
  expect(await readFile(join(f.destination, 'PROVENANCE.md'), 'utf8')).toBe(content);
});

it('recovers an actual killed import without untracked staging residue', async () => {
  const f = await fixture(); const source = await readFile(f.script, 'utf8');
  await writeFile(f.script, source.replace('await fs.link(staged, target);', "await fs.link(staged, target); process.kill(process.pid, 'SIGKILL');"));
  expect((await f.run()).code).not.toBe(0);
  expect((await readdir(f.destination)).some(name => name.startsWith('.import-'))).toBe(true);
  await writeFile(f.script, source);
  expect((await f.run()).code).toBe(0);
  expect((await readdir(f.destination)).some(name => name.startsWith('.import-'))).toBe(false);
});

it.each(['import-core.json', 'PROVENANCE.md'])('cleans owned %s temporary metadata after a process dies before rename', async name => {
  const f = await fixture();
  const preload = join(f.root, 'crash-before-rename.mjs');
  await writeFile(preload, `import { promises as fs } from 'node:fs'; const rename=fs.rename; fs.rename=async(from,to)=>{if(to.endsWith(${JSON.stringify(name)}))process.kill(process.pid,'SIGKILL');return rename(from,to)};`);
  expect((await f.run(['--import', preload])).code).not.toBe(0);
  expect((await readdir(f.destination)).some(entry => entry.startsWith(name + '.') && entry.endsWith('.tmp'))).toBe(true);
  await writeFile(join(f.destination, 'unowned.tmp'), 'keep');
  expect((await f.run()).code).toBe(0);
  expect((await readdir(f.destination)).filter(entry => entry.endsWith('.tmp'))).toEqual(['unowned.tmp']);
  expect(await readFile(join(f.destination, 'unowned.tmp'), 'utf8')).toBe('keep');
});

it('cleans staging left after the complete manifest was published without rewriting imported files', async () => {
  const f = await fixture();
  const preload = join(f.root, 'crash-after-complete.mjs');
  await writeFile(preload, `import { promises as fs } from 'node:fs'; const rename=fs.rename; fs.rename=async(from,to)=>{const complete=to.endsWith('import-core.json')&&(await fs.readFile(from,'utf8')).includes('"phase": "complete"');await rename(from,to);if(complete)process.kill(process.pid,'SIGKILL')};`);
  expect((await f.run(['--import', preload])).code).not.toBe(0);
  expect((await readdir(f.destination)).some(entry => entry.startsWith('.import-'))).toBe(true);
  await writeFile(join(f.destination, 'src/main.ts'), 'fork after complete');
  expect((await f.run()).code).toBe(0);
  expect(await readFile(join(f.destination, 'src/main.ts'), 'utf8')).toBe('fork after complete');
  expect((await readdir(f.destination)).some(entry => entry.startsWith('.import-'))).toBe(false);
});
