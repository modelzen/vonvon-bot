import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {canonicalizeRichRecipeContent, digestRichRecipeContent, type RecipeRichContent, type RecipeRichRelease} from '@vonvon/protocol';
import {readSelectedRecipeFiles} from '../src/recipe/rich-source-files';
import {openRichRecipeGeneration, stageRichRecipeGeneration} from '../src/recipe/rich-generation';

let scratch: string;
beforeEach(async () => {scratch = await realpath(await mkdtemp(join(tmpdir(), 'recipe-files-')));});
afterEach(async () => {await rm(scratch, {recursive: true, force: true});});
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const identity = () => ({itemId: randomUUID(), originId: randomUUID()});
async function put(file: string, data: Buffer | string) {await mkdir(dirname(file), {recursive: true}); await writeFile(file, data);}

it('reads only selected UTF-8 bytes under the approved hidden Bot root, then verifies the reviewed snapshot', async () => {
  const root = join(scratch, '.vonvon-bot', 'library');
  const name = '资料/é.txt';
  const original = '\ufeff你好 👩‍💻\r\n';
  await put(join(root, name), original);
  await put(join(root, 'private.txt'), 'unselected sentinel');
  const preview = await readSelectedRecipeFiles(root, [name]);
  expect(preview.files).toHaveLength(1);
  expect(preview.files[0]).toMatchObject({name, text: original, sha256: digest(original), bytes: Buffer.byteLength(original)});
  await expect(readSelectedRecipeFiles(root, [name], preview)).resolves.toEqual(preview);
  await writeFile(join(root, name), 'changed');
  await expect(readSelectedRecipeFiles(root, [name], preview)).rejects.toThrow();
  await rename(root, root + '-old');
  await put(join(root, name), original);
  await expect(readSelectedRecipeFiles(root, [name], preview)).rejects.toThrow();
});

it('rejects unsafe source names, file types, code points, aliases and excessive selected bytes', async () => {
  const root = join(scratch, 'approved');
  for (const name of ['a.md','b.txt','x.rst']) await put(join(root, name), 'safe');
  await put(join(root, 'bad.txt'), Buffer.from([0xe4,0xb8]));
  await put(join(root, 'nul.txt'), 'x\0y');
  await put(join(root, 'large.md'), Buffer.alloc(128*1024+1, 65));
  await link(join(root, 'b.txt'), join(scratch, 'elsewhere.txt'));
  for (const names of [['../a.md'],['x:alt.txt'],['.ssh/id.txt'],['COM¹ .md'],['a.sh'],['b.txt'],['large.md'],['bad.txt'],['nul.txt'],['x.rst','X.rst'],['a.md','a.md/x.txt'],['é.txt','é.txt'],[...Array(65)].map((_,i) => `${i}.md`)]) {
    await expect(readSelectedRecipeFiles(root, names)).rejects.toThrow();
  }
  if (process.platform === 'win32') {
    await writeFile(join(root, 'x.rst:secondary'), 'hidden stream');
    await expect(readSelectedRecipeFiles(root, ['x.rst'])).rejects.toThrow();
    await symlink(root, join(scratch, 'junction'), 'junction');
    await expect(readSelectedRecipeFiles(join(scratch, 'junction'), ['a.md'])).rejects.toThrow();
  } else {
    await symlink(root, join(scratch, 'redirect'));
    await symlink(join(root, 'a.md'), join(root, 'alias.md'));
    await expect(readSelectedRecipeFiles(join(scratch, 'redirect'), ['a.md'])).rejects.toThrow();
    await expect(readSelectedRecipeFiles(root, ['alias.md'])).rejects.toThrow();
    await symlink(scratch, join(root, 'linked'));
    await expect(readSelectedRecipeFiles(root, ['linked/approved/a.md'])).rejects.toThrow();
    execFileSync('mkfifo', [join(root, 'pipe.txt')]);
    await expect(readSelectedRecipeFiles(root, ['pipe.txt'])).rejects.toThrow();
  }
  const names = Array.from({length:9}, (_,i) => `${i}.txt`);
  for (const name of names) await put(join(root, name), Buffer.alloc(128*1024, 120));
  expect((await readSelectedRecipeFiles(root, names.slice(0,8))).files.length).toBe(8);
  await expect(readSelectedRecipeFiles(root, names)).rejects.toThrow();
});

