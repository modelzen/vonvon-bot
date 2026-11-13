import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addProject, mutateProjectByChatId, mutateProjectStore, withStoredRows, type Project } from '../src/project/registry';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });
const row = (name: string): Project => ({name, chatId: `oc_${name}`, cwd: '/tmp', blank: false, createdAt: 1});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'registry-recipe-compat-')); roots.push(root);
  const target = {file: join(root, 'projects.json'), dataRoot: root};
  const original = {version: 1, retained: 'legacy', projects: [row('first'), row('second')]};
  await writeFile(target.file, JSON.stringify(original));
  const read = async () => JSON.parse(await readFile(target.file, 'utf8')) as typeof original;
  return {target, original, read};
}

describe('recipe metadata on historical project rows', () => {
  it('keeps untouched legacy rows intact when another group is migrated', async () => {
    const f = await fixture();
    await withStoredRows(f.target, async rows => { rows[0]!.judge = {kind: 'llm', backend: 'codex-appserver', model: 'fixed'}; return true; });
    expect((await f.read()).projects[1]).toEqual(f.original.projects[1]);
    expect((await f.read()).retained).toBe('legacy');
  });

  it('keeps legacy rows intact when only the operation ledger changes', async () => {
    const f = await fixture();
    await mutateProjectStore(f.target, async stored => { stored.recipeInstallOperations = {}; return {changed: true, value: undefined}; });
    expect((await f.read()).projects).toEqual(f.original.projects);
  });

  it('preserves a named binding and advances its revision after settings change and change back', async () => {
    const f = await fixture();
    const added = await addProject(row('new'), f.target);
    expect(added.bindingIncarnation).toMatch(/^[a-f0-9-]{36}$/);
    expect(added.projectSettingsRevision).toBe(0);
    const changed = await mutateProjectByChatId('oc_new', project => { project.noMention = false; }, undefined, f.target);
    const restored = await mutateProjectByChatId('oc_new', project => { delete project.noMention; }, undefined, f.target);
    expect(changed.bindingIncarnation).toBe(added.bindingIncarnation);
    expect(restored.bindingIncarnation).toBe(added.bindingIncarnation);
    expect(changed.projectSettingsRevision).toBe(1);
    expect(restored.projectSettingsRevision).toBe(2);
    expect((await f.read()).projects.slice(0, 2)).toEqual(f.original.projects);
  });
});
