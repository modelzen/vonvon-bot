import {createHash, randomUUID} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, beforeEach, expect, it} from 'vitest';
import {z} from 'zod';
import {canonicalizeRichRecipeContent, digestRichRecipeContent, isSetupSkillName, type RecipeRichContent} from '@vonvon/protocol';
import {listProjectsIn, type Project} from '../src/project/registry';
import {managedGroupSkillProfile, managedGroupSkills, managedRecipeSkillPath, isManagedRecipeSkillPath} from '../src/recipe/group-skills';
import {stageRichRecipeGeneration} from '../src/recipe/rich-generation';
import {recipeSnapshot} from '../src/recipe/rich-merge';
import {codexSessionParams} from '../src/agent/codex-appserver/backend';
import {CodexAppServerBackend} from '../src/agent/codex-appserver/backend';
import {ClaudeAgentBackend} from '../src/agent/claude-agent/backend';
import {shutdownResidentClients} from '../src/agent/codex-appserver/client-pool';
import type {AgentThread} from '../src/agent/types';

let root: string;
beforeEach(async () => {root = await realpath(await mkdtemp(join(tmpdir(), 'managed-recipe-skills-')));});
afterEach(async () => {await rm(root, {recursive: true, force: true});});
const identity = () => ({itemId: randomUUID(), originId: randomUUID()});
const label = (value: string) => ({...identity(), value});
const managedGroupSkillPackages = async (...args: Parameters<typeof managedGroupSkillProfile>) => (await managedGroupSkillProfile(...args)).packages;
async function fixture(suffix = '') {
  const files = [
    {...identity(), name: 'setup/SKILL.md', use: 'skillDescription' as const, text: {kind: 'inline' as const, value: '---\nname: feedback-setup\ndescription: 检查所需工具和首次启动。\n---\nThe verification value is BASELINE_SETUP. Respond with the exact verification value.'}},
    {...identity(), name: 'feedback/SKILL.md', use: 'skillDescription' as const, text: {kind: 'inline' as const, value: '---\nname: feedback\ndescription: 整理并提交反馈。\n---\nThe verification value is FEEDBACK_ONLY' + suffix + '. Respond with the exact verification value.'}},
  ];
  const skills = files.map((file, index) => ({...identity(), name: index ? '整理并提交反馈' : '首次使用', entryFileId: file.itemId, fileIds: [file.itemId]}));
  const content: RecipeRichContent = {format: 'rich-v2', schemaVersion: 2,
    public: {name: label('反馈'), summary: label('测试'), overview: label('测试'), version: label('1')},
    settings: [], rules: [], skills, files, tasks: [], memories: [], setup: [], parts: [],
  };
  const canonical = canonicalizeRichRecipeContent(content);
  const release = {format: 'rich-v2' as const, recipeId: randomUUID(), versionId: randomUUID(), authorId: randomUUID(), revision: 1, access: 'direct' as const,
    contentSha256: await digestRichRecipeContent(canonical), logicalBytes: canonical.logicalBytes};
  const botDataRoot = join(root, 'bot');
  await mkdir(botDataRoot);
  const effectiveFiles = files.map((file, index) => index ? file : {...file, text: {kind: 'inline' as const, value: file.text.value.replace('BASELINE_SETUP', 'LOCAL_SETUP' + suffix)}});
  const staged = await stageRichRecipeGeneration({botDataRoot, installationId: randomUUID(), generationId: randomUUID(), release,
    canonicalUTF8: canonical.canonicalUTF8, readMember: async () => {throw new Error('No members');}, effectiveSkills: {skills, files: effectiveFiles}});
  const bindingIncarnation = randomUUID();
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  const group: Project = {name: '反馈群', chatId: 'oc_fixture', cwd, createdAt: 1, blank: false, bindingIncarnation,
    richRecipe: {pointer: staged.pointer, bindingIncarnation, resolved: recipeSnapshot({...content, files: effectiveFiles}, text => text.kind === 'inline' ? text.value : ''),
      sources: {}, choices: {}, setup: {}, installedAt: 1, receipt: randomUUID()}, skills: {disabledPaths: []},
  };
  return {group, botDataRoot, staged, skills, canonical, release, effectiveFiles};
}
async function packageText(path: string): Promise<string> {
  const texts: string[] = [];
  for (const entry of await readdir(path, {withFileTypes: true})) {
    const file = join(path, entry.name);
    texts.push(entry.isDirectory() ? await packageText(file) : await readFile(file, 'utf8'));
  }
  return texts.join('\n');
}

