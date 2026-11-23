import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {
  decodeRichRecipeContent, recipeRichReleaseSchema, verifyRichRecipeRelease, type RecipeRichContent, type RecipeRichPartDescriptor,
  type RecipeRichRelease, type RecipeRichText,
} from '@vonvon/protocol';
import {recipeFileIO, type RecipeFileEntry} from './rich-file-helper';
import {selectRecipeSkills, restoreRecipeSelection, recipeSelectionMetadata, type EffectiveRecipeSkills, type RecipeSkillSelection} from './rich-skill-selection';
import {verifiedDocumentText} from './rich-source-files';
import {staticLogoFormat} from '../../../../services/recipe-api/src/logo-format.mjs';

interface Slot {botDataRoot: string; installationId: string; generationId: string}
export interface RecipeGenerationPointer {
  readonly format: 'recipe-generation-1'; readonly installationId: string; readonly generationId: string;
  readonly selection: 'baseline' | 'effective'; readonly rootIdentity: string; readonly release: Readonly<RecipeRichRelease>; readonly resolvedSha256: string;
}
type Pristine<T> = T extends (infer U)[] ? readonly Pristine<U>[] : T extends object ? {readonly [K in keyof T]: Pristine<T[K]>} : T;
export interface StagedRichRecipeGeneration {
  readonly pointer: RecipeGenerationPointer; readonly content: Pristine<RecipeRichContent>;
  readonly partIds: readonly string[];
  readonly nativePackage?: {readonly kind: 'recipe'; readonly path: string; readonly pluginId: 'vonvon-recipe';
    readonly skills: readonly {readonly itemId: string; readonly name: string; readonly qualifiedName: string}[]};
  readPart(objectId: string): Uint8Array; resolveText(text: RecipeRichText): string;
}
interface Stage extends Slot {
  effectiveSkills?: EffectiveRecipeSkills;
  release: RecipeRichRelease; canonicalUTF8: Uint8Array | string;
  readMember(release: Readonly<RecipeRichRelease>, member: Readonly<RecipeRichPartDescriptor>): Promise<Uint8Array>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function slotIO(slot: Slot) {
  if (!uuid.test(slot.installationId) || !uuid.test(slot.generationId)) throw new Error('Invalid recipe slot');
  return {root: slot.botDataRoot, installation: slot.installationId, generation: slot.generationId};
}
const digest = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
function pristine<T>(value: T): Pristine<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) pristine(child);
    Object.freeze(value);
  }
  return value as Pristine<T>;
}
function readText(text: RecipeRichText, parts: ReadonlyMap<string, string>): string {
  if (text.kind === 'inline') return text.value;
  const value = parts.get(text.objectId);
  if (value === undefined) throw new Error('Missing recipe text member');
  return value;
}
const nativeName = (id: string) => `r-${id}`;
type NativeFile = Omit<RecipeFileEntry,'data'> & ({data:string;text?:never}|{text:RecipeRichText;data?:never});
function nativeFilePlan(content: RecipeRichContent, version: string): Map<string,NativeFile> {
  const native = new Map<string,NativeFile>();
  const literal = (name: string, bytes: Buffer) => native.set(name,{name,bytes:bytes.length,sha256:digest(bytes),data:bytes.toString('base64')});
  if (!content.skills.length) return native;
  literal('native/.claude-plugin/plugin.json', Buffer.from(JSON.stringify({name: 'vonvon-recipe', version}) + '\n'));
  const files = new Map(content.files.map(file => [file.itemId, file]));
  const parts = new Map(content.parts.map(part => [part.objectId,part]));
  for (const skill of content.skills) {
    const name = nativeName(skill.itemId);
    const base = `native/skills/${name}`;
    const entry = files.get(skill.entryFileId)!;
    const references: string[] = [];
    const description = skill.name.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').trim() || name;
    for (const id of skill.fileIds) {
      const file = files.get(id)!;
      const identity = file.text.kind==='inline' ? {bytes:Buffer.byteLength(file.text.value),sha256:digest(file.text.value)} : parts.get(file.text.objectId)!;
      const local = `references/${identity.sha256}.txt`;
      const path = `${base}/${local}`;
      native.set(path,{name:path,bytes:identity.bytes,sha256:identity.sha256,text:file.text});
      references.push(`- ${JSON.stringify(file.name)}: ${local}${id === entry.itemId ? ' (entry document)' : ''}`);
    }
    const wrapper = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nRead the entry document for this skill. Read additional documents by their listed relative paths.\n\n${references.join('\n')}\n`;
    literal(`${base}/SKILL.md`, Buffer.from(wrapper));
  }
  return native;
}
function nativeFiles(content: RecipeRichContent, texts: ReadonlyMap<string,string>, version: string): Map<string,Buffer> {
  return new Map([...nativeFilePlan(content,version)].map(([name,file])=>[name,file.text ? Buffer.from(readText(file.text,texts)) : Buffer.from(file.data,'base64')]));
}
async function materialize(input: Stage, rootIdentity: string, selection?: RecipeSkillSelection) {
  const release = Object.freeze(recipeRichReleaseSchema.parse(input.release));
  const baseline = await verifyRichRecipeRelease(release, input.canonicalUTF8);
  const parts = new Map<string,Buffer>();
  const text = new Map<string,string>();
  const bytes = new Map<string,Buffer>([['manifest.json', Buffer.from(baseline.canonicalUTF8)]]);
  for (const descriptor of baseline.referencedParts) {
    const received = await input.readMember(release, Object.freeze({...descriptor}));
    if (!(received instanceof Uint8Array) || received.byteLength !== descriptor.bytes) throw new Error('Recipe member size mismatch');
    const data = Buffer.from(received);
    if (digest(data) !== descriptor.sha256) throw new Error('Recipe member digest mismatch');
    if (descriptor.kind === 'text') text.set(descriptor.objectId, verifiedDocumentText(data));
    else staticLogoFormat(data, true);
    parts.set(descriptor.objectId, data);
    bytes.set(`parts/${descriptor.objectId}`, data);
  }
  const content = baseline.content;
  if (content.tasks.some(task => !readText(task.instruction, text).trim())) throw new Error('Empty recipe task instruction');
  if (selection) {
    bytes.set('effective.json', Buffer.from(selection.graph.canonicalUTF8));
    for (const [id,data] of selection.documents) bytes.set(`effective/${id}`,data);
  }
  const skillContent = selection?.graph.content ?? content;
  const version = selection ? digest(selection.graph.canonicalUTF8) : release.contentSha256;
  for (const [path, data] of nativeFiles(skillContent, selection?.texts ?? text, version.slice(0,12))) bytes.set(path, data);
  const inventory = [...bytes].map(([name, data]) => ({name, bytes: data.length, sha256: digest(data)})).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const resolvedSha256 = digest(JSON.stringify(['recipe-files-v1', inventory]));
  const pointer: RecipeGenerationPointer = Object.freeze({format: 'recipe-generation-1', installationId: input.installationId, generationId: input.generationId, selection: selection ? 'effective' : 'baseline', rootIdentity, release, resolvedSha256});
  const receipt = Buffer.from(JSON.stringify(pointer));
  bytes.set('receipt.json', receipt);
  inventory.push({name: 'receipt.json', bytes: receipt.length, sha256: digest(receipt)});
  const descriptor: StagedRichRecipeGeneration = Object.freeze({pointer, content: pristine(content), partIds: Object.freeze([...parts.keys()]), ...(skillContent.skills.length ? {nativePackage: Object.freeze({pluginId: 'vonvon-recipe' as const, skills: Object.freeze(skillContent.skills.map(skill => Object.freeze({itemId: skill.itemId,name: nativeName(skill.itemId),qualifiedName: `vonvon-recipe:${nativeName(skill.itemId)}`}))), kind: 'recipe' as const, path: join(input.botDataRoot, 'recipe-generations', input.installationId, input.generationId, 'native')})} : {}),
    resolveText: (value: RecipeRichText) => readText(value, text),
    readPart: (id: string) => {const value = parts.get(id); if (!value) throw new Error('Unknown recipe member'); return Uint8Array.from(value);},
  });
  return {bytes, inventory, descriptor};
}
export async function stageRichRecipeGeneration(input: Stage): Promise<StagedRichRecipeGeneration> {
  const slot = {...input};
  if (typeof slot.canonicalUTF8 !== 'string') {
    if (!(slot.canonicalUTF8 instanceof Uint8Array) || slot.canonicalUTF8.byteLength > 1024*1024) throw new Error('Invalid recipe manifest bytes');
    slot.canonicalUTF8 = Uint8Array.from(slot.canonicalUTF8);
  }
  slot.release = recipeRichReleaseSchema.parse(slot.release);
  const selection = slot.effectiveSkills ? selectRecipeSkills(slot.effectiveSkills, decodeRichRecipeContent(slot.canonicalUTF8).content.public) : undefined;
  const address = slotIO(slot);
  const {root} = await recipeFileIO({...address, operation: 'identity'});
  const plan = await materialize(slot, root, selection);
  const entries: RecipeFileEntry[] = plan.inventory.map(entry => ({...entry, data: plan.bytes.get(entry.name)!.toString('base64')}));
  await recipeFileIO({...address, operation: 'stage', expectedRoot: root, entries});
  return plan.descriptor;
}
export async function openRichRecipeGeneration(input: Slot & {expected: RecipeGenerationPointer}): Promise<StagedRichRecipeGeneration> {
  const slot = {...input};
  const pointer = structuredClone(input.expected);
  const address = slotIO(slot);
  if (!['baseline','effective'].includes(pointer.selection) || pointer.format !== 'recipe-generation-1' || pointer.installationId !== slot.installationId || pointer.generationId !== slot.generationId || !/^[a-f0-9]{64}$/.test(pointer.rootIdentity) || !/^[a-f0-9]{64}$/.test(pointer.resolvedSha256)) throw new Error('Invalid recipe generation pointer');
  const load = async (names: string[]) => {
    const {files} = await recipeFileIO({...address, operation: 'load', expectedRoot: pointer.rootIdentity, names});
    if (!files || files.length !== names.length || files.some((file,index) => file.name !== names[index])) throw new Error('Missing staged recipe files');
    return new Map(files.map(file => [file.name, Buffer.from(file.data, 'base64')]));
  };
  const manifest = (await load(['manifest.json'])).get('manifest.json')!;
  const canonical = await verifyRichRecipeRelease(pointer.release, manifest);
  const members = canonical.referencedParts.length ? await load(canonical.referencedParts.map(part => `parts/${part.objectId}`)) : new Map<string,Buffer>();
  const selection = pointer.selection === 'effective' ? await restoreRecipeSelection((await load(['effective.json'])).get('effective.json')!, canonical.content.public, load) : undefined;
  const plan = await materialize({...slot, release: pointer.release, canonicalUTF8: manifest, readMember: async (_, part) => members.get(`parts/${part.objectId}`)!}, pointer.rootIdentity, selection);
  if (pointer.resolvedSha256 !== plan.descriptor.pointer.resolvedSha256) throw new Error('Recipe generation digest changed');
  await recipeFileIO({...address, operation: 'verify', expectedRoot: pointer.rootIdentity, entries: plan.inventory});
  return plan.descriptor;
}
export async function openRichRecipeGenerationMetadata(input: Slot & {expected: RecipeGenerationPointer}) {
  const pointer = structuredClone(input.expected);
  const address = slotIO(input);
  if (!['baseline','effective'].includes(pointer.selection) || pointer.format !== 'recipe-generation-1' || pointer.installationId !== input.installationId || pointer.generationId !== input.generationId || !/^[a-f0-9]{64}$/.test(pointer.rootIdentity) || !/^[a-f0-9]{64}$/.test(pointer.resolvedSha256)) throw new Error('Invalid recipe generation pointer');
  const load = async (names: string[]) => {
    const {files} = await recipeFileIO({...address,operation:'load',expectedRoot:pointer.rootIdentity,names});
    if (!files || files.length!==names.length || files.some((file,index)=>file.name!==names[index])) throw new Error('Missing staged recipe files');
    return new Map(files.map(file=>[file.name,Buffer.from(file.data,'base64')]));
  };
  const metadata = await load(['manifest.json','receipt.json',...(pointer.selection==='effective'?['effective.json']:[])]);
  const manifest = metadata.get('manifest.json')!;
  const baseline = await verifyRichRecipeRelease(pointer.release,manifest);
  if (!isDeepStrictEqual(JSON.parse(metadata.get('receipt.json')!.toString('utf8')),pointer)) throw new Error('Recipe generation receipt changed');
  const effective = pointer.selection==='effective' ? recipeSelectionMetadata(metadata.get('effective.json')!,baseline.content.public) : undefined;
  const content = effective?.content ?? baseline.content;
  const files = new Map<string,RecipeFileEntry>();
  for (const [name,data] of metadata) if (name!=='receipt.json') files.set(name,{name,bytes:data.length,sha256:digest(data)});
  for (const part of baseline.referencedParts) files.set(`parts/${part.objectId}`,{name:`parts/${part.objectId}`,bytes:part.bytes,sha256:part.sha256});
  for (const part of effective?.referencedParts??[]) files.set(`effective/${part.objectId}`,{name:`effective/${part.objectId}`,bytes:part.bytes,sha256:part.sha256});
  for (const [name,{bytes,sha256}] of nativeFilePlan(content,(effective ? digest(effective.canonicalUTF8) : pointer.release.contentSha256).slice(0,12))) files.set(name,{name,bytes,sha256});
  const inventory = [...files.values()].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  if (digest(JSON.stringify(['recipe-files-v1',inventory]))!==pointer.resolvedSha256) throw new Error('Recipe generation digest changed');
  return {skills:pristine(content.skills),files:pristine(content.files.map(({text:_,...file})=>file)),async readFiles(ids:readonly string[]) {
    const selected = ids.map(id=>{const file=content.files.find(file=>file.itemId===id);if(!file)throw new Error('Unknown selected recipe file');return file;});
    const prefix = effective ? 'effective/' : 'parts/';
    const names = [...new Set(selected.flatMap(file=>file.text.kind==='part'?[prefix+file.text.objectId]:[]))];
    const bodies = names.length ? await load(names) : new Map<string,Buffer>();
    return new Map(selected.map(file=>{
      if(file.text.kind==='inline')return [file.itemId,file.text.value];
      const objectId=file.text.objectId;
      const part=content.parts.find(part=>part.objectId===objectId)!;
      const bytes=bodies.get(prefix+part.objectId)!;
      if(bytes.length!==part.bytes||digest(bytes)!==part.sha256)throw new Error('Selected recipe file changed');
      return [file.itemId,verifiedDocumentText(bytes)];
    }));
  }};
}