function makeContent() {
  const doc = { ...identity(), name: 'SKILL.md', use: 'skillDescription' as const, text: {kind: 'inline' as const, value: '---\nhooks: [author-hook]\nallowed-tools: [author-tool]\n---\n用参考资料。'}};
  const bytes = Buffer.from('本技能的答案 👩‍💻');
  const part = {objectId: randomUUID(), kind: 'text' as const, bytes: bytes.length, sha256: digest(bytes), mediaType: 'text/plain;charset=utf-8' as const};
  const ref = {...identity(), name: '资料/引用.rst', use: 'reference' as const, text: {kind: 'part' as const, objectId: part.objectId}};
  const skill = {...identity(), name: '答疑\n---\nhooks: [author-hook]', entryFileId: doc.itemId, fileIds: [doc.itemId, ref.itemId]};
  const value = (v: string) => ({...identity(), value: v});
  const content: RecipeRichContent = {format:'rich-v2', schemaVersion:2, public: {name:value('助手'), summary:value('简介'), overview:value('说明'),version:value('1')}, settings:[],rules:[],tasks:[],setup:[],memories:[{...identity(), text:ref.text}],files:[doc,ref],skills:[skill],parts:[part]};
  return {content, bytes, doc, ref, part, skill};
}
async function envelope(content: RecipeRichContent) {
  const canonical = canonicalizeRichRecipeContent(content);
  const release: RecipeRichRelease = {format: 'rich-v2',recipeId:randomUUID(),versionId:randomUUID(),authorId:randomUUID(),revision:1,access:'coded',contentSha256:await digestRichRecipeContent(canonical),logicalBytes:canonical.logicalBytes};
  return {release, canonicalUTF8:canonical.canonicalUTF8};
}
async function fixture() {
  const data = makeContent();
  const slot = {botDataRoot: join(scratch, '.vonvon-bot', 'a'), installationId: randomUUID(), generationId: randomUUID()};
  await mkdir(slot.botDataRoot, {recursive:true});
  const route = await envelope(data.content);
  const readMember = vi.fn(async () => data.bytes);
  const input = {...slot,...route,readMember};
  return {...data,slot,input,readMember};
}
it('stages a closed native package, preserves exact baseline and verifies restart in its original Bot slot', async () => {
  const x = await fixture();
  const a = await stageRichRecipeGeneration(x.input);
  expect(x.readMember).toHaveBeenCalledTimes(1);
  expect(a.pointer.resolvedSha256).not.toEqual(a.pointer.release.contentSha256);
  expect(a.content).toEqual(x.content);
  expect(Object.isFrozen(a.content.skills)).toBe(true);
  const copy = a.readPart(x.part.objectId); copy.fill(0);
  expect(Buffer.from(a.readPart(x.part.objectId))).toEqual(x.bytes);
  const root = a.nativePackage!.path;
  const dir = join(root,'skills',`r-${x.skill.itemId}`);
  const wrapper = await readFile(join(dir,'SKILL.md'),'utf8');
  expect(wrapper).not.toMatch(/^hooks:|^allowed-tools:/m);
  expect(JSON.parse(await readFile(join(root,'.claude-plugin/plugin.json'),'utf8'))).toEqual({name:'vonvon-recipe',version:x.input.release.contentSha256.slice(0,12)});
  const refs = wrapper.match(/references\/[a-f0-9]{64}\.txt/g)!;
  expect(await Promise.all(refs.map(file => readFile(join(dir,file),'utf8')))).toEqual([x.doc.text.value,x.bytes.toString()]);
  expect(await readdir(dir)).toEqual(['SKILL.md','references']);
  if (process.platform !== 'win32') expect((await stat(join(dir,'SKILL.md'))).mode & 0o333).toBe(0);
  const restored = await openRichRecipeGeneration({...x.slot,expected:a.pointer});
  expect(restored.pointer).toEqual(a.pointer);
  expect(restored.resolveText(x.ref.text)).toBe(x.bytes.toString());
  const botB=join(scratch,'.vonvon-bot','b');await mkdir(botB);
  const b=await stageRichRecipeGeneration({...x.input,botDataRoot:botB});
  expect(b.nativePackage!.path).not.toBe(root);
  await expect(openRichRecipeGeneration({...x.slot,botDataRoot:botB,expected:a.pointer})).rejects.toThrow();
  await expect(openRichRecipeGeneration({...x.slot,generationId:randomUUID(),expected:a.pointer})).rejects.toThrow();
  await put(join(root,'hooks','hooks.json'),'{}');
  await expect(openRichRecipeGeneration({...x.slot,expected:a.pointer})).rejects.toThrow();
  await expect(stageRichRecipeGeneration(x.input)).rejects.toThrow();
});

it('converges concurrent retries and never adopts a partial or conflicting generation', async () => {
  const x = await fixture();
  const slot = join(x.slot.botDataRoot,'recipe-generations',x.slot.installationId);
  await put(join(slot,'.staging-interrupted','manifest.json'),'partial');
  const [a,b] = await Promise.all([stageRichRecipeGeneration(x.input),stageRichRecipeGeneration(x.input)]);
  expect(a.pointer).toEqual(b.pointer);
  expect((await readdir(slot)).sort()).toEqual(['.staging-interrupted',x.slot.generationId].sort());
  await expect(stageRichRecipeGeneration({...x.input, release:{...x.input.release,versionId:randomUUID()}})).rejects.toThrow();
  const leaf = join(slot,x.slot.generationId,'parts',x.part.objectId);
  await chmod(leaf,0o600);await writeFile(leaf,Buffer.alloc(x.bytes.length,120));await chmod(leaf,0o400);
  await expect(openRichRecipeGeneration({...x.slot,expected:a.pointer})).rejects.toThrow();
  const another = randomUUID();await mkdir(join(slot,another));
  await expect(stageRichRecipeGeneration({...x.input,generationId:another})).rejects.toThrow();
  expect(await readdir(join(slot,another))).toEqual([]);
});

