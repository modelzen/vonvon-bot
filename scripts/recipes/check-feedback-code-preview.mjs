// node scripts/build-recipe-files.mjs && node scripts/recipes/check-feedback-code-preview.mjs <export directory>
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw Error('Expected: EXPORTED-RECIPE-DIRECTORY');
const preview = JSON.parse(await readFile(join(directory, 'developer-preview.json'),'utf8'));
const scratch = await realpath(await mkdtemp(join(tmpdir(),'vonvon-feedback-install-')));
const root = fileURLToPath(new URL('../../',import.meta.url));
try {
  const entry = resolve(root,'packages/daemon/src/recipe/rich-generation.ts'), compiled = join(scratch,'generation.mjs');
  await build({entryPoints:[entry],target:'node22',format:'esm',platform:'node',bundle:true,outfile:compiled,
    define:{'import.meta.url':JSON.stringify(pathToFileURL(join(root,'packages/daemon/src/recipe/rich-file-helper.ts')).href)}});
  const {stageRichRecipeGeneration,openRichRecipeGeneration} = await import(pathToFileURL(compiled).href);
  const slot = {botDataRoot:join(scratch,'bot'),installationId:randomUUID(),generationId:randomUUID()};
  await mkdir(slot.botDataRoot);
  const {pointer} = await stageRichRecipeGeneration({...slot,release:preview.release,canonicalUTF8:Buffer.from(preview.canonical,'base64url'),
    readMember:async (_release,descriptor) => Buffer.from(preview.members[descriptor.objectId],'base64url')});
  const staged = await openRichRecipeGeneration({...slot,expected:pointer});
  for (const skill of staged.content.skills) {
    const dir = join(staged.nativePackage.path,'skills','r-' + skill.itemId);
    const wrapper = await readFile(join(dir,'SKILL.md'),'utf8');
    for (const id of skill.fileIds) {
      const file = staged.content.files.find(f => f.itemId === id);
      const original = await readFile(join(directory,'skills',skill.name,file.name));
      const reference = 'references/' + createHash('sha256').update(original).digest('hex') + '.txt';
      assert.ok(wrapper.includes(reference));
      assert.deepEqual(await readFile(join(dir,reference)),original);
    }
  }
  assert.deepEqual(Buffer.from(staged.readPart(staged.content.finalLogo.objectId)),await readFile(join(directory,'logo.webp')));
  console.log('Local daemon staged and reopened: %s, %d skills, %d files, verified original logo.',preview.public.version,staged.content.skills.length,staged.content.files.length);
} finally {
  await rm(scratch,{recursive:true,force:true});
}