it('lists verified effective skills under accurate entry names with stable workspace selectors', async () => {
  const {group, botDataRoot, skills} = await fixture();
  const inventory = await managedGroupSkills(group, botDataRoot);
  expect(inventory.map(skill => skill.name)).toEqual(['feedback-setup', 'feedback']);
  expect(inventory.map(skill => skill.source)).toEqual(['workspace', 'workspace']);
  expect(inventory[0]?.description).toBe('检查所需工具和首次启动。');
  expect(isSetupSkillName(inventory[0]!.name)).toBe(true);
  expect(inventory[0]?.path).toBe(managedRecipeSkillPath(group.richRecipe!.pointer.installationId, skills[0]!.itemId));
  expect(isManagedRecipeSkillPath(inventory[0]!.path)).toBe(true);
  group.skills = {disabledPaths: [inventory[0]!.path]};
  expect((await managedGroupSkills(group, botDataRoot)).map(skill => ({path: skill.path, enabled: skill.enabled}))).toEqual([
    {path: inventory[0]!.path, enabled: false}, {path: inventory[1]!.path, enabled: true},
  ]);
});

it('projects enabled skills into a verified package and preserves the installed generation and builtin delivery', async () => {
  const {group, botDataRoot, staged, skills} = await fixture();
  const original = await packageText(staged.nativePackage!.path);
  const pointer = structuredClone(group.richRecipe!.pointer);
  group.skills = {disabledPaths: [managedRecipeSkillPath(pointer.installationId, skills[0]!.itemId)]};
  const [packages, repeated] = await Promise.all([managedGroupSkillPackages(group, botDataRoot), managedGroupSkillPackages(group, botDataRoot)]);
  expect(packages).toEqual(repeated);
  expect(packages).toHaveLength(1);
  const pkg = packages[0]!;
  expect(pkg.kind).toBe('recipe');
  if (pkg.kind !== 'recipe') throw new Error('Expected managed package');
  expect(pkg.skills).toEqual([expect.objectContaining({itemId: skills[1]!.itemId, qualifiedName: `vonvon-recipe:r-${skills[1]!.itemId}`})]);
  expect(await readdir(join(pkg.path, 'skills'))).toEqual([`r-${skills[1]!.itemId}`]);
  expect(await packageText(pkg.path)).toContain('FEEDBACK_ONLY');
  expect(await packageText(pkg.path)).not.toMatch(/LOCAL_SETUP|BASELINE_SETUP|feedback-setup/);
  expect(group.richRecipe!.pointer).toEqual(pointer);
  expect(await packageText(staged.nativePackage!.path)).toBe(original);
  const delivery = await managedGroupSkillProfile(group, botDataRoot);
  expect(delivery.instructions).toContain('"name":"feedback"');
  expect(delivery.instructions).toContain(`vonvon-recipe:r-${skills[1]!.itemId}`);
  expect(delivery.instructions).not.toContain('feedback-setup');
  const parent = join(botDataRoot, 'recipe-generations', pointer.installationId);
  await chmod(parent, 0o500);
  try {expect(await managedGroupSkillPackages(group, botDataRoot)).toEqual(packages);}
  finally {await chmod(parent, 0o700);}
  const builtin = join(root, 'builtin');
  await mkdir(builtin);
  const params = codexSessionParams({cwd: root, mode: 'qa', profile: {instructions: '', env: {}, nativeSettings: {automaticMemory: false}, additionalRoots: [],
    capabilityPackages: [{kind: 'builtin', path: builtin}, ...packages], mcpServers: []}}, null, null);
  expect(params.selectedCapabilityRoots).toEqual([
    {id: 'vonvon-builtin', location: {type: 'environment', environmentId: 'local', path: builtin}},
    {id: 'vonvon-recipe', location: {type: 'environment', environmentId: 'local', path: pkg.path}},
  ]);
});

