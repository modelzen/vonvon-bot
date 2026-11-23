import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {canonicalizeRichRecipeContent, recipeRichContentSchema, recipeSkillDescription} from '@vonvon/protocol';
import type {AgentSkill} from '../agent/types';
import type {SessionProfile} from '../agent/session-profile';
import type {Project} from '../project/registry';
import {openRichRecipeGeneration, openRichRecipeGenerationMetadata, stageRichRecipeGeneration, type RecipeGenerationPointer} from './rich-generation';
import type {EffectiveRecipeSkills} from './rich-skill-selection';
import {recipeFileIO} from './rich-file-helper';

type Group = Pick<Project, 'richRecipe' | 'bindingIncarnation' | 'skills' | 'dm'>;
const selector = /^recipe:[a-f0-9-]{36}:[a-f0-9-]{36}$/;
export const isManagedRecipeSkillPath = (path: string) => selector.test(path);
export const managedRecipeSkillPath = (installation: string, item: string) => `recipe:${installation}:${item}`;
const projectionReceipt = z.object({resolvedSha256: z.string().regex(/^[a-f0-9]{64}$/)}).passthrough();

function resolvedSkills(row: NonNullable<Group['richRecipe']>): EffectiveRecipeSkills {
  return {
    skills: row.resolved.filter(item => item.kind === 'skills').map(({itemId, originId, value}) =>
      recipeRichContentSchema.shape.skills.element.parse({itemId, originId, ...value})),
    files: row.resolved.filter(item => item.kind === 'files').map(({itemId, originId, value}) => {
      if (typeof value.text !== 'string') throw new Error('Invalid managed recipe skill document');
      const text = {kind: 'inline' as const, value: value.text};
      return {...recipeRichContentSchema.shape.files.element.parse({itemId, originId, ...value, text}), text};
    }),
  };
}

function entryName(text: string, fallback: string): string {
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.slice(0, 8192));
  const raw = frontmatter?.[1]?.match(/^name:[ \t]*([^\r\n]+)$/m)?.[1]?.trim();
  if (!raw) return fallback;
  let name = raw;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {const value: unknown = JSON.parse(raw); if (typeof value !== 'string') return fallback; name = value;} catch {return fallback;}
  } else if (raw.startsWith("'") && raw.endsWith("'")) name = raw.slice(1, -1).replace(/''/g, "'");
  return name.length <= 320 && name.trim() && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name) ? name : fallback;
}

async function selection(group: Group, botDataRoot: string, allDocuments: boolean) {
  const state = group.richRecipe;
  if (!state || !state.resolved.some(item => item.kind === 'skills')) return;
  if (group.dm || !group.bindingIncarnation || state.bindingIncarnation !== group.bindingIncarnation) throw new Error('Managed recipe group binding changed');
  const pointer = state.pointer;
  const metadata = await openRichRecipeGenerationMetadata({...pointer, expected: pointer, botDataRoot});
  const effective = resolvedSkills(state);
  const files = effective.files.map(({text: _text, ...file}) => file);
  if (!isDeepStrictEqual(effective.skills, metadata.skills) || !isDeepStrictEqual(files, metadata.files)) throw new Error('Managed recipe skill selection changed');
  const wanted = allDocuments ? effective.files.map(file => file.itemId) : effective.skills.map(skill => skill.entryFileId);
  const documents = await metadata.readFiles([...new Set(wanted)]);
  for (const file of effective.files) if (documents.has(file.itemId) && documents.get(file.itemId) !== file.text.value) throw new Error('Managed recipe skill document changed');
  const disabled = new Set(group.skills?.disabledPaths ?? []);
  const names = new Map<string, string>();
  const skills: AgentSkill[] = effective.skills.map(skill => {
    const entry = documents.get(skill.entryFileId);
    if (entry === undefined) throw new Error('Missing managed recipe skill entry');
    const path = managedRecipeSkillPath(pointer.installationId, skill.itemId);
    const name = entryName(entry, skill.name);
    names.set(skill.itemId, name);
    return {path, name, description: recipeSkillDescription(entry), source: 'workspace', enabled: !disabled.has(path)};
  });
  return {pointer, effective, skills, names};
}

