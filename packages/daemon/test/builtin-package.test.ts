import { chmod, mkdir, mkdtemp, readFile, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const isolated = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config/data-root', () => ({ resolveDataRoot: () => ({ path: isolated.root }) }));
const directories: string[] = [];
afterEach(async () => {
  vi.resetModules();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function setup() {
  isolated.root = await mkdtemp(join(tmpdir(), 'builtin-package-'));
  directories.push(isolated.root);
  const { completeBuiltinPackage, ensureBuiltinPackage } = await import('../src/agent/builtin-skills/package');
  const { scheduleSkill } = await import('../src/agent/builtin-skills/schedule');
  return { completeBuiltinPackage, ensureBuiltinPackage, skill: scheduleSkill };
}

describe('builtin capability package', () => {
  it('keeps bot and group/dm package paths separate and stable', async () => {
    await setup();
    const { botPaths } = await import('../src/config/paths');
    const bot = botPaths('example');
    expect(bot.capabilities).toBe(join(bot.dir, 'capabilities'));
    expect(bot.builtinPackage('group')).toBe(join(bot.capabilities, 'builtin', 'group'));
    expect(bot.builtinPackage('dm')).toBe(join(bot.capabilities, 'builtin', 'dm'));
    expect(botPaths('another').builtinPackage('group')).not.toBe(bot.builtinPackage('group'));
  });
  it('generates a plugin and leaves identical content and mtimes untouched', async () => {
    const { ensureBuiltinPackage, skill } = await setup();
    const first = await ensureBuiltinPackage('example', 'group', [skill]);
    expect(first.changed).toBe(true);
    const plugin = join(first.path, '.claude-plugin', 'plugin.json');
    const file = join(first.path, 'skills', skill.name, 'SKILL.md');
    expect(JSON.parse(await readFile(plugin, 'utf8'))).toMatchObject({ name: 'vonvon', version: expect.stringMatching(/^[a-f0-9]{12}$/) });
    const text = await readFile(file, 'utf8');
    expect(text).toContain(`name: "${skill.name}"`);
    const frontmatter = text.split('---\n')[1];
    expect(frontmatter).toBeDefined();
    const descriptionLine = frontmatter!.split('\n').find(line => line.startsWith('description: '));
    const description: unknown = JSON.parse(descriptionLine!.slice('description: '.length));
    expect(description).toBe(skill.description);
    expect(description).not.toMatch(/[\r\n]/);
    expect(String(description).length).toBeLessThanOrEqual(300);
    const before = await Promise.all([stat(plugin), stat(file)]);
    expect(await ensureBuiltinPackage('example', 'group', [skill])).toEqual({ ...first, changed: false });
    expect((await stat(plugin)).mtimeMs).toBe(before[0]!.mtimeMs);
    expect((await stat(file)).mtimeMs).toBe(before[1]!.mtimeMs);
    if (process.platform !== 'win32') {
      for (const directory of [isolated.root, join(isolated.root, 'bots'), join(isolated.root, 'bots', 'example'), join(isolated.root, 'bots', 'example', 'capabilities'), join(isolated.root, 'bots', 'example', 'capabilities', 'builtin'), first.path, join(first.path, 'skills'), join(first.path, 'skills', skill.name), join(first.path, '.claude-plugin')]) {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
      }
      // s1b: read-only; the next session writes a changed one over again.
      for (const path of [plugin, file]) expect((await stat(path)).mode & 0o777).toBe(0o444);
    }
  });
  it('updates content at the same path and removes only obsolete SKILL.md files', async () => {
    const { ensureBuiltinPackage, skill } = await setup();
    const extra = { ...skill, name: 'another-skill' };
    const first = await ensureBuiltinPackage('example', 'group', [skill, extra]);
    const plugin = join(first.path, '.claude-plugin', 'plugin.json');
    const before = await readFile(plugin, 'utf8');
    const updated = await ensureBuiltinPackage('example', 'group', [{ ...skill, body: 'updated' }]);
    expect(updated).toEqual({ path: first.path, changed: true });
    expect(await readFile(join(first.path, 'skills', skill.name, 'SKILL.md'), 'utf8')).toContain('updated');
    expect(await readFile(plugin, 'utf8')).not.toBe(before);
    const oldDirectory = join(first.path, 'skills', extra.name);
    expect((await stat(oldDirectory)).isDirectory()).toBe(true);
    await expect(stat(join(oldDirectory, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await ensureBuiltinPackage('example', 'group', [])).toEqual({ path: first.path, changed: true });
    expect((await stat(first.path)).isDirectory()).toBe(true);
  });
  // s1b: the files are read-only, and one a person made writable and changed is written over by the next session.
  it('writes a hand-edited SKILL.md over again, read-only', async () => {
    const { ensureBuiltinPackage, skill } = await setup();
    const first = await ensureBuiltinPackage('example', 'group', [skill]);
    const file = join(first.path, 'skills', skill.name, 'SKILL.md');
    const original = await readFile(file, 'utf8');
    await chmod(file, 0o644);
    await writeFile(file, 'changed by hand');
    expect(await ensureBuiltinPackage('example', 'group', [skill])).toEqual({ path: first.path, changed: true });
    expect(await readFile(file, 'utf8')).toBe(original);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o444);
  });
  it('serializes concurrent cleanup and keeps the old directory', async () => {
    const { ensureBuiltinPackage, skill } = await setup();
    const first = await ensureBuiltinPackage('example', 'group', [skill, { ...skill, name: 'old' }]);
    const results = await Promise.all(Array.from({ length: 6 }, () => ensureBuiltinPackage('example', 'group', [skill])));
    expect(results.every(result => result.path === first.path)).toBe(true);
    expect(results.filter(result => result.changed)).toHaveLength(1);
    await expect(stat(join(first.path, 'skills', 'old', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(join(first.path, 'skills', 'old'))).isDirectory()).toBe(true);
  });
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('propagates writes rejected by a read-only directory', async () => {
    const { ensureBuiltinPackage, skill } = await setup();
    const first = await ensureBuiltinPackage('example', 'group', [skill]);
    const directory = join(first.path, 'skills', skill.name);
    await chmod(directory, 0o555);
    try { await expect(ensureBuiltinPackage('example', 'group', [{ ...skill, body: 'changed' }])).rejects.toMatchObject({ code: 'EACCES' }); }
    finally { await chmod(directory, 0o700); }
  });
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('finds the whole package a failed rewrite left in place', async () => {
    const { completeBuiltinPackage, ensureBuiltinPackage, skill } = await setup();
    const first = await ensureBuiltinPackage('example', 'group', [skill]);
    const directory = join(first.path, 'skills', skill.name);
    await chmod(directory, 0o555);
    try {
      await expect(ensureBuiltinPackage('example', 'group', [{ ...skill, body: 'changed' }])).rejects.toMatchObject({ code: 'EACCES' });
      expect(await completeBuiltinPackage('example', 'group')).toBe(first.path);
    } finally { await chmod(directory, 0o700); }
  });
  it('finds no package unless the manifest and a SKILL.md are there', async () => {
    const { completeBuiltinPackage, ensureBuiltinPackage, skill } = await setup();
    expect(await completeBuiltinPackage('example', 'group')).toBeUndefined();
    const first = await ensureBuiltinPackage('example', 'group', [skill]);
    expect(await completeBuiltinPackage('example', 'group')).toBe(first.path);
    expect(await completeBuiltinPackage('example', 'dm')).toBeUndefined();
    // A first write that stopped before the manifest; a directory in its place is no manifest either.
    const manifest = join(first.path, '.claude-plugin', 'plugin.json');
    await unlink(manifest);
    expect(await completeBuiltinPackage('example', 'group')).toBeUndefined();
    await mkdir(manifest);
    expect(await completeBuiltinPackage('example', 'group')).toBeUndefined();
    await rmdir(manifest);
    // Every SKILL.md removed, the directories kept; a directory named SKILL.md is no skill.
    await ensureBuiltinPackage('example', 'group', []);
    expect(await completeBuiltinPackage('example', 'group')).toBeUndefined();
    await mkdir(join(first.path, 'skills', skill.name, 'SKILL.md'));
    expect(await completeBuiltinPackage('example', 'group')).toBeUndefined();
  });
  it('rejects duplicate and escaping names before writing', async () => {
    const { ensureBuiltinPackage, skill } = await setup();
    const { botPaths } = await import('../src/config/paths');
    await expect(ensureBuiltinPackage('example', 'group', [skill, skill])).rejects.toThrow('duplicate');
    await expect(stat(botPaths('example').builtinPackage('group'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(ensureBuiltinPackage('example', 'group', [{ ...skill, name: '../escape' }])).rejects.toThrow('Invalid');
    await expect(stat(botPaths('example').builtinPackage('group'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('validates name and description limits without creating a package', async () => {
    const { ensureBuiltinPackage, skill } = await setup();
    const { botPaths } = await import('../src/config/paths');
    for (const invalid of [
      { ...skill, name: 'a'.repeat(65) },
      { ...skill, description: 'line\nbreak' },
      { ...skill, description: 'line\rbreak' },
      { ...skill, description: 'x'.repeat(1025) },
    ]) {
      await expect(ensureBuiltinPackage('example', 'group', [invalid])).rejects.toThrow();
      await expect(stat(botPaths('example').builtinPackage('group'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(ensureBuiltinPackage('example', 'group', [{ ...skill, description: '' }])).rejects.toThrow('描述不能为空');
    await expect(ensureBuiltinPackage('example', 'group', [{ ...skill, description: '  ' }])).rejects.toThrow('描述不能为空');
    await expect(stat(botPaths('example').builtinPackage('group'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await ensureBuiltinPackage('example', 'group', [{ ...skill, name: 'a'.repeat(64), description: 'x'.repeat(1024) }])).changed).toBe(true);
  });
  it('lets a queued valid call proceed after a rejection', async () => {
    const { ensureBuiltinPackage, skill } = await setup();
    const results = await Promise.allSettled([
      ensureBuiltinPackage('example', 'group', [{ ...skill, description: '' }]),
      ensureBuiltinPackage('example', 'group', [skill]),
    ]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
  });

});
