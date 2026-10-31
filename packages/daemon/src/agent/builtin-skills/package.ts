import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
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
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  if (created !== undefined) await chmod(path, 0o700);
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

const isFile = (path: string): Promise<boolean> => stat(path).then(info => info.isFile(), () => false);

/**
 * The package already at the stable path when it holds its plugin manifest and at least one SKILL.md, else undefined.
 * Each file is renamed into place whole, so such a package may be older than this daemon's skills but never half
 * written; a session whose rewrite failed can still be handed it (T4b).
 */
export async function completeBuiltinPackage(appId: string, set: 'group' | 'dm'): Promise<string | undefined> {
  const path = botPaths(appId).builtinPackage(set);
  if (!await isFile(join(path, '.claude-plugin', 'plugin.json'))) return undefined;
  const skills = await readdir(join(path, 'skills'), { withFileTypes: true }).catch(() => []);
  for (const entry of skills) {
    if (entry.isDirectory() && await isFile(join(path, 'skills', entry.name, 'SKILL.md'))) return path;
  }
  return undefined;
}

const pendingPackages = new Map<string, Promise<unknown>>();

export async function ensureBuiltinPackage(
  appId: string, set: 'group' | 'dm', skills: BuiltinSkill[],
): Promise<{ path: string; changed: boolean }> {
  const key = botPaths(appId).builtinPackage(set);
  const previous = pendingPackages.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => writeBuiltinPackage(appId, set, skills));
  pendingPackages.set(key, pending);
  try { return await pending; }
  finally {
    if (pendingPackages.get(key) === pending) pendingPackages.delete(key);
  }
}

async function writeBuiltinPackage(
  appId: string, set: 'group' | 'dm', skills: BuiltinSkill[],
): Promise<{ path: string; changed: boolean }> {
  const names = new Set<string>();
  for (const skill of skills) {
    if (skill.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || names.has(skill.name)) {
      throw new Error(`Invalid or duplicate builtin skill name: ${skill.name}`);
    }
    if (!skill.description.trim()) throw new Error('描述不能为空');
    if (skill.description.length > 1024) throw new Error('描述不能超过 1024 字');
    if (/[\r\n]/.test(skill.description)) {
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
      try {
        await unlink(oldFile);
        changed = true;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  }
  if (await updateFile(join(pluginPath, 'plugin.json'), `${JSON.stringify({ name: 'vonvon', version }, null, 2)}\n`)) changed = true;
  return { path, changed };
}
