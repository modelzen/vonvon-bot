import type { AgentBackend, AgentSkill } from './types';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { claudeConfigDir } from './claude-agent/configured-model';
import { NATIVE_SCHEDULING_SKILLS } from './claude-agent/thread';
import { builtinSkillFilePath, ensureBuiltinPackage, renderBuiltinSkillMarkdown } from './builtin-skills/package';
import { builtinSkillSelector, builtinSkillsOfSet, isBuiltinSkillSelector } from './builtin-skills/registry';

/** VonVon's own built-in skills for a group or DM, with real local SKILL.md paths on disk. */
export async function discoverBuiltinGroupSkills(input: {
  appId: string; set: 'group' | 'dm'; disabledPaths?: readonly string[];
}): Promise<AgentSkill[]> {
  const skills = builtinSkillsOfSet(input.set);
  await ensureBuiltinPackage(input.appId, input.set, skills).catch(() => undefined);
  const disabled = new Set(input.disabledPaths ?? []);
  return skills.map(skill => {
    const path = builtinSkillSelector(skill.name);
    return {
      path,
      name: skill.name,
      description: skill.description,
      source: 'builtin',
      enabled: !disabled.has(path),
      location: builtinSkillFilePath(input.appId, input.set, skill.name),
      content: renderBuiltinSkillMarkdown(skill),
    };
  });
}

