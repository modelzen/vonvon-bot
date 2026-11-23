import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {canonicalizeRichRecipeContent,digestRichRecipeContent} from '@vonvon/protocol';
import {nativeRichInventory} from '../src/recipe/authoring-rich-inventory';
import {stageRichRecipeGeneration,openRichRecipeGeneration} from '../src/recipe/rich-generation';

it('exports and installs a workspace skill named setup through the ordinary skill package',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'vonvon-setup-skill-')));
  try{
    const cwd=join(root,'workspace'),folder=join(cwd,'.agents','skills','setup'),botDataRoot=join(root,'bot');
    await mkdir(folder,{recursive:true});await mkdir(botDataRoot);
    const description='# setup\n按创作者在配方介绍中说明的时机，由用户主动运行。';
    await writeFile(join(folder,'SKILL.md'),description);
    const inventory=await nativeRichInventory({seed:'setup-skill',row:{name:'测试群',chatId:'oc_setup',cwd,bindingIncarnation:randomUUID()} as Parameters<typeof nativeRichInventory>[0]['row'],
      botRoot:botDataRoot,botId:'cli_setup',skills:[{skill:'setup',files:['SKILL.md']}],includeBotMemories:false});
    expect(inventory.content.setup).toEqual([]);
    expect(inventory.content.skills).toHaveLength(1);
    expect(inventory.content.skills[0]!.name).toBe('setup');
    expect(inventory.content.files[0]!.text).toEqual({kind:'inline',value:description});
    for(const field of ['name','summary','overview','version'] as const)inventory.content.public[field].value=field==='version'?'1':'setup 技能';
    const canonical=canonicalizeRichRecipeContent(inventory.content),slot={botDataRoot,installationId:randomUUID(),generationId:randomUUID()};
    const installed=await stageRichRecipeGeneration({...slot,canonicalUTF8:canonical.canonicalUTF8,release:{format:'rich-v2',recipeId:randomUUID(),versionId:randomUUID(),authorId:randomUUID(),revision:1,
      access:'direct',contentSha256:await digestRichRecipeContent(canonical),logicalBytes:canonical.logicalBytes},readMember:async()=>{throw new Error('ordinary inline skill needs no remote data');}});
    const restored=await openRichRecipeGeneration({...slot,expected:installed.pointer});
    expect(restored.content.skills).toEqual(inventory.content.skills);
    expect(restored.content.setup).toEqual([]);
    expect(restored.resolveText(restored.content.files[0]!.text)).toBe(description);
  }finally{await rm(root,{recursive:true,force:true});}
});
