import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { libraryLocation } from '../src/project/library';
import { MemoryStore, projectMemoryLocation } from '../src/bot/memory-store';

// Real processes: writers in several processes at once on one memory, held apart by the kernel `memory` mutex.
let scratch: string;
let entry: string;
const children = new Set<ChildProcess>();
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'memory-process-')));
  entry = join(scratch, 'store.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/bot/memory-store.ts', import.meta.url))], outfile: entry,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
});
afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map(child => once(child, 'exit')));
  await rm(scratch, { recursive: true, force: true });
});

function run(code: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, ['-e', `const m=require(${JSON.stringify(entry)});(async()=>{${code}})().catch(e=>{console.error(e);process.exitCode=1})`],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(child);
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { children.delete(child); resolve({ code, stderr }); });
  });
}

describe('writers in several processes', () => {
  it('lose no entry and no event', async () => {
    const data = await realpath(await mkdtemp(join(scratch, 'data-')));
    const library = JSON.stringify(libraryLocation(data));
    const writer = (name: string): Promise<{ code: number | null; stderr: string }> => run(`
      const store = new m.MemoryStore(m.projectMemoryLocation('prj_0a1b2c3d', { library: ${library} }));
      for (let i = 0; i < 8; i++) {
        const r = await store.add({ text: '${name} 的第 ' + i + ' 条', branch: '${name}', source: { via: 'ui', botId: '', actorRole: 'owner' }, trust: 'trusted', actor: { role: 'desktop' } });
        if (!r.ok) throw new Error(r.reason);
      }`);
    const results = await Promise.all(['甲', '乙', '丙'].map(writer));
    for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0 });
    const store = new MemoryStore(projectMemoryLocation('prj_0a1b2c3d', { library: libraryLocation(data) }));
    const view = await store.read();
    expect(view.items).toHaveLength(24);
    expect(new Set(view.items.map(item => item.text)).size).toBe(24);
    expect(view.verified).toBe(true);
    expect((await store.events())).toHaveLength(24);
    const log = (await readFile(join(data, 'library', 'prj_0a1b2c3d', 'events.jsonl'), 'utf8')).trimEnd().split('\n');
    expect(log).toHaveLength(24);
    expect(view.branches.map(branch => branch.name)).toEqual(expect.arrayContaining(['甲', '乙', '丙']));
  }, 60_000);

  it('give a second edit of the same entry a revision conflict, whichever process it came from', async () => {
    const data = await realpath(await mkdtemp(join(scratch, 'data-')));
    const library = libraryLocation(data);
    const store = new MemoryStore(projectMemoryLocation('prj_0a1b2c3d', { library }));
    const added = await store.add({ text: '周四发版', source: { via: 'ui', botId: '', actorRole: 'owner' }, trust: 'trusted', actor: { role: 'desktop' } });
    if (!added.ok) throw new Error('add');
    const editor = (text: string) => run(`
      const store = new m.MemoryStore(m.projectMemoryLocation('prj_0a1b2c3d', { library: ${JSON.stringify(library)} }));
      const r = await store.edit({ itemId: ${JSON.stringify(added.item.id)}, revision: 1, text: ${JSON.stringify(text)}, actor: { role: 'desktop' } });
      console.error(r.ok ? 'WON' : r.reason);`);
    const [a, b] = await Promise.all([editor('周五发版'), editor('周六发版')]);
    expect([a.stderr.trim(), b.stderr.trim()].sort()).toEqual(['WON', 'conflict']);
    expect((await store.get(added.item.id))?.revision).toBe(2);
  }, 60_000);
});