it('rejects mismatched release, member digest, length, kind, malformed UTF-8 and incomplete references before staging', async () => {
  const x=await fixture();
  await expect(stageRichRecipeGeneration({...x.input,release:{...x.input.release,contentSha256:'0'.repeat(64)}})).rejects.toThrow();
  await expect(stageRichRecipeGeneration({...x.input,readMember:async()=>Buffer.alloc(x.bytes.length)})).rejects.toThrow();
  await expect(stageRichRecipeGeneration({...x.input,readMember:async()=>Buffer.alloc(0)})).rejects.toThrow();
  for (const bad of [Buffer.from([0xff]),Buffer.from('a\0b')]) {
    x.part.bytes=bad.length;x.part.sha256=digest(bad);
    await expect(stageRichRecipeGeneration({...x.input,...await envelope(x.content),readMember:async()=>bad})).rejects.toThrow();
  }
  const wrong=structuredClone(x.content);wrong.parts=[{...x.part,kind:'finalLogo',mediaType:'image/webp'}];
  const missing=structuredClone(x.content);missing.skills[0]!.fileIds=[x.doc.itemId];
  for (const bad of [wrong,missing]) await expect(stageRichRecipeGeneration({...x.input,canonicalUTF8:JSON.stringify(bad)})).rejects.toThrow();
  expect(await readdir(x.slot.botDataRoot)).toEqual([]);
});

it('bounds shared member materialization even when all 64 files share one object in sixteen skills', async () => {
  const x=await fixture();
  const bytes=Buffer.alloc(128*1024,120);
  Object.assign(x.part,{bytes:bytes.length,sha256:digest(bytes)});
  x.content.files=Array.from({length:64},(_,i)=>({...identity(),use:i===0?'skillDescription':'reference',name:i===0?'SKILL.md':`refs/${i}.txt`,text:x.ref.text}));
  x.content.skills=Array.from({length:16},()=>({...identity(),name:'大纲',entryFileId:x.content.files[0]!.itemId,fileIds:x.content.files.map(f=>f.itemId)}));
  x.content.memories=[];
  const reader=vi.fn(async()=>bytes);
  const staged=await stageRichRecipeGeneration({...x.input,...await envelope(x.content),readMember:reader});
  expect(reader).toHaveBeenCalledTimes(1);
  for (const skill of x.content.skills) expect(await readdir(join(staged.nativePackage!.path,'skills',`r-${skill.itemId}`,'references'))).toEqual([`${digest(bytes)}.txt`]);
});

it('stages only resolved skill and file choices and retains a separately verified upstream baseline after restart', async()=>{
  const x=await fixture();
  const prior=await stageRichRecipeGeneration(x.input);
  const file={...x.doc, text:{kind:'inline' as const,value:'local retained entry'}};
  const chosen={...x.skill, name:'local name', fileIds:[x.doc.itemId]};
  const generationId=randomUUID();
  const merged=await stageRichRecipeGeneration({...x.input,generationId,effectiveSkills:{skills:[chosen],files:[file]}});
  expect(merged.pointer.release.contentSha256).toBe(prior.pointer.release.contentSha256);
  expect(merged.pointer.resolvedSha256).not.toBe(prior.pointer.resolvedSha256);
  expect(merged.content.files).toEqual(prior.content.files);
  expect(merged.nativePackage!.skills[0]).toEqual({itemId:chosen.itemId,name:`r-${chosen.itemId}`,qualifiedName:`vonvon-recipe:r-${chosen.itemId}`});
  const restored=await openRichRecipeGeneration({...x.slot,generationId,expected:merged.pointer});
  expect(restored.nativePackage).toEqual(merged.nativePackage);
  expect(await readdir(join(restored.nativePackage!.path,'skills',`r-${chosen.itemId}`,'references'))).toEqual([`${digest(file.text.value)}.txt`]);
  const omitted=await stageRichRecipeGeneration({...x.input,generationId:randomUUID(),effectiveSkills:{skills:[],files:[]}});
  expect(omitted.nativePackage).toBeUndefined();
  await expect(stageRichRecipeGeneration({...x.input,generationId:randomUUID(),effectiveSkills:{skills:[],files:[file]}})).rejects.toThrow();
});