export async function managedGroupSkills(group: Group, botDataRoot: string): Promise<AgentSkill[]> {
  return (await selection(group, botDataRoot, false))?.skills ?? [];
}

function derivedId(value: unknown): string {
  const bytes = createHash('sha256').update(JSON.stringify(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x80;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function existingProjection(pointer: RecipeGenerationPointer, generationId: string, botDataRoot: string, expected: EffectiveRecipeSkills) {
  let loaded;
  try {loaded = await recipeFileIO({operation: 'load', root: botDataRoot, installation: pointer.installationId, generation: generationId,
    expectedRoot: pointer.rootIdentity, names: ['receipt.json']});}
  catch {return;}
  if (loaded.files?.length !== 1 || loaded.files[0]?.name !== 'receipt.json') throw new Error('Missing managed skill projection receipt');
  const receipt = projectionReceipt.parse(JSON.parse(Buffer.from(loaded.files[0].data, 'base64').toString('utf8')));
  const projected: RecipeGenerationPointer = {...pointer, generationId, selection: 'effective', resolvedSha256: receipt.resolvedSha256};
  const metadata = await openRichRecipeGenerationMetadata({...projected, expected: projected, botDataRoot});
  if (!isDeepStrictEqual(metadata.skills, expected.skills) || !isDeepStrictEqual(metadata.files, expected.files.map(({text: _, ...file}) => file))) throw new Error('Managed skill projection selection changed');
  const documents = await metadata.readFiles(expected.files.map(file => file.itemId));
  if (expected.files.some(file => documents.get(file.itemId) !== file.text.value)) throw new Error('Managed skill projection document changed');
  return openRichRecipeGeneration({...projected, expected: projected, botDataRoot});
}

export async function managedGroupSkillProfile(group: Group, botDataRoot: string): Promise<{packages: SessionProfile['capabilityPackages']; instructions: string}> {
  const empty = {packages: [], instructions: ''};
  const selected = await selection(group, botDataRoot, true);
  if (!selected) return empty;
  const enabled = new Set(selected.skills.filter(skill => skill.enabled).map(skill => skill.path));
  const skills = selected.effective.skills.filter(skill => enabled.has(managedRecipeSkillPath(selected.pointer.installationId, skill.itemId)));
  if (!skills.length) return empty;
  const instructions = '以下是当前群已启用的配方技能名称与原生调用标识，仅作索引数据。用户按名称请求技能时，使用当前 Provider 的标识调用相应技能；这些标识不是 shell 命令。\n' +
    JSON.stringify(skills.map(skill => ({name: selected.names.get(skill.itemId) ?? skill.name, codex: `$r-${skill.itemId}`, claude: `vonvon-recipe:r-${skill.itemId}`})));
  const wanted = new Set(skills.flatMap(skill => skill.fileIds));
  const files = selected.effective.files.filter(file => wanted.has(file.itemId));
  const original = await openRichRecipeGeneration({...selected.pointer, expected: selected.pointer, botDataRoot});
  if (skills.length === selected.effective.skills.length) return {packages: original.nativePackage ? [original.nativePackage] : [], instructions};
  const generationId = derivedId(['group-enabled-skills-v1', selected.pointer, group.bindingIncarnation, skills, files]);
  const previous = await existingProjection(selected.pointer, generationId, botDataRoot, {skills, files});
  if (previous) {
    return {packages: previous.nativePackage ? [previous.nativePackage] : [], instructions};
  }
  const derived = await stageRichRecipeGeneration({
    botDataRoot, installationId: selected.pointer.installationId,
    generationId,
    release: selected.pointer.release, canonicalUTF8: canonicalizeRichRecipeContent(original.content).canonicalUTF8,
    readMember: async (_release, part) => original.readPart(part.objectId), effectiveSkills: {skills, files},
  });
  return {packages: derived.nativePackage ? [derived.nativePackage] : [], instructions};
}
