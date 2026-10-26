import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Real processes: a host killed between the library write and the rows write, and two hosts' worth of migrations at
// once (the kernel `library` and `projects` mutexes, not the in-process chains).
let scratch: string;
let entry: string;
const children = new Set<ChildProcess>();
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'library-process-')));
  entry = join(scratch, 'library.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/admin/library.ts', import.meta.url))], outfile: entry,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
});
afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map(child => once(child, 'exit')));
  await rm(scratch, { recursive: true, force: true });
});

function run(root: string, code: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['-e', `const m=require(${JSON.stringify(entry)});(async()=>{${code}})().catch(e=>{console.error(e);process.exitCode=1})`],
    { env: { ...process.env, VONVON_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); });
  });
}

/** A data root with `count` bots, each bound to `count` groups; bot i's group j uses folder j, so each folder is one project. */
async function dataRoot(count: number): Promise<string> {
  const root = await mkdtemp(join(scratch, 'data-'));
  const bots = Array.from({ length: count }, (_, i) => ({ name: `bot${i}`, appId: `cli_${i}`, tenant: 'feishu', createdAt: 1, botName: `Bot ${i}`, active: i % 2 === 0 }));
  await writeFile(join(root, 'bots.json'), JSON.stringify({ version: 1, current: 'cli_0', bots }));
  for (const bot of bots) {
    await mkdir(join(root, 'bots', bot.appId), { recursive: true });
    const projects = [];
    for (let j = 0; j < count; j++) {
      const cwd = join(root, 'work', `folder-${j}`);
      await mkdir(cwd, { recursive: true });
      projects.push({ name: `群 ${j}`, chatId: `oc_${bot.appId}_${j}`, cwd, blank: false, createdAt: 1 });
    }
    await writeFile(join(root, 'bots', bot.appId, 'projects.json'), JSON.stringify({ version: 1, projects }));
  }
  return root;
}

async function state(root: string, count: number) {
  const library = JSON.parse(await readFile(join(root, 'library', 'projects.json'), 'utf8')).projects as Array<{ id: string; workspace: { primary: string } }>;
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(...JSON.parse(await readFile(join(root, 'bots', `cli_${i}`, 'projects.json'), 'utf8')).projects as Array<{ projectId?: string; cwd: string }>);
  const leftovers = (await readdir(join(root, 'library'))).filter(name => name.includes('.tmp-'));
  return { library, rows, leftovers };
}

describe('startup migration in real processes', () => {
  it('leaves no orphan project after a kill between the library write and the rows write', async () => {
    const root = await dataRoot(2);
    const killed = await run(root, `await m.prepareLibraryAtStartup({afterLibraryWrite:()=>process.kill(process.pid,'SIGKILL')});`);
    expect(killed.signal).toBe('SIGKILL');
    const cut = await state(root, 2);
    expect(cut.library).toHaveLength(2);
    expect(cut.rows.every(row => row.projectId === undefined)).toBe(true);
    const again = await run(root, `process.stdout.write(JSON.stringify(await m.prepareLibraryAtStartup()));`);
    expect(again.stderr).toBe('');
    expect(JSON.parse(again.stdout)).toMatchObject({ created: 0, linked: 4, failed: [] });
    const done = await state(root, 2);
    expect(done.library.map(project => project.id).sort()).toEqual(cut.library.map(project => project.id).sort());
    for (const row of done.rows) expect(done.library.find(project => project.id === row.projectId)?.workspace.primary).toBe(row.cwd);
    expect(done.leftovers).toEqual([]);
  });

  it('makes each project once when two processes migrate at the same time', async () => {
    const root = await dataRoot(3);
    const code = `process.stdout.write(JSON.stringify(await m.prepareLibraryAtStartup()));`;
    const results = await Promise.all([run(root, code), run(root, code)]);
    for (const result of results) {
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout).failed).toEqual([]);
    }
    const reports = results.map(result => JSON.parse(result.stdout));
    expect(reports[0].created + reports[1].created).toBe(3);
    expect(reports[0].linked + reports[1].linked).toBe(9);
    const done = await state(root, 3);
    expect(done.library).toHaveLength(3);
    expect(new Set(done.rows.map(row => row.projectId)).size).toBe(3);
    for (const row of done.rows) expect(done.library.find(project => project.id === row.projectId)?.workspace.primary).toBe(row.cwd);
  });
});