/** A partial, read-only inventory for stopped Bots. Native plugins need a running provider. */
export async function discoverLocalGroupSkills(input: {
  backendId: string; cwd: string; directories?: string[]; disabledPaths?: readonly string[];
  /** Filesystem-only dependency injection for tests. */
  home?: string; env?: NodeJS.ProcessEnv;
}): Promise<AgentSkill[]> {
  const claude = input.backendId === 'claude-agent';
  if (!claude && input.backendId !== 'codex-appserver') throw new Error('当前 Provider 无法读取本地技能');
  const home = input.home ?? homedir();
  const env = input.env ?? process.env;
  const nativeHome = claude ? claudeConfigDir(env, home) : env.CODEX_HOME || join(home, '.codex');
  const disabled = new Set(input.disabledPaths ?? []);
  if (!claude) {
    const file = join(nativeHome, 'config.toml');
    const content = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (content) {
      const configured = parseToml(content).skills;
      if (configured && typeof configured === 'object' && !Array.isArray(configured) && 'config' in configured && Array.isArray(configured.config)) {
        for (const value of configured.config) {
          if (value && typeof value === 'object' && !Array.isArray(value) && 'enabled' in value && 'path' in value && value.enabled === false && typeof value.path === 'string') {
            const path = value.path;
            disabled.add(path);
            disabled.add(await realpath(path).catch(() => path));
          }
        }
      }
    }
  }
  const found = new Map<string, AgentSkill>();
  const visited = new Set<string>();
  let count = 0;
  const scalar = (value: string) => value.trim().replace(/^(['"])([\s\S]*)\1$/u, '$2');
  async function inspect(file: string, source: 'workspace' | 'user' | 'system', fallback: string, command: boolean) {
    const entry = await stat(file).catch(() => undefined);
    if (!entry?.isFile() || entry.size > 128 * 1024) return;
    const content = await readFile(file, 'utf8');
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
    if (!frontmatter && !command) return;
    const name = scalar(frontmatter?.match(/^name:\s*(.+)$/mu)?.[1] ?? fallback);
    const rawDescription = frontmatter?.match(/^description:\s*(.+)$/mu)?.[1] ?? '';
    const description = /^[>|][-+]?\s*$/u.test(rawDescription)
      ? (frontmatter?.match(/^description:[^\n]*\n((?:[ \t]+[^\n]*(?:\n|$))*)/mu)?.[1] ?? '').trim().replace(/\s+/gu, ' ')
      : scalar(rawDescription);
    if (!name || (!description && !command)) return;
    const realFile = await realpath(file);
    const path = claude ? `claude:${name}` : realFile;
    found.set(path, { path, name, description, source, enabled: !disabled.has(path), ...(claude ? { location: realFile } : {}) });
  }
  async function scan(root: string, source: 'workspace' | 'user' | 'system', command = false, path = root, depth = 0): Promise<void> {
    if (depth > 6) return;
    const canonical = await realpath(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!canonical || visited.has(canonical)) return;
    visited.add(canonical);
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (++count > 4096) throw new Error('本地技能目录过大，请启动 Bot 后读取完整目录');
      const next = join(path, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink() && (await stat(next).catch(() => undefined))?.isDirectory()) await scan(root, source, command, next, depth + 1);
      else if (entry.name === 'SKILL.md' || command && entry.name.endsWith('.md')) {
        const fallback = command ? relative(root, next).replace(/\.md$/u, '').split(/[\\/]/u).join(':') : basename(dirname(next));
        await inspect(next, source, fallback, command);
      }
    }
  }
  if (!claude) await scan(join(nativeHome, 'skills', '.system'), 'system');
  await scan(join(nativeHome, 'skills'), 'user');
  if (claude) await scan(join(nativeHome, 'commands'), 'user', true);
  else await scan(join(home, '.agents', 'skills'), 'user');
  for (const workspace of new Set([input.cwd, ...input.directories ?? []])) {
    await scan(join(workspace, claude ? '.claude' : '.agents', 'skills'), 'workspace');
    if (claude) await scan(join(workspace, '.claude', 'commands'), 'workspace', true);
  }
  return [...found.values()];
}

/** Local workspace/user index used to attribute Claude SDK's flat `supportedCommands()` catalog. */
export async function scanClaudeLocalSkillSources(input: {
  cwd: string; directories?: string[]; home?: string; env?: NodeJS.ProcessEnv;
}): Promise<Map<string, { source: 'workspace' | 'user'; location: string }>> {
  const local = await discoverLocalGroupSkills({ backendId: 'claude-agent', ...input });
  const index = new Map<string, { source: 'workspace' | 'user'; location: string }>();
  for (const skill of local) {
    if ((skill.source === 'workspace' || skill.source === 'user') && skill.location) {
      index.set(skill.name, { source: skill.source, location: skill.location });
    }
  }
  return index;
}

/** Uses the provider's own inventory, including plugins and user configuration. */
export async function discoverGroupSkills(input: {
  backend: AgentBackend; cwd: string; directories?: string[]; disabledPaths?: readonly string[];
}): Promise<AgentSkill[]> {
  if (!input.backend.listSkills) throw new Error('当前 Provider 无法读取技能目录');
  const skills = await input.backend.listSkills({ cwd: input.cwd, directories: input.directories });
  const disabled = new Set(input.disabledPaths ?? []);
  return skills.map(skill => ({ ...skill, enabled: skill.enabled && !disabled.has(skill.path) }));
}

/** Omitted when no per-group provider override exists, preserving provider-native dynamic discovery. */
export async function groupSkillProfile(input: Parameters<typeof discoverGroupSkills>[0]) {
  const disabledPaths = input.disabledPaths ?? [];
  const providerDisabledPaths = disabledPaths.filter(path => !isBuiltinSkillSelector(path));
  const disabledBuiltinNames = disabledPaths.filter(isBuiltinSkillSelector);
  if (!providerDisabledPaths.length) return undefined;
  if (input.backend.id === 'codex-appserver') return { disabledPaths: providerDisabledPaths };
  const skills = await discoverGroupSkills({ ...input, disabledPaths: providerDisabledPaths });
  // Claude's native whitelist hides the skill and rejects Skill tool invocation. Its own scheduling skills stay out
  // of it as well as off in skillOverrides: whether a name on the whitelist beats 'off' is untested (3.13).
  return {
    disabledPaths: providerDisabledPaths,
    enabledNames: skills.filter(skill => skill.enabled && !NATIVE_SCHEDULING_SKILLS.includes(skill.name)).map(skill => skill.name),
    ...(disabledBuiltinNames.length ? { disabledBuiltinNames } : {}),
  };
}
