import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {freezeGroupJudgeReferences} from '../src/project/judge-snapshots';
import {createHostSettings} from '../src/admin/host-settings';
import {writeJudgeModels,readJudgeModels} from '../src/judge/global-models';
import {resolveJudgeModel} from '../src/judge/model';
import type {ModelInfo} from '../src/agent/types';

const homes:string[]=[];
afterEach(async()=>{await Promise.all(homes.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const model=(id:string,efforts:ModelInfo['supportedEfforts']):ModelInfo=>({id,displayName:id,description:'',isDefault:true,hidden:false,supportedEfforts:efforts,defaultEffort:efforts[0]??'low'});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'judge-snapshots-'));homes.push(root);
  const dir=join(root,'bots','cli_fixture');await mkdir(dir,{recursive:true});
  const file=join(dir,'projects.json');
  const rows=[{kind:'default'},{kind:'provider',provider:'claude-agent'}, {kind:'llm',backend:'codex-appserver',model:'explicit',effort:'high'}, {kind:'oracle',model:'future'}, undefined];
  await writeFile(file,JSON.stringify({version:1,retained:'top-level',projects:rows.map((judge,i)=>({name:`group-${i}`,chatId:`oc_${i}`,cwd:'/tmp',blank:false,createdAt:1,...(judge?{judge}:{})}))}));
  return {root,file,read:async()=>JSON.parse(await readFile(file,'utf8'))};
}
describe('legacy group decision snapshots',()=>{
  it('freezes every decision provider without catalog lookups or copying the shared endpoint',async()=>{
    const f=await fixture();const before=await f.read();
    const choices=[{kind:'default'},...(['openrouter','vercel','custom'] as const).map(provider=>({kind:'provider',provider}))];
    before.projects=choices.map((judge,i)=>({...before.projects[0],name:`decision-${i}`,chatId:`oc_decision_${i}`,judge}));
    await writeFile(f.file,JSON.stringify(before));
    await freezeGroupJudgeReferences(f.root,{defaultProvider:'custom',byProvider:{
      custom:{model:'custom-jev',endpoint:'https://decisions.example/v1/decide'},vercel:{model:'typesafe-ai/jev'},
    }},async()=>{throw new Error('decision providers have no execution catalog');});
    expect((await f.read()).projects.map((row:{judge:unknown})=>row.judge)).toEqual([
      {kind:'decision',provider:'custom',model:'custom-jev'},
      {kind:'decision',provider:'openrouter',model:'typesafe/jev-1.14'},
      {kind:'decision',provider:'vercel',model:'typesafe-ai/jev'},
      {kind:'decision',provider:'custom',model:'custom-jev'},
    ]);
  });
  it('pins the old catalog-derived model and fitted effort, preserving explicit/unknown/unset choices',async()=>{
    const f=await fixture();const before=await f.read();
    const previous={byProvider:{'claude-agent':{model:'haiku',effort:'high' as const}}};
    await freezeGroupJudgeReferences(f.root,previous,async provider=>provider==='codex-appserver'?[model('current-small',['none','low'])]:[model('haiku',['low'])]);
    const saved=await f.read();
    expect(saved.retained).toBe('top-level');
    expect(saved.projects[0].judge).toEqual({kind:'llm',backend:'codex-appserver',model:'current-small',effort:'none'});
    expect(saved.projects[1].judge).toEqual({kind:'llm',backend:'claude-agent',model:'haiku',effort:'high'});
    expect(resolveJudgeModel('claude-agent',{group:saved.projects[1].judge},[model('haiku',['low'])])).toMatchObject({model:'haiku',effort:'low'});
    expect(saved.projects.slice(2)).toEqual(before.projects.slice(2));
    await freezeGroupJudgeReferences(f.root,{defaultProvider:'typesafe',byProvider:{}},async()=>{throw new Error('must not probe pinned groups');});
    expect(await f.read()).toEqual(saved);
  });
  it('can freeze explicit profiles without probing an unavailable provider',async()=>{
    const f=await fixture();
    await freezeGroupJudgeReferences(f.root,{byProvider:{'codex-appserver':{model:'saved',effort:'low'},'claude-agent':{model:'custom',custom:true}}},async()=>{throw new Error('must not probe');});
    const saved=await f.read();
    expect(saved.projects[0].judge).toEqual({kind:'llm',backend:'codex-appserver',model:'saved',effort:'low'});
    expect(saved.projects[1].judge).toEqual({kind:'llm',backend:'claude-agent',model:'custom',custom:true});
  });
  it('validates all catalogs before writing any group and never changes host profiles when freezing fails',async()=>{
    const f=await fixture();const before=await f.read();
    const previous={byProvider:{}};await writeJudgeModels(previous,f.root);
    const host=createHostSettings({appDir:f.root,getSecret:async()=> 'fixture-key',readJudgeModelsCatalog:async provider=>{
      if(provider==='claude-agent')throw new Error('unavailable');return [model('current-small',['none'])];
    }});
    const view=await host.read({kind:'host'});if(!('runtime' in view))throw new Error('host');
    expect(await host.save({scope:{kind:'host'},section:'judge',revision:view.sections.judge.revision,patch:{defaultProvider:'typesafe'}})).toMatchObject({kind:'rejected'});
    expect(await f.read()).toEqual(before);expect(await readJudgeModels(f.root)).toEqual(previous);
  });
  it('host edits freeze old groups before saving the new default and keep their old Jev choice without a key',async()=>{
    const f=await fixture();const before=await f.read();before.projects=before.projects.slice(0,1);await writeFile(f.file,JSON.stringify(before));
    await writeJudgeModels({defaultProvider:'typesafe',byProvider:{typesafe:{model:'jev-latest'}}},f.root);
    const host=createHostSettings({appDir:f.root,getSecret:async()=>undefined});
    const view=await host.read({kind:'host'});if(!('runtime' in view))throw new Error('host');
    expect(await host.save({scope:{kind:'host'},section:'judge',revision:view.sections.judge.revision,patch:{defaultProvider:'claude-agent'}})).toMatchObject({kind:'saved'});
    expect((await f.read()).projects[0].judge).toEqual({kind:'decision',provider:'typesafe',model:'jev-latest'});
    expect((await readJudgeModels(f.root)).defaultProvider).toBe('claude-agent');
  });
});
