import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { botPaths } from '../../config/paths';

export interface BuiltinSkill {
  name: string;
  title: string;
  description: string;
  body: string;
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o755 });
  if (created !== undefined) await chmod(path, 0o755);
}

async function updateFile(path: string, content: string): Promise<boolean> {
  if (await readIfPresent(path) === content) {
    await chmod(path, 0o644);
    return false;
  }
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o644 });
    await chmod(temporary, 0o644);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return true;
}

export async function ensureBuiltinPackage(
  appId: string, set: 'group' | 'dm', skills: BuiltinSkill[],
): Promise<{ path: string; changed: boolean }> {
  const names = new Set<string>();
  for (const skill of skills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || names.has(skill.name)) {
      throw new Error(`Invalid or duplicate builtin skill name: ${skill.name}`);
    }
    if (!skill.description || /[\r\n]/.test(skill.description)) {
      throw new Error(`Builtin skill description must be one line: ${skill.name}`);
    }
    names.add(skill.name);
  }
  const bot = botPaths(appId);
  const path = bot.builtinPackage(set);
  const skillsPath = join(path, 'skills');
  const pluginPath = join(path, '.claude-plugin');
  for (const directory of [bot.capabilities, join(bot.capabilities, 'builtin'), path, skillsPath, pluginPath]) await ensureDirectory(directory);
  const files = skills.map((skill) => ({
    name: skill.name,
    content: `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}\n`,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const version = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12);
  let changed = false;
  for (const file of files) {
    const directory = join(skillsPath, file.name);
    await ensureDirectory(directory);
    if (await updateFile(join(directory, 'SKILL.md'), file.content)) changed = true;
  }
  for (const entry of await readdir(skillsPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || names.has(entry.name)) continue;
    const oldFile = join(skillsPath, entry.name, 'SKILL.md');
    if (await readIfPresent(oldFile) !== undefined) {
      await unlink(oldFile);
      changed = true;
    }
  }
  if (await updateFile(join(pluginPath, 'plugin.json'), `${JSON.stringify({ name: 'vonvon', version }, null, 2)}\n`)) changed = true;
  return { path, changed };
}
