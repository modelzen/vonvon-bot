import {DEFAULT_SMART_RULES, groupDecisionSchema, type GroupDecision} from '@vonvon/protocol';
import {createBackend} from '../agent';
import type {AgentBackend, ModelInfo} from '../agent/types';
import {resolveProjectModelAccess} from '../config/execution';
import {getSecret} from '../config/keystore';
import {decisionProvider} from '../judge/decision';
import {parseModelId} from '../agent/model-id';
import type {Project, SessionMode} from './registry';

type InitialSettings = Pick<Project,'modelAccess'|'profile'|'skills'|'presentation'|'smartRules'|'judge'>;
type Dependencies = {backendFor?: (id:string)=>Pick<AgentBackend,'listModels'|'peekModels'>; readKey?: typeof getSecret};

/** Prepare and validate before touching Feishu. These values are committed with the first binding row. */
export async function prepareNewGroupSettings(input:{backend:string; kind:SessionMode; judge?:GroupDecision}, deps:Dependencies = {}):Promise<InitialSettings> {
  const backendFor = deps.backendFor ?? createBackend;
  const catalogs = new Map<string,ModelInfo[]>();
  async function catalog(id:string) {
    let result = catalogs.get(id);
    if (!result) {const backend=backendFor(id); result=backend.peekModels?.() ?? await backend.listModels(); catalogs.set(id,result);}
    return result;
  }
  const models = await catalog(input.backend);
  const modelAccess = resolveProjectModelAccess({group:{backend:input.backend,cwd:''}},models);
  if (!modelAccess.models.length) throw new Error('未读取到可用模型，请先在工具与连接中检查 Provider。');
  let judge:GroupDecision|undefined;
  if (input.judge !== undefined) {
    judge=groupDecisionSchema.parse(input.judge);
    const model=parseModelId(judge.model);
    if (!model.ok) throw new Error(model.message);
    judge={...judge,model:model.id};
    if (judge.kind==='decision') {
      const provider=decisionProvider(judge.provider);
      if (!provider) throw new Error('不支持这个决策模型 Provider。');
      const key=await (deps.readKey ?? getSecret)(provider.keyId);
      if (!key?.trim() || /[\r\n]/.test(key)) throw new Error(`请先配置 ${provider.displayName} 的密钥。`);
    } else {
      const info=(await catalog(judge.backend)).find(item=>item.id===judge!.model && !item.hidden);
      if (!judge.custom && !info) throw new Error('决策模型已不在可用列表中，请重新选择。');
      if (judge.effort && info && !info.supportedEfforts.includes(judge.effort)) throw new Error('决策模型不支持所选 Effort，请重新选择。');
    }
  }
  return {
    modelAccess,
    profile:{persona:'',memory:'',inheritPersona:true,inheritMemory:true},
    skills:{disabledPaths:[]},
    presentation:{voiceEnabled:true,showToolCalls:false,showModel:'running',completionMode:'manual',longTaskMinutes:5},
    smartRules:{...DEFAULT_SMART_RULES},
    ...(judge ? {judge:judge.kind === 'decision' ? judge : {kind:'llm' as const,backend:judge.backend,model:judge.model,...(judge.effort ? {effort:judge.effort}:{}),...(judge.custom ? {custom:true as const}:{})}}:{}),
  };
}
