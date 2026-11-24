import {DEFAULT_SMART_RULES, decisionEndpointProblem, groupDecisionSchema, type GroupDecision} from '@vonvon/protocol';
import {createBackend} from '../agent';
import type {AgentBackend, ModelInfo} from '../agent/types';
import {resolveProjectModelAccess} from '../config/execution';
import {getSecret} from '../config/keystore';
import {decisionProvider} from '../judge/decision';
import {parseModelId} from '../agent/model-id';
import {defaultJudgeProvider, defaultProviderChoice, readJudgeModels, type JudgeProvider} from '../judge/global-models';
import {defaultJudgeModel} from '../judge/model';
import type {JudgeSelectionStored} from '../judge/types';
import {API_KEY_SHAPE} from '@vonvon/protocol';
import type {Project, SessionMode} from './registry';

type InitialSettings = Pick<Project,'modelAccess'|'profile'|'skills'|'presentation'|'smartRules'|'judge'>;
type Dependencies = {backendFor?: (id:string)=>Pick<AgentBackend,'listModels'|'peekModels'> & Partial<Pick<AgentBackend,'doctor'|'loginStatus'>>; readKey?: typeof getSecret; readJudgeModels?: typeof readJudgeModels};

type ConcreteJudge = Extract<JudgeSelectionStored, {kind:'decision'}> | (Extract<JudgeSelectionStored, {kind:'llm'}> & {backend:'codex-appserver'|'claude-agent'});

/** New decision choices require a readable, header-safe key and, for custom services, a shared endpoint. */
export async function requireDecisionKey(providerId:string, read:typeof getSecret=getSecret, readModels:typeof readJudgeModels=readJudgeModels):Promise<void> {
  const provider=decisionProvider(providerId);
  if (!provider) throw new Error('不支持这个决策模型 Provider。');
  if (providerId==='custom') {
    const problem=decisionEndpointProblem((await readModels()).byProvider.custom?.endpoint);
    if (problem) throw new Error(problem);
  }
  let key:string|undefined;
  try { key=await read(provider.keyId); }
  catch { throw new Error(`无法读取 ${provider.displayName} 的密钥，请先在设置中检查密钥。`); }
  if (!key||!API_KEY_SHAPE.test(key)) throw new Error(`请先在设置中配置 ${provider.displayName} 的密钥。`);
}

/** Resolve once: a group's stored choice never points back to mutable host profiles. */
export async function snapshotProviderJudge(providerId:JudgeProvider,deps:Dependencies={},validate=true):Promise<ConcreteJudge> {
  const stored=await (deps.readJudgeModels??readJudgeModels)();
  const override=stored.byProvider[providerId];
  if (decisionProvider(providerId)) {
    const choice=override??defaultProviderChoice(providerId);
    const model=parseModelId(choice.model);
    if (!model.ok) throw new Error(model.message);
    if (validate) await requireDecisionKey(providerId,deps.readKey,async()=>stored);
    return {kind:'decision',provider:providerId,model:model.id};
  }
  if (providerId!=='codex-appserver'&&providerId!=='claude-agent') throw new Error('不支持这个决策模型 Provider。');
  const backend=(deps.backendFor??createBackend)(providerId);
  if (validate) {
    if (backend.doctor && !(await backend.doctor({force:true})).ok) throw new Error('决策 Provider 还没装好或没配置好。');
    const login=await backend.loginStatus?.({refresh:true});
    if (!login||(login.state!=='signedIn'&&login.state!=='notRequired')) throw new Error('决策 Provider 没配置好，或者确认不了。');
  }
  // Non-smart groups still take a snapshot, but do not need a usable/authenticated judge yet.
  const listed=backend.peekModels?.()??(validate?await backend.listModels():undefined);
  const choice=override??defaultJudgeModel(providerId,listed);
  const model=parseModelId(choice.model);
  if (!model.ok) throw new Error(model.message);
  const info=listed?.find(item=>item.id===choice.model&&!item.hidden);
  if (validate&&!override?.custom&&!info) throw new Error('决策模型已不在可用列表中，请重新选择。');
  if (validate&&choice.effort&&info&&!info.supportedEfforts.includes(choice.effort)) throw new Error('决策模型不支持所选 Effort，请重新选择。');
  return {kind:'llm',backend:providerId,model:model.id,...(choice.effort?{effort:choice.effort}:{}),...(override?.custom?{custom:true}:{})};
}

export async function snapshotDefaultJudge(deps:Dependencies={},validate=true):Promise<ConcreteJudge> {
  const stored=await (deps.readJudgeModels??readJudgeModels)();
  return snapshotProviderJudge(defaultJudgeProvider(stored), {...deps, readJudgeModels:async()=>stored},validate);
}

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
  let judge:GroupDecision=groupDecisionSchema.parse(input.judge ?? {kind:'default'});
  if (judge.kind === 'default') {
    judge=await snapshotDefaultJudge(deps,input.kind === 'smart');
  } else if (judge.kind === 'provider') {
    judge=await snapshotProviderJudge(judge.provider,deps);
  } else {
    const model=parseModelId(judge.model);
    if (!model.ok) throw new Error(model.message);
    judge={...judge,model:model.id};
    if (judge.kind==='decision') {
      await requireDecisionKey(judge.provider,deps.readKey,deps.readJudgeModels);
    } else {
      const selectedModel = judge.model;
      const info=(await catalog(judge.backend)).find(item=>item.id===selectedModel && !item.hidden);
      if (!judge.custom && !info) throw new Error('决策模型已不在可用列表中，请重新选择。');
      if (judge.effort && info && !info.supportedEfforts.includes(judge.effort)) throw new Error('决策模型不支持所选 Effort，请重新选择。');
    }
  }
  return {
    modelAccess,
    skills:{disabledPaths:[]},
    presentation:{voiceEnabled:true,showToolCalls:true,showModel:'running',cardDisplay:null,completionMode:'failures',longTaskMinutes:5},
    smartRules:{...DEFAULT_SMART_RULES},
    judge:judge.kind === 'decision' ? judge : {kind:'llm',backend:judge.backend,model:judge.model,...(judge.effort ? {effort:judge.effort}:{}),...(judge.custom ? {custom:true as const}:{})},
  };
}