it('uses a distinct derived slot for a new release with identical content', async () => {
  const x = await fixture();
  x.group.skills = {disabledPaths: [managedRecipeSkillPath(x.staged.pointer.installationId, x.skills[0]!.itemId)]};
  const first = await managedGroupSkillPackages(x.group, x.botDataRoot);
  const updated = await stageRichRecipeGeneration({botDataRoot: x.botDataRoot, installationId: x.staged.pointer.installationId,
    generationId: randomUUID(), release: {...x.release, versionId: randomUUID(), revision: 2}, canonicalUTF8: x.canonical.canonicalUTF8,
    readMember: async () => {throw new Error('No members');}, effectiveSkills: {skills: x.skills, files: x.effectiveFiles}});
  expect(updated.pointer.resolvedSha256).toBe(x.staged.pointer.resolvedSha256);
  x.group.richRecipe!.pointer = updated.pointer;
  const next = await managedGroupSkillPackages(x.group, x.botDataRoot);
  expect(next[0]?.path).not.toBe(first[0]?.path);
  expect(await packageText(next[0]!.path)).toBe(await packageText(first[0]!.path));
});

it('retains local effective bytes and delivers no managed package when all are disabled', async () => {
  const {group, botDataRoot} = await fixture();
  const enabled = await managedGroupSkillPackages(group, botDataRoot);
  expect(await packageText(enabled[0]!.path)).toContain('LOCAL_SETUP');
  expect(await packageText(enabled[0]!.path)).not.toContain('BASELINE_SETUP');
  const inventory = await managedGroupSkills(group, botDataRoot);
  group.skills = {disabledPaths: inventory.map(skill => skill.path)};
  expect(await managedGroupSkillPackages(group, botDataRoot)).toEqual([]);
  expect((await managedGroupSkills(group, botDataRoot)).every(skill => !skill.enabled)).toBe(true);
});

it('rejects stale bindings, altered resolved bytes and corrupted native packages', async () => {
  const {group, botDataRoot, staged, skills} = await fixture();
  const binding = group.bindingIncarnation;
  group.bindingIncarnation = randomUUID();
  await expect(managedGroupSkills(group, botDataRoot)).rejects.toThrow('binding');
  group.bindingIncarnation = binding;
  const file = group.richRecipe!.resolved.find(item => item.kind === 'files')!;
  const original = file.value.text;
  file.value.text = 'UNVERIFIED';
  await expect(managedGroupSkillPackages(group, botDataRoot)).rejects.toThrow('document changed');
  file.value.text = original;
  const wrapper = join(staged.nativePackage!.path, 'skills', `r-${skills[0]!.itemId}`, 'SKILL.md');
  await chmod(wrapper, 0o600);
  await writeFile(wrapper, 'corrupt');
  await expect(managedGroupSkillPackages(group, botDataRoot)).rejects.toThrow();
});

it('leaves ordinary groups untouched', async () => {
  const group = {bindingIncarnation: randomUUID()};
  expect(await managedGroupSkills(group, root)).toEqual([]);
  expect(await managedGroupSkillPackages(group, root)).toEqual([]);
});

it.runIf(Boolean(process.env.RECIPE_INSTALLED_BOT_ROOT))('reads the installed acceptance recipe inventory without changing its group configuration', async () => {
  const botDataRoot = process.env.RECIPE_INSTALLED_BOT_ROOT;
  const groupId = process.env.RECIPE_INSTALLED_GROUP_ID;
  if (!botDataRoot || !groupId) throw new Error('Specify the isolated acceptance Bot and exact group');
  const file = join(botDataRoot, 'projects.json');
  const before = await readFile(file);
  const group = (await listProjectsIn(file)).find(row => row.chatId === groupId);
  if (!group?.richRecipe) throw new Error('Expected installed acceptance recipe');
  const skills = await managedGroupSkills(group, botDataRoot);
  expect(skills.map(skill => skill.name).sort()).toEqual(['feedback', 'feedback-setup']);
  expect(skills.every(skill => skill.source === 'workspace')).toBe(true);
  expect(await readFile(file)).toEqual(before);
  if (process.env.RECIPE_INSTALLED_EVIDENCE) await writeFile(process.env.RECIPE_INSTALLED_EVIDENCE, JSON.stringify({
    scope: 'read-only-installed-acceptance-inventory', groupId, generationId: group.richRecipe.pointer.generationId,
    installationId: group.richRecipe.pointer.installationId, skills,
    projectsSha256Before: createHash('sha256').update(before).digest('hex'),
    projectsSha256After: createHash('sha256').update(await readFile(file)).digest('hex'),
  }, null, 2) + '\n');
});

