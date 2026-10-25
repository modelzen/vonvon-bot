import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { backendIds } from '../agent';
import type { ModelInfo } from '../agent/types';
import { discoverProviderModels } from '../admin/model-catalog';
import { SafeAppIdSchema } from '../config/bot-namespace';
import { defaultJudgeProvider, type JudgeModels, type JudgeProvider } from '../judge/global-models';
import { parseStoredJudge, resolveJudgeModel } from '../judge/model';
import type { JudgeSelectionStored } from '../judge/types';
import { listProjectsIn, withStoredRows } from './registry';

type ConcreteJudge = Extract<JudgeSelectionStored, {kind:'llm'|'decision'}>;

/**
 * Before replacing host profiles, pin the recognized legacy group references to their old effective
 * model. Existing concrete choices, absent Bot inheritance and unknown future kinds remain untouched.
 * Catalogs and every file are read before writing. Each file is rechecked under its projects lock;
 * partial progress is safe to retry: pinning the old effective value does not change current behavior.
 * Caller holds judge-models throughout, and writes the host profile only after every file succeeds.
 */
export async function freezeGroupJudgeReferences(root:string, previous:JudgeModels,
  readModels:(provider:'codex-appserver'|'claude-agent')=>Promise<ModelInfo[]> = async provider=>{
    const catalog=await discoverProviderModels(provider);
    if (!catalog.models.length) throw new Error(`无法确认 ${provider} 的决策模型，暂时不能更新默认值。`);
    return catalog.models;
  }):Promise<void> {
  const files=[join(root,'projects.json')];
  try {
    for (const dir of await readdir(join(root,'bots'),{withFileTypes:true}))
      if (dir.isDirectory()&&SafeAppIdSchema.safeParse(dir.name).success) files.push(join(root,'bots',dir.name,'projects.json'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  const providerOf=(raw:unknown):JudgeProvider|undefined=>{
    const selected=parseStoredJudge(raw,backendIds()).value;
    return selected?.kind==='default'?defaultJudgeProvider(previous):selected?.kind==='provider'?selected.provider:undefined;
  };
  const targets:Array<{file:string;providers:Set<JudgeProvider>}>=[];
  for (const file of files) {
    const providers=new Set((await listProjectsIn(file)).map(row=>providerOf(row.judge)).filter((id):id is JudgeProvider=>!!id));
    if (providers.size) targets.push({file,providers});
  }
  const snapshots=new Map<JudgeProvider,ConcreteJudge>();
  for (const provider of new Set(targets.flatMap(target=>[...target.providers]))) {
    const profile=previous.byProvider[provider];
    // Copy an explicit profile verbatim: group and profile routes apply the same effort fitting at runtime.
    // This also lets the user change defaults while an old provider is currently unavailable.
    if (profile) {
      snapshots.set(provider,provider==='typesafe'?{kind:'decision',provider,model:profile.model}
        :{kind:'llm',backend:provider,model:profile.model,...(profile.effort?{effort:profile.effort}:{}),...(profile.custom?{custom:true}:{})});
      continue;
    }
    const models=provider==='typesafe'?undefined:await readModels(provider);
    const resolved=resolveJudgeModel(provider,{group:{kind:'provider',provider}},models,undefined,root,previous);
    snapshots.set(provider,resolved.provider?{kind:'decision',provider:resolved.provider,model:resolved.model}
      :{kind:'llm',backend:provider,model:resolved.model,...(resolved.effort?{effort:resolved.effort}:{})});
  }
  for (const {file} of targets) await withStoredRows({file,dataRoot:root},async rows=>{
    let changed=false;
    for (const row of rows) {
      const provider=providerOf(row.judge);
      if (!provider) continue;
      const choice=snapshots.get(provider);
      if (!choice) throw new Error('群聊的决策模型已改变，请重新保存默认值。');
      row.judge=structuredClone(choice); changed=true;
    }
    return changed;
  });
}
