import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
  const { ensureBuiltinPackage } = await import('../src/agent/builtin-skills/package');
  const { scheduledTasksSkill } = await import('../src/agent/builtin-skills/scheduled-tasks');
  return { ensureBuiltinPackage, skill: scheduledTasksSkill };
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
    expect(text).toContain(`description: "${skill.description}"`);
    const before = await Promise.all([stat(plugin), stat(file)]);
    expect(await ensureBuiltinPackage('example', 'group', [skill])).toEqual({ ...first, changed: false });
    expect((await stat(plugin)).mtimeMs).toBe(before[0]!.mtimeMs);
    expect((await stat(file)).mtimeMs).toBe(before[1]!.mtimeMs);
    if (process.platform !== 'win32') {
      for (const directory of [first.path, join(first.path, 'skills'), join(first.path, 'skills', skill.name), join(first.path, '.claude-plugin')]) {
        expect((await stat(directory)).mode & 0o777).toBe(0o755);
      }
      for (const path of [plugin, file]) expect((await stat(path)).mode & 0o777).toBe(0o644);
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
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('propagates writes rejected by a read-only directory', async () => {
    const { ensureBuiltinPackage, skill } = await setup();
    const first = await ensureBuiltinPackage('example', 'group', [skill]);
    const directory = join(first.path, 'skills', skill.name);
    await chmod(directory, 0o555);
    try { await expect(ensureBuiltinPackage('example', 'group', [{ ...skill, body: 'changed' }])).rejects.toMatchObject({ code: 'EACCES' }); }
    finally { await chmod(directory, 0o755); }
  });
  it('rejects duplicate and escaping names before writing', async () => {
    const { ensureBuiltinPackage, skill } = await setup();
    await expect(ensureBuiltinPackage('example', 'group', [skill, skill])).rejects.toThrow('duplicate');
    await expect(ensureBuiltinPackage('example', 'group', [{ ...skill, name: '../escape' }])).rejects.toThrow('Invalid');
  });
});