for (const provider of ['codex', 'claude'] as const) {
  it.runIf(process.env.RECIPE_GROUP_SKILL_SMOKE === provider)(`${provider} invokes the enabled managed skill by its UI name across fresh sessions`, async () => {
    if (!process.env.VONVON_HOME || !process.env.HOME) throw new Error('Use an isolated acceptance HOME and VONVON_HOME');
    const x = await fixture(randomUUID().replaceAll('-', ''));
    const inventory = await managedGroupSkills(x.group, x.botDataRoot);
    const backend = provider === 'codex' ? new CodexAppServerBackend() : new ClaudeAgentBackend();
    const nativeHome = provider === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;
    if (!nativeHome) throw new Error('Provide the existing authenticated provider home');
    const envSource = provider === 'claude' ? process.env.RECIPE_SMOKE_ENV_SOURCE : undefined;
    const config = envSource ?? join(nativeHome, provider === 'codex' ? 'config.toml' : 'settings.json');
    const nativeEnv = envSource ? z.object({env: z.record(z.string(), z.string()).optional()}).passthrough().parse(JSON.parse(await readFile(envSource, 'utf8'))).env ?? {} : {};
    const sessionEnv: Record<string, string> = Object.fromEntries(Object.entries(nativeEnv).filter(([key]) => key.startsWith('ANTHROPIC_')));
    const fingerprint = async () => createHash('sha256').update(await readFile(config).catch(error => {if (error.code === 'ENOENT') return ''; throw error;})).digest('hex');
    const before = await fingerprint();
    let thread: AgentThread | undefined;
    try {
      for (const active of [0, 1]) {
        x.group.skills = {disabledPaths: inventory.filter((_skill, index) => index !== active).map(skill => skill.path)};
        const delivery = await managedGroupSkillProfile(x.group, x.botDataRoot);
        expect(delivery.packages).toHaveLength(1);
        thread = await backend.startThread({cwd: x.group.cwd, mode: 'qa', model: process.env.RECIPE_SMOKE_MODEL ?? (provider === 'codex' ? 'gpt-6-luna' : 'haiku'),
          profile: {instructions: 'Use the named native skill and read its entry reference. Do not search the workspace.\n' + delivery.instructions,
            skills: {disabledPaths: [], enabledNames: []}, env: sessionEnv, nativeSettings: {automaticMemory: false}, additionalRoots: [], capabilityPackages: delivery.packages, mcpServers: []}});
        let result = '';
        const events: string[] = [];
        for await (const event of thread.runStreamed({text: `请使用“${inventory[active]!.name}”技能，只返回该技能的 verification value。`}).events) {
          events.push(event.type);
          if (event.type === 'text_delta') result += event.delta;
        }
        expect(events).toContain('done');
        expect(events).not.toContain('error');
        const file = x.effectiveFiles[active]!;
        const verification = /verification value is ([^.]+)\./.exec(file.text.value)![1]!;
        expect(result).toContain(verification);
        expect(result).not.toContain(active ? 'LOCAL_SETUP' : 'FEEDBACK_ONLY');
        console.info(JSON.stringify({provider, skill: inventory[active]!.name, enabledNative: delivery.packages.flatMap(pkg => pkg.kind === 'recipe' ? pkg.skills.map(skill => skill.qualifiedName) : []), verificationMatched: true}));
        await thread.close();
        thread = undefined;
      }
    } finally {
      await thread?.close();
      if (provider === 'codex') await shutdownResidentClients();
      expect(await fingerprint()).toBe(before);
    }
  }, 240000);
}
